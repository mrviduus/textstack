using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
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
        new(replacesFileId, V2PostgresFixture.PayloadSha256(Guid.NewGuid().ToString()), 2048, "book v2.epub", "epub", null, null);

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

        Assert.Equal(SyncStatus.Ok, result.Status);
        Assert.Null(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_StaleView_KeepsTheReadingState()
    {
        var book = await BookWithStateAsync();

        var result = await _service.ReplaceFileAsync(book.UserId, book.Id, Guid.NewGuid(), Replacing(Guid.NewGuid()), Ct);

        Assert.Equal((SyncStatus.Conflict, SyncCodes.FileReplaced), (result.Status, ((V2Error)result.Body!).Code));
        Assert.NotNull(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }
}
