using Application.Common;
using Application.Discussion;
using Dapper;
using Domain.Discussion;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

public class CheckpointRepositoryTests(V2PostgresFixture db)
{
    private readonly CheckpointRepository _repo = new(db.DataSource);
    private readonly SharedChapterRepository _shares = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<IReadOnlyList<DiscussionCheckpoint>> AllAsync(Book book) =>
        (await _repo.ListAsync(book.UserId, book.Id, null, 100, null, Ct)).Items;

    [Fact]
    public async Task AppendAsync_NewOperation_StoresTheCheckpoint()
    {
        var book = await db.NewReaderWithBookAsync();
        var checkpoint = NewCheckpoint(book);
        checkpoint.OpenQuestions = """["Who lit the lamp?"]""";

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.Created, checkpoint.Id), (result.Outcome, result.Row!.Id));
        var read = Assert.Single(await AllAsync(book));
        Assert.Equal(("Why the night is dark", "en", (string?)null, checkpoint.OperationId),
            (read.Topic, read.Language, read.ChapterKey, read.OperationId));
        Assert.Equal(("""["It is a mood, not the weather."]""", "[]", "[]", """["Who lit the lamp?"]"""),
            (read.ReaderThoughts, read.AssistantSuggestions, read.Conclusions, read.OpenQuestions));
    }

    [Fact]
    public async Task AppendAsync_TwoStagesOfOneChapter_KeepsBoth()
    {
        var book = await db.NewReaderWithBookAsync();
        var first = NewCheckpoint(book);
        var second = NewCheckpoint(book);
        first.ChapterKey = second.ChapterKey = "ch-1";

        await _repo.AppendAsync(first, Ct);
        await _repo.AppendAsync(second, Ct);

        Assert.Equal([first.Id, second.Id], (await AllAsync(book)).Select(c => c.Id));
    }

    [Fact]
    public async Task AppendAsync_SameOperationAndPayloadHash_ReplaysTheStoredRowWithoutASecond()
    {
        var book = await db.NewReaderWithBookAsync();
        var checkpoint = NewCheckpoint(book);
        await _repo.AppendAsync(checkpoint, Ct);
        var retry = NewCheckpoint(book);
        (retry.OperationId, retry.PayloadSha256) = (checkpoint.OperationId, checkpoint.PayloadSha256);

        var result = await _repo.AppendAsync(retry, Ct);

        Assert.Equal((WriteOutcome.Replayed, checkpoint.Id), (result.Outcome, result.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_SameOperationOtherPayloadHash_ConflictsAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var checkpoint = NewCheckpoint(book);
        await _repo.AppendAsync(checkpoint, Ct);
        var changed = NewCheckpoint(book);
        changed.OperationId = checkpoint.OperationId;

        var result = await _repo.AppendAsync(changed, Ct);

        Assert.Equal((WriteOutcome.OperationConflict, checkpoint.Id), (result.Outcome, result.Row!.Id));
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
    public async Task AppendAsync_AllSectionsEmpty_IsRefusedBySchema()
    {
        var book = await db.NewReaderWithBookAsync();
        var checkpoint = NewCheckpoint(book);
        checkpoint.ReaderThoughts = "[]";

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AppendAsync(checkpoint, Ct));

        Assert.Equal(("23514", "ck_discussion_checkpoints_not_empty"), (error.SqlState, error.ConstraintName));
    }

    [Fact]
    public async Task AppendAsync_ShareOfTheSameChapterAndFile_StoresTheLink()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.Created, (Guid?)share.Id), (result.Outcome, result.Row!.SharedChapterId));
    }

    [Fact]
    public async Task AppendAsync_ShareOfAnotherChapter_IsAShareMismatchAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        checkpoint.ChapterKey = "ch-2";

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.ShareMismatch, null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_ShareOfAnotherFileVersion_IsAShareMismatchAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        var replaced = await new LibraryRepository(db.DataSource)
            .ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), Ct);
        checkpoint.FileId = replaced!.Current.Id;

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.ShareMismatch, null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task AppendAsync_RetryAfterItsShareWasDeleted_ReplaysTheStoredRow()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        await _repo.AppendAsync(checkpoint, Ct);
        await _shares.DeleteAsync(book.UserId, share.Id, Ct);

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.Replayed, checkpoint.Id), (result.Outcome, result.Row!.Id));
    }

    [Fact]
    public async Task AppendAsync_WhileItsShareIsBeingDeleted_WaitsThenIsAShareMismatch()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        // A share delete caught mid-transaction, its statements as DeleteAsync runs them. Without the
        // append's FOR KEY SHARE the insert does not wait, and fails on the checkpoint FK at commit.
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var delete = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            SELECT 1 FROM shared_chapters WHERE user_id = @UserId AND id = @Id FOR UPDATE;
            UPDATE discussion_checkpoints SET shared_chapter_id = NULL WHERE user_id = @UserId AND shared_chapter_id = @Id;
            DELETE FROM shared_chapters WHERE user_id = @UserId AND id = @Id;
            """, share, delete, cancellationToken: Ct));

        var append = _repo.AppendAsync(checkpoint, Ct);
        await db.WaitUntilBlockedByAsync(conn, append);
        await delete.CommitAsync(Ct);

        var result = await append;
        Assert.Equal((WriteOutcome.ShareMismatch, null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", book.UserId, book.Id));
    }

    [Fact]
    public async Task ListAsync_MoreThanAPage_ReturnsChronologicalPagesUntilNoCursor()
    {
        var book = await db.NewReaderWithBookAsync();
        var appended = new List<Guid>();
        for (var i = 0; i < 5; i++)
        {
            var checkpoint = NewCheckpoint(book);
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
    }

    [Fact]
    public async Task ListAsync_ChapterKey_ReturnsThatChapterOnly()
    {
        var book = await db.NewReaderWithBookAsync();
        var inChapter = NewCheckpoint(book);
        inChapter.ChapterKey = "ch-1";
        await _repo.AppendAsync(inChapter, Ct);
        await _repo.AppendAsync(NewCheckpoint(book), Ct);

        var page = await _repo.ListAsync(book.UserId, book.Id, "ch-1", 10, null, Ct);

        Assert.Equal(inChapter.Id, Assert.Single(page.Items).Id);
        Assert.Null(page.Next);
    }

    [Fact]
    public async Task ListAsync_LargestLimit_ReturnsEverythingWithNoMore()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.AppendAsync(NewCheckpoint(book), Ct);

        var page = await _repo.ListAsync(book.UserId, book.Id, null, int.MaxValue, null, Ct);

        Assert.Single(page.Items);
        Assert.Null(page.Next);
    }

    [Fact]
    public async Task ListAsync_LimitBelowOne_Throws()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() =>
            _repo.ListAsync(Guid.NewGuid(), Guid.NewGuid(), null, 0, null, Ct));
    }

    [Fact]
    public async Task DeleteAsync_OwnCheckpoint_RemovesOnlyIt()
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

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task AppendAsync_AlicesOperationIdAsBob_CreatesBobsOwnRow()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        var hers = NewCheckpoint(alices);
        await _repo.AppendAsync(hers, Ct);
        var his = NewCheckpoint(bobs);
        his.OperationId = hers.OperationId;

        var result = await _repo.AppendAsync(his, Ct);

        Assert.Equal((WriteOutcome.Created, his.Id), (result.Outcome, result.Row!.Id));
        Assert.Equal(hers.Id, Assert.Single(await AllAsync(alices)).Id);
    }

    [Fact]
    public async Task AppendAsync_AlicesOperationIdAsBobWithAMismatchedShare_IsAShareMismatchNotHerRow()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        var hers = NewCheckpoint(alices);
        await _repo.AppendAsync(hers, Ct);
        var his = NewCheckpoint(bobs);
        (his.OperationId, his.PayloadSha256, his.ChapterKey, his.SharedChapterId) =
            (hers.OperationId, hers.PayloadSha256, "ch-1", Guid.NewGuid());

        var result = await _repo.AppendAsync(his, Ct);

        Assert.Equal((WriteOutcome.ShareMismatch, null), (result.Outcome, result.Row));
    }

    [Fact]
    public async Task AppendAsync_AlicesBookAndShareAsBob_IsAShareMismatch()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var share = NewShare(alices);
        await _shares.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(alices, share);
        checkpoint.UserId = bob;

        var result = await _repo.AppendAsync(checkpoint, Ct);

        Assert.Equal((WriteOutcome.ShareMismatch, null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("discussion_checkpoints", alices.UserId, alices.Id));
    }

    [Fact]
    public async Task ListAsync_AlicesBookAsBob_ReturnsNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.AppendAsync(NewCheckpoint(alices), Ct);

        var page = await _repo.ListAsync(bob, alices.Id, null, 10, null, Ct);

        Assert.Empty(page.Items);
    }

    [Fact]
    public async Task DeleteAsync_AlicesCheckpointAsBob_ReturnsFalseAndKeepsIt()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var hers = NewCheckpoint(alices);
        await _repo.AppendAsync(hers, Ct);

        Assert.False(await _repo.DeleteAsync(bob, hers.Id, Ct));
        Assert.Equal(hers.Id, Assert.Single(await AllAsync(alices)).Id);
    }
}
