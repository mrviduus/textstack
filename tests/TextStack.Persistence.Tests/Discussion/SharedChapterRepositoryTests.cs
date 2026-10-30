using Application.Discussion;
using Dapper;
using Domain.Discussion;
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

    private async Task<long> CountAsync(Book book)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            "SELECT count(*) FROM shared_chapters WHERE user_id = @UserId AND book_id = @Id", book, cancellationToken: Ct));
    }

    /// <summary>A checkpoint based on <paramref name="share"/>: same chapter and file version.</summary>
    private async Task<DiscussionCheckpoint> AppendCheckpointOnAsync(Book book, SharedChapter share)
    {
        var checkpoint = NewCheckpoint(book);
        (checkpoint.ChapterKey, checkpoint.FileId, checkpoint.SharedChapterId) = (share.ChapterKey, share.FileId, share.Id);
        Assert.Equal(DiscussionWriteOutcome.Created, (await _checkpoints.AppendAsync(checkpoint, Ct)).Outcome);
        return checkpoint;
    }

    [Fact]
    public async Task ShareAsync_NewOperation_StoresTheSnapshot()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        share.NotesSnapshot = """[{"text":"a note"}]""";

        var result = await _repo.ShareAsync(share, Ct);

        Assert.Equal(DiscussionWriteOutcome.Created, result.Outcome);
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

        Assert.Equal((DiscussionWriteOutcome.Replayed, share.Id), (result.Outcome, result.Stored!.Id));
        Assert.Equal(1L, await CountAsync(book));
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

        Assert.Equal((DiscussionWriteOutcome.OperationConflict, share.Id), (result.Outcome, result.Stored!.Id));
        Assert.Equal(1L, await CountAsync(book));
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
        Assert.Equal(0L, await CountAsync(book));
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
        var checkpoint = await AppendCheckpointOnAsync(book, share);

        Assert.True(await _repo.DeleteAsync(book.UserId, share.Id, Ct));

        Assert.Null(await _repo.GetAsync(book.UserId, share.Id, Ct));
        var kept = Assert.Single((await _checkpoints.ListAsync(book.UserId, book.Id, null, 10, null, Ct)).Items);
        Assert.Equal((checkpoint.Id, (Guid?)null), (kept.Id, kept.SharedChapterId));
    }

    [Fact]
    public async Task DeleteAsync_WithoutUnlinkingFirst_TheCheckpointForeignKeyRefuses()
    {
        var book = await db.NewReaderWithBookAsync();
        var share = NewShare(book);
        await _repo.ShareAsync(share, Ct);
        await AppendCheckpointOnAsync(book, share);

        // What DeleteAsync's unlink step exists for. The FK is DEFERRABLE INITIALLY DEFERRED, so a bare
        // delete would only fail at commit; SET CONSTRAINTS ALL IMMEDIATE makes it fail here.
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("SET CONSTRAINTS ALL IMMEDIATE", transaction: tx, cancellationToken: Ct));
        var error = await Assert.ThrowsAsync<PostgresException>(() => conn.ExecuteAsync(new CommandDefinition(
            "DELETE FROM shared_chapters WHERE id = @Id", share, tx, cancellationToken: Ct)));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
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

        Assert.Equal((DiscussionWriteOutcome.Created, his.Id), (result.Outcome, result.Stored!.Id));
        Assert.Equal(hers.Id, Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct)).Id);
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
        await AppendCheckpointOnAsync(alices, hers);

        Assert.False(await _repo.DeleteAsync(bob, hers.Id, Ct));

        Assert.NotNull(await _repo.GetAsync(alices.UserId, hers.Id, Ct));
        var kept = Assert.Single((await _checkpoints.ListAsync(alices.UserId, alices.Id, null, 10, null, Ct)).Items);
        Assert.Equal(hers.Id, kept.SharedChapterId);
    }
}
