using Application.Common;
using Application.Discussion;
using Dapper;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

public class SharedChapterRepositoryTests(V2PostgresFixture db)
{
    private readonly SharedChapterRepository _repo = new(db.DataSource);
    private readonly CheckpointRepository _checkpoints = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task ShareAsync_NewOperation_StoresTheSnapshot()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        share.NotesSnapshot = """[{"text":"a note"}]""";

        var result = await _repo.ShareAsync(share, Ct);

        Assert.Equal(WriteOutcome.Created, result.Outcome);
        var read = (await _repo.GetAsync(book.UserId, share.Id, Ct))!;
        Assert.Equal((book.Id, book.CurrentFile!.Id, "ch-1", "One", "It was a dark night.", "en", share.OperationId),
            (read.BookId, read.FileId, read.ChapterKey, read.ChapterTitle, read.ChapterText, read.Language, read.OperationId));
        Assert.Equal("""[{"text": "a note"}]""", read.NotesSnapshot);
    }

    [Fact]
    public async Task ShareAsync_SameOperationAndPayloadHash_ReplaysTheStoredRowWithoutASecond()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _repo.ShareAsync(share, Ct);
        var retry = NewShare(book);
        (retry.OperationId, retry.PayloadSha256) = (share.OperationId, share.PayloadSha256);

        var result = await _repo.ShareAsync(retry, Ct);

        Assert.Equal((WriteOutcome.Replayed, share.Id), (result.Outcome, result.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("shared_chapters", book));
    }

    [Fact]
    public async Task ShareAsync_SameOperationOtherPayloadHash_ConflictsAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _repo.ShareAsync(share, Ct);
        var changed = NewShare(book);
        changed.OperationId = share.OperationId;

        var result = await _repo.ShareAsync(changed, Ct);

        Assert.Equal((WriteOutcome.OperationConflict, share.Id), (result.Outcome, result.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("shared_chapters", book));
    }

    [Fact]
    public async Task ShareAsync_EightRetriesAtOnce_OneCreatedTheRestReplayedOneRow()
    {
        var book = await db.NewReaderWithBookAsync();
        var first = NewShare(book);

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ =>
        {
            var retry = NewShare(book);
            (retry.OperationId, retry.PayloadSha256) = (first.OperationId, first.PayloadSha256);
            return _repo.ShareAsync(retry, Ct);
        }));

        Assert.Equal(1, results.Count(r => r.Outcome == WriteOutcome.Created));
        Assert.Equal(7, results.Count(r => r.Outcome == WriteOutcome.Replayed));
        Assert.Equal(1L, await db.CountAsync("shared_chapters", book));
    }

    [Fact]
    public async Task ShareAsync_FileOfAnotherBook_IsRefusedByTheProvenanceForeignKey()
    {
        var book = await db.NewReaderWithBookAsync();
        var otherId = Guid.NewGuid();
        var other = await new LibraryRepository(db.DataSource).ImportAsync(
            new Book { Id = otherId, UserId = book.UserId, Title = "Other" }, NewFile(book.UserId, otherId), Ct);
        var share = NewShare(book);
        share.FileId = other.CurrentFile!.Id;

        // The FK is deferred, so it is checked when the statement's own transaction commits: the
        // insert itself surfaces the violation.
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.ShareAsync(share, Ct));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        Assert.Equal(0L, await db.CountAsync("shared_chapters", book));
    }

    [Fact]
    public async Task ListForBookAsync_ChapterSharedTwice_ReturnsBothSnapshotsNewestFirst()
    {
        var book = await db.NewReaderWithBookAsync();
        var first = NewShare(book);
        var second = NewShare(book);
        await _repo.ShareAsync(first, Ct);
        await _repo.ShareAsync(second, Ct);

        Assert.Equal([second.Id, first.Id], (await _repo.ListForBookAsync(book.UserId, book.Id, Ct)).Select(s => s.Id));
    }

    [Fact]
    public async Task DeleteAsync_ShareWithACheckpoint_DeletesItAndKeepsTheCheckpointUnlinked()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _repo.ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        await _checkpoints.AppendAsync(checkpoint, Ct);

        Assert.True(await _repo.DeleteAsync(book.UserId, share.Id, Ct));

        Assert.Null(await _repo.GetAsync(book.UserId, share.Id, Ct));
        var kept = Assert.Single((await _checkpoints.ListAsync(book.UserId, book.Id, null, 10, null, Ct)).Items);
        Assert.Equal((checkpoint.Id, (Guid?)null), (kept.Id, kept.SharedChapterId));
    }

    [Fact]
    public async Task DeleteAsync_WhileAnAppendLinkingTheShareIsInFlight_WaitsThenUnlinksItAndDeletes()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _repo.ShareAsync(share, Ct);
        var checkpointId = Guid.NewGuid();
        // An append caught mid-transaction: the checkpoint is inserted, linked, not yet committed,
        // and holds the share as AppendAsync does. Without the delete's FOR UPDATE, the delete's
        // unlink misses this row and its commit fails on the checkpoint FK.
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var append = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            SELECT 1 FROM shared_chapters WHERE id = @shareId FOR KEY SHARE;
            INSERT INTO discussion_checkpoints (id, user_id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, language, operation_id, payload_sha256)
            VALUES (@checkpointId, @UserId, @BookId, @FileId, @ChapterKey, @shareId, 't', '["x"]', 'en', gen_random_uuid(), @hash);
            """, new { shareId = share.Id, checkpointId, share.UserId, share.BookId, share.FileId, share.ChapterKey, hash = RandomSha256() },
            append, cancellationToken: Ct));

        var delete = _repo.DeleteAsync(book.UserId, share.Id, Ct);
        await db.WaitUntilBlockedByAsync(conn, delete);
        await append.CommitAsync(Ct);

        Assert.True(await delete);
        var kept = Assert.Single((await _checkpoints.ListAsync(book.UserId, book.Id, null, 10, null, Ct)).Items);
        Assert.Equal((checkpointId, (Guid?)null), (kept.Id, kept.SharedChapterId));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ShareAsync_AlicesOperationIdAsBob_CreatesBobsOwnRow()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        var hers = NewShare(alices);
        await _repo.ShareAsync(hers, Ct);
        var his = NewShare(bobs);
        his.OperationId = hers.OperationId;

        var result = await _repo.ShareAsync(his, Ct);

        Assert.Equal((WriteOutcome.Created, his.Id), (result.Outcome, result.Row!.Id));
        Assert.Equal(hers.Id, Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct)).Id);
    }

    [Fact]
    public async Task ShareAsync_BobRetriesHisOperationIdThatAliceAlsoUsed_ReplaysHisRow()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobs = await db.NewReaderWithBookAsync();
        var hers = NewShare(alices);
        await _repo.ShareAsync(hers, Ct);
        var his = NewShare(bobs);
        his.OperationId = hers.OperationId;
        await _repo.ShareAsync(his, Ct);

        var retry = await _repo.ShareAsync(his, Ct);

        Assert.Equal((WriteOutcome.Replayed, his.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task GetAsync_AlicesShareAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var hers = NewShare(alices);
        await _repo.ShareAsync(hers, Ct);

        Assert.Null(await _repo.GetAsync(bob, hers.Id, Ct));
    }

    [Fact]
    public async Task ListForBookAsync_AlicesBookAsBob_ReturnsNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.ShareAsync(NewShare(alices), Ct);

        Assert.Empty(await _repo.ListForBookAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task DeleteAsync_AlicesShareAsBob_ReturnsFalseAndKeepsItAndItsCheckpointLink()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var hers = NewShare(alices);
        await _repo.ShareAsync(hers, Ct);
        await _checkpoints.AppendAsync(NewCheckpoint(alices, hers), Ct);

        Assert.False(await _repo.DeleteAsync(bob, hers.Id, Ct));

        Assert.NotNull(await _repo.GetAsync(alices.UserId, hers.Id, Ct));
        var kept = Assert.Single((await _checkpoints.ListAsync(alices.UserId, alices.Id, null, 10, null, Ct)).Items);
        Assert.Equal(hers.Id, kept.SharedChapterId);
    }
}
