using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;

namespace TextStack.UnitTests.Sync;

/// <summary>A file's chapters are the TOC the reader synced (ADR-033), on fakes.</summary>
public class ChapterReadServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly ILibraryRepository _library = SyncFakes.Library(User, BookId, FileId);
    private ChapterReadService Service => new(new BookAccess(_library));

    // The server extracts nothing (ADR-033 P5): a book no reader has opened yet lists no chapters, and a free-form
    // TOC from before P3 is not the reader's.
    [Theory]
    [InlineData(null)]
    [InlineData("""[{"title":"One","children":[]}]""")]
    public async Task ListAsync_NoReaderToc_EmptyList(string? toc)
    {
        (await _library.GetFileAsync(User, BookId, FileId, Ct))!.Toc = toc;

        var result = await Service.ListAsync(User, BookId, FileId, Ct);

        Assert.Equal(200, result.Status);
        Assert.Empty(Assert.IsType<FileChaptersDto>(result.Body).Items);
    }

    // ADR-033: an assistant's chapter key is checked against the TOC the reader synced; with none synced the
    // message tells the assistant what the user can do, since no key could be right.
    [Theory]
    [InlineData("""[{"key":"toc-1","title":"One","depth":0,"fraction":0}]""", "toc-1", null)]
    [InlineData("""[{"key":"toc-1","title":"One","depth":0,"fraction":0}]""", "ch-1", "The file has no such chapter.")]
    [InlineData(null, "toc-1", "This book's chapters are not known yet: open the book once in the reader.")]
    [InlineData("""[{"title":"One","children":[]}]""", "toc-1", "This book's chapters are not known yet: open the book once in the reader.")] // pre-P3 free-form
    public async Task CheckKeyAsync_KeyAgainstTheSyncedToc_AcceptedOnlyWhenTheTocHasIt(string? toc, string key, string? refusal)
    {
        (await _library.GetFileAsync(User, BookId, FileId, Ct))!.Toc = toc;

        var result = await Service.CheckKeyAsync(User, BookId, FileId, key, Ct);

        if (refusal is null) Assert.Null(result);
        else Assert.Equal((409, SyncCodes.ChapterNotFound, refusal), (result!.Status, SyncFakes.Error(result).Code, SyncFakes.Error(result).Message));
    }

    [Fact]
    public async Task ListAsync_FileNotAVersion_IsUnknownFile()
    {
        var result = await Service.ListAsync(User, BookId, Guid.NewGuid(), Ct);

        Assert.Equal(SyncCodes.UnknownFile, SyncFakes.Error(result).Code);
    }
}
