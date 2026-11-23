using Application.Discussion;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

/// <summary>ADR-033: an assistant's insight names a chapter of the TOC the reader synced; older ones under server keys stay.</summary>
public class InsightSyncServiceTests(PostgresFixture db)
{
    private readonly LibraryRepository _library = new(db.DataSource);
    private readonly BookInsightRepository _insights = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private InsightSyncService Service => new(new BookAccess(_library), _insights,
        new ChapterReadService(new BookAccess(_library)));

    [Fact]
    public async Task SaveAsync_AssistantOnABooksChapters_OnlyTocKeysLandAndOldKeysStayListedUnplaced()
    {
        var book = await db.NewReaderWithBookAsync();
        // Saved before ADR-033 under the server's key: no TOC entry has it.
        await _insights.SaveAsync(NewInsight(book, "ch-7", "old"), Ct);

        var beforeToc = await Service.SaveAsync(book.UserId, book.Id, new InsightRequest("toc-2", "early", null), Ct);
        await _library.SetTocAsync(book.UserId, book.Id, book.CurrentFile!.Id,
            """[{"key":"toc-1","title":"One","depth":0,"fraction":0},{"key":"toc-2","title":"Two","depth":0,"fraction":0.5}]""", Ct);
        var guessed = await Service.SaveAsync(book.UserId, book.Id, new InsightRequest("ch-2", "guess", null), Ct);
        var saved = await Service.SaveAsync(book.UserId, book.Id, new InsightRequest("toc-2", "two", null), Ct);
        await Service.SaveAsync(book.UserId, book.Id, new InsightRequest(null, "whole", null), Ct);

        Assert.Equal((409, SyncCodes.ChapterNotFound, "This book's chapters are not known yet: open the book once in the reader."),
            (beforeToc.Status, Error(beforeToc).Code, Error(beforeToc).Message));
        Assert.Equal((409, "The file has no such chapter."), (guessed.Status, Error(guessed).Message));
        Assert.Equal((201, 1, "Two"), (saved.Status, ((InsightDto)saved.Body!).ChapterNumber, ((InsightDto)saved.Body!).ChapterTitle));
        // The whole book, then TOC order, then the old key with no chapter: listed, never dropped.
        var list = Assert.IsAssignableFrom<IReadOnlyList<InsightDto>>((await Service.ListAsync(book.UserId, book.Id, Ct)).Body);
        Assert.Equal([(null, null, "whole"), ("toc-2", "Two", "two"), ("ch-7", null, "old")],
            list.Select(i => (i.ChapterKey, i.ChapterTitle, i.Text)));
    }

    private static SyncError Error(SyncResult result) => Assert.IsType<SyncError>(result.Body);
}
