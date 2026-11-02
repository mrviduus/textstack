using Application.Common;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using Domain.Reading;
using Npgsql;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.TestJson;

namespace TextStack.Persistence.Tests.Library;

/// <summary>The replacement use case composes two repositories in one V2 transaction (#1067): only Postgres can show that.</summary>
public class LibrarySyncServiceTests(V2PostgresFixture db)
{
    private readonly ReadingStateRepository _reading = new(db.DataSource);
    private readonly LibrarySyncService _service = new(new LibraryRepository(db.DataSource), new ReadingStateRepository(db.DataSource), db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static ReplaceFileRequest Replacing(Guid? replacesFileId) =>
        new(replacesFileId, new BookFileRequest(null, V2PostgresFixture.PayloadSha256(Guid.NewGuid().ToString()), 2048, "book v2.epub", "epub", null, null));

    private async Task<Book> BookWithStateAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        await _reading.AdvanceAsync(book.UserId, book.Id,
            new() { FileId = book.CurrentFile!.Id, CurrentLocator = Page(3), BookFraction = 0.3m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, Ct);
        return book;
    }

    [Fact]
    public async Task ReplaceFileAsync_BookWithReadingState_DeletesTheStateWithTheReplacement()
    {
        var book = await BookWithStateAsync();

        var result = await _service.ReplaceFileAsync(book.UserId, book.Id, Guid.NewGuid(), Replacing(book.CurrentFile!.Id), Ct);

        Assert.Equal(200, result.Status);
        Assert.Null(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_StaleView_KeepsTheReadingState()
    {
        var book = await BookWithStateAsync();

        var result = await _service.ReplaceFileAsync(book.UserId, book.Id, Guid.NewGuid(), Replacing(Guid.NewGuid()), Ct);

        Assert.Equal((409, SyncCodes.FileReplaced), (result.Status, ((V2Error)result.Body!).Code));
        Assert.NotNull(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }

    /// <summary>The real reading-state repository, except that its delete fails right after it ran: a step after the replacement that throws.</summary>
    private sealed class FailsAfterDelete(IReadingStateRepository real) : IReadingStateRepository
    {
        public Task<ReadingState?> GetAsync(Guid userId, Guid bookId, CancellationToken ct) => real.GetAsync(userId, bookId, ct);

        public Task<RevisionedWrite<ReadingState>> AdvanceAsync(Guid userId, Guid bookId, ReadingState state, long? expectedRevision, CancellationToken ct) =>
            real.AdvanceAsync(userId, bookId, state, expectedRevision, ct);

        public Task<RevisionedWrite<ReadingState>> ResetAsync(Guid userId, Guid bookId, long expectedRevision, CancellationToken ct) =>
            real.ResetAsync(userId, bookId, expectedRevision, ct);

        public async Task<bool> DeleteForFileAsync(Guid userId, Guid bookId, Guid fileId, NpgsqlTransaction? tx = null, CancellationToken ct = default)
        {
            await real.DeleteForFileAsync(userId, bookId, fileId, tx, ct);
            throw new InvalidOperationException("the step after the delete failed");
        }

        public Task<IReadOnlyList<ReadingState>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterBookId, int limit, CancellationToken ct) =>
            real.ListChangedAsync(userId, since, afterBookId, limit, ct);
    }

    [Fact]
    public async Task ReplaceFileAsync_FailureBeforeCommit_RollsBackTheReplacementAndTheStateDeleteTogether()
    {
        var book = await BookWithStateAsync();
        var library = new LibraryRepository(db.DataSource);
        var failing = new LibrarySyncService(library, new FailsAfterDelete(_reading), db.DataSource);

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            failing.ReplaceFileAsync(book.UserId, book.Id, Guid.NewGuid(), Replacing(book.CurrentFile!.Id), Ct));

        // Either write on a connection of its own would have committed by now.
        Assert.Equal(book.CurrentFile.Id, (await library.GetAsync(book.UserId, book.Id, Ct))!.CurrentFile!.Id);
        Assert.NotNull(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }
}
