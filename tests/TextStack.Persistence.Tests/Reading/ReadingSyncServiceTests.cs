using System.Text.Json;
using Application.Library;
using Application.Reading;
using Application.Transitional;
using Contracts.Sync;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Reading;

public class ReadingSyncServiceTests(PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // "Mark as read" on a book never opened (no TOC synced, no state): the shared client's start, a bare CFI, lands completed.
    [Fact]
    public async Task WriteAsync_MarkReadOnABookWithNoTocAndNoState_LandsCompleted()
    {
        var book = await db.NewReaderWithBookAsync();
        var library = new BookAccess(new LibraryRepository(db.DataSource));
        var service = new ReadingSyncService(library, new ReadingStateRepository(db.DataSource), new ReadingSessionRepository(db.DataSource),
            new ChapterReadService(library), TimeProvider.System);
        var now = DateTimeOffset.UtcNow;

        var result = await service.WriteAsync(book.UserId, book.Id, new ReadingStateRequest(null, book.CurrentFile!.Id,
            JsonSerializer.Deserialize<JsonElement>("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/2)"}"""), 0m, null, null, now, now), Ct);

        Assert.Equal(200, result.Status);
        Assert.NotNull(Assert.IsType<ReadingStateDto>(result.Body).CompletedAt);
    }
}
