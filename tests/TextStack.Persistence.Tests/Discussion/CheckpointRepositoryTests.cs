using Application.Common;
using Application.Discussion;
using Dapper;
using Domain.Discussion;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

public class CheckpointRepositoryTests(PostgresFixture db)
{
    private readonly CheckpointRepository _repo = new(db.DataSource);
    private readonly SharedChapterRepository _shares = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<IReadOnlyList<DiscussionCheckpoint>> AllAsync(Book book) =>
        (await _repo.ListAsync(book.UserId, book.Id, null, 100, null, Ct)).Items;

    private static (WriteOutcome, DiscussionCheckpoint?) Mismatch => (WriteOutcome.ShareMismatch, null);

    [Fact]
    public async Task AppendAsync_ReaderSavesStagesOfADiscussion_KeepsEachInOrderAndRefusesAnEmptyOne()
    {
        var book = await db.NewReaderWithBookAsync();
        var bookLevel = NewCheckpoint(book);
        bookLevel.OpenQuestions = """["Who lit the lamp?"]""";
        var first = NewCheckpoint(book);
        var second = NewCheckpoint(book);
        first.ChapterKey = second.ChapterKey = "ch-1";

        var result = await _repo.AppendAsync(bookLevel, Ct);
        await _repo.AppendAsync(first, Ct);
        await _repo.AppendAsync(second, Ct);
        // Pinned times: the order never rests on two appends landing in the same microsecond.
        foreach (var (id, minutes) in new[] { (bookLevel.Id, 3), (first.Id, 2), (second.Id, 1) })
            await db.ExecAsync("UPDATE discussion_checkpoints SET created_at = now() - make_interval(mins => @minutes) WHERE id = @id", new { id, minutes });

        Assert.Equal((WriteOutcome.Created, bookLevel.Id), (result.Outcome, result.Row!.Id));
        var all = await AllAsync(book);
        Assert.Equal([bookLevel.Id, first.Id, second.Id], all.Select(c => c.Id));
        var read = all[0];
        Assert.Equal(("Why the night is dark", "en", (string?)null, (Guid?)null, bookLevel.OperationId),
            (read.Topic, read.Language, read.ChapterKey, read.FileId, read.OperationId));
        Assert.Equal(("""["It is a mood, not the weather."]""", "[]", "[]", """["Who lit the lamp?"]"""),
            (read.ReaderThoughts, read.AssistantSuggestions, read.Conclusions, read.OpenQuestions));

        // A checkpoint with all four sections empty says nothing: the schema refuses it.
        var empty = NewCheckpoint(book);
        empty.ReaderThoughts = "[]";
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AppendAsync(empty, Ct));
        Assert.Equal(("23514", "ck_discussion_checkpoints_not_empty"), (error.SqlState, error.ConstraintName));
        Assert.Equal(3L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_RetriedOperation_ReplaysTheSamePayloadConflictsOnAnotherEvenAfterItsShareIsGone()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        await _repo.AppendAsync(checkpoint, Ct);
        var retry = NewCheckpoint(book, share);
        (retry.OperationId, retry.PayloadSha256) = (checkpoint.OperationId, checkpoint.PayloadSha256);
        var changed = NewCheckpoint(book, share);
        changed.OperationId = checkpoint.OperationId;

        var replayed = await _repo.AppendAsync(retry, Ct);
        var conflict = await _repo.AppendAsync(changed, Ct);

        Assert.Equal((WriteOutcome.Replayed, checkpoint.Id), (replayed.Outcome, replayed.Row!.Id));
        Assert.Equal((WriteOutcome.OperationConflict, checkpoint.Id), (conflict.Outcome, conflict.Row!.Id));

        // The share deleted since: the insert no longer matches, yet the retry is answered from the stored row.
        await _shares.DeleteAsync(book.UserId, share.Id, Ct);
        var afterDelete = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.Replayed, checkpoint.Id), (afterDelete.Outcome, afterDelete.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_EightRetriesAtOnce_OneCreatedTheRestReplayedOneRow()
    {
        var book = await db.NewReaderWithBookAsync();
        var first = NewCheckpoint(book);

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
        {
            var retry = NewCheckpoint(book);
            (retry.OperationId, retry.PayloadSha256) = (first.OperationId, first.PayloadSha256);
            return _repo.AppendAsync(retry, Ct);
        }));

        Assert.Equal(1, results.Count(r => r.Outcome == WriteOutcome.Created));
        Assert.Equal(7, results.Count(r => r.Outcome == WriteOutcome.Replayed));
        Assert.Equal(1L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_NamingAShare_LinksOnlyItsOwnBookChapterAndFile()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = await db.NewBookAsync(book.UserId, "Another book");
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);

        var linked = await _repo.AppendAsync(NewCheckpoint(book, share), Ct);
        Assert.Equal((WriteOutcome.Created, (Guid?)share.Id), (linked.Outcome, linked.Row!.SharedChapterId));

        // #1316: an assistant names the share, not a file version: the checkpoint takes the share's file.
        var noFile = NewCheckpoint(book, share);
        noFile.FileId = null;
        var inherited = await _repo.AppendAsync(noFile, Ct);
        Assert.NotNull(share.FileId);
        Assert.Equal((WriteOutcome.Created, (Guid?)share.Id, share.FileId), (inherited.Outcome, inherited.Row!.SharedChapterId, inherited.Row.FileId));

        var otherChapter = NewCheckpoint(book, share);
        otherChapter.ChapterKey = "ch-2";
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(otherChapter, Ct)));

        // A share with no file, a checkpoint with none: same user and chapter, only the book differs.
        // Without the book guard the insert would pass and the deferred share FK refuse it at commit, a 500.
        var fileless = NewShare(book);
        (fileless.ChapterKey, fileless.FileId) = ("ch-3", null);
        await _shares.ShareAsync(fileless, Ct);
        var otherBook = NewCheckpoint(other, fileless);
        Assert.Null(otherBook.FileId);
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(otherBook, Ct)));

        var otherVersion = NewCheckpoint(book, share);
        otherVersion.FileId = (await db.ReplaceFileAsync(book)).Current!.Id;
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(otherVersion, Ct)));

        Assert.Equal((2L, 0L), (await db.CountAsync("discussion_checkpoints", book.UserId, book.Id), await db.CountAsync("discussion_checkpoints", book.UserId, other.Id)));
    }

    [Fact]
    public async Task AppendAsync_WhileItsShareIsBeingDeleted_WaitsThenIsAShareMismatch()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        // A share delete caught mid-transaction, the one statement DeleteAsync runs; its row lock is
        // what the append's FOR KEY SHARE waits on. Without that FOR KEY SHARE the insert does not
        // wait, and fails on the checkpoint FK at commit.
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var delete = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "DELETE FROM shared_chapters WHERE user_id = @UserId AND id = @Id", share, delete, cancellationToken: Ct));

        var append = _repo.AppendAsync(checkpoint, Ct);
        await db.WaitUntilBlockedByAsync(conn, append);
        await delete.CommitAsync(Ct);

        Assert.Equal(Mismatch, ToPair(await append));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task ListAsync_ReaderPagesThroughABooksDiscussion_ChronologicalPagesUntilNoCursor()
    {
        var book = await db.NewReaderWithBookAsync();
        var appended = new List<Guid>();
        for (var i = 0; i < 5; i++)
        {
            var checkpoint = NewCheckpoint(book);
            if (i == 0) checkpoint.ChapterKey = "ch-1";
            await _repo.AppendAsync(checkpoint, Ct);
            appended.Add(checkpoint.Id);
        }

        var pages = new List<IReadOnlyList<Guid>>();
        CheckpointPage? page = null;
        do
        {
            page = await _repo.ListAsync(book.UserId, book.Id, null, 2, page?.Next, Ct);
            pages.Add(page.Items.Select(c => c.Id).ToList());
        } while (page.Next is not null);

        Assert.Equal([2, 2, 1], pages.Select(p => p.Count));
        Assert.Equal(appended, pages.SelectMany(p => p));

        var chapter = await _repo.ListAsync(book.UserId, book.Id, "ch-1", 10, null, Ct);
        Assert.Equal((appended[0], (CheckpointCursor?)null), (Assert.Single(chapter.Items).Id, chapter.Next));

        var everything = await _repo.ListAsync(book.UserId, book.Id, null, int.MaxValue, null, Ct);
        Assert.Equal(appended, everything.Items.Select(c => c.Id));
        Assert.Null(everything.Next);

        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            _repo.ListAsync(book.UserId, book.Id, null, 0, null, Ct));
    }

    [Fact]
    public async Task DeleteAsync_OwnCheckpoint_RemovesOnlyItOnce()
    {
        var book = await db.NewReaderWithBookAsync();
        var gone = NewCheckpoint(book);
        var kept = NewCheckpoint(book);
        await _repo.AppendAsync(gone, Ct);
        await _repo.AppendAsync(kept, Ct);

        Assert.True(await _repo.DeleteAsync(book.UserId, gone.Id, Ct));

        Assert.Equal(kept.Id, Assert.Single(await AllAsync(book)).Id);
        Assert.False(await _repo.DeleteAsync(book.UserId, gone.Id, Ct));
    }

    [Fact]
    public async Task EveryMethod_BobHoldingAlicesIds_NeverReadsChangesOrDeletesHerRows()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        var eves = await db.NewReaderWithBookAsync();
        var share = NewShare(alices);
        await _shares.ShareAsync(share, Ct);
        var hers = NewCheckpoint(alices);
        await _repo.AppendAsync(hers, Ct);

        // Her operation id and hash with a share that does not match: a mismatch, not her row replayed.
        // Another intruder, so no row of his own under that operation id can answer instead.
        var replayOfHers = NewCheckpoint(eves);
        (replayOfHers.OperationId, replayOfHers.PayloadSha256, replayOfHers.ChapterKey, replayOfHers.SharedChapterId) =
            (hers.OperationId, hers.PayloadSha256, "ch-1", Guid.NewGuid());
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(replayOfHers, Ct)));

        // Her operation id is his own new operation.
        var his = NewCheckpoint(bobs);
        his.OperationId = hers.OperationId;
        var created = await _repo.AppendAsync(his, Ct);
        Assert.Equal((WriteOutcome.Created, his.Id), (created.Outcome, created.Row!.Id));

        // Her book and her share, under his user id.
        var onHerBook = NewCheckpoint(alices, share);
        onHerBook.UserId = bobs.UserId;
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(onHerBook, Ct)));

        // His book naming her share, no file to compare.
        var withHerShare = NewCheckpoint(bobs, share);
        withHerShare.FileId = null;
        Assert.Equal(Mismatch, ToPair(await _repo.AppendAsync(withHerShare, Ct)));

        Assert.Empty((await _repo.ListAsync(bobs.UserId, alices.Id, null, 10, null, Ct)).Items);
        Assert.False(await _repo.DeleteAsync(bobs.UserId, hers.Id, Ct));

        Assert.Equal(hers.Id, Assert.Single(await AllAsync(alices)).Id);
        Assert.Equal(his.Id, Assert.Single(await AllAsync(bobs)).Id);
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", bobs.UserId, alices.Id));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", eves.UserId));
    }

    private static (WriteOutcome, DiscussionCheckpoint?) ToPair(WriteResult<DiscussionCheckpoint> result) => (result.Outcome, result.Row);
}
