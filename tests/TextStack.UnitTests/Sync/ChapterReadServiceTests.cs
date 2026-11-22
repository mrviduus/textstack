using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.Sync;
using Domain.Transitional;
using NSubstitute;

namespace TextStack.UnitTests.Sync;

/// <summary>The transitional chapter reads (dropped at M6.4) on fakes.</summary>
public class ChapterReadServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly ILibraryRepository _library = SyncFakes.Library(User, BookId, FileId);
    private readonly IBookChapterRepository _chapters = Substitute.For<IBookChapterRepository>();
    private readonly IIngestionJobRepository _jobs = Substitute.For<IIngestionJobRepository>();
    private ChapterReadService Service => new(_library, _chapters, _jobs);

    [Fact]
    public async Task ListAsync_JobStillRunning_EmptyItemsAndItsStatus()
    {
        _chapters.ListTocAsync(User, BookId, FileId, Arg.Any<CancellationToken>()).Returns([]);
        _jobs.GetLatestForFileAsync(User, BookId, FileId, Arg.Any<CancellationToken>())
            .Returns(new FileIngestionJob { Status = FileIngestionJob.Processing });

        var toc = Assert.IsType<FileChaptersDto>((await Service.ListAsync(User, BookId, FileId, Ct)).Body);

        Assert.Equal((0, "processing"), (toc.Items.Count, toc.Ingestion));
    }

    [Fact]
    public async Task ListAsync_FileNotAVersion_IsUnknownFile()
    {
        var result = await Service.ListAsync(User, BookId, Guid.NewGuid(), Ct);

        Assert.Equal(SyncCodes.UnknownFile, SyncFakes.Error(result).Code);
        Assert.Empty(_chapters.ReceivedCalls());
    }

    [Fact]
    public async Task GetAsync_KeyWithANul_IsInvalidPayloadBeforeAnyRead()
    {
        var result = await Service.GetAsync(User, BookId, FileId, "ch\0", Ct);

        Assert.Equal((400, "chapterKey"), (result.Status, SyncFakes.Error(result).Field));
        Assert.Empty(_library.ReceivedCalls());
    }

    [Fact]
    public async Task GetAsync_NoSuchChapter_IsNotFound() =>
        Assert.Equal(SyncCodes.NotFound, SyncFakes.Error(await Service.GetAsync(User, BookId, FileId, "ch-9", Ct)).Code);

    [Fact]
    public async Task GetAsync_Chapter_CarriesItsNeighboursWithoutAProvenanceRead()
    {
        _chapters.GetWithNeighboursAsync(User, BookId, FileId, "2-two", Arg.Any<CancellationToken>())
            .Returns((new BookChapter { ChapterKey = "2-two", ChapterNumber = 2, Title = "Two", Html = "<p>2</p>" },
                new BookChapterHeading { ChapterKey = "1-one", ChapterNumber = 1, Title = "One" }, null));

        var chapter = Assert.IsType<ChapterDto>((await Service.GetAsync(User, BookId, FileId, "2-two", Ct)).Body);

        Assert.Equal(("<p>2</p>", "1-one", (ChapterHeadingDto?)null), (chapter.Html, chapter.Previous!.ChapterKey, chapter.Next));
        Assert.Empty(_library.ReceivedCalls());
    }

    [Fact]
    public async Task GetAsync_FileNotAVersion_IsUnknownFile() =>
        Assert.Equal(SyncCodes.UnknownFile, SyncFakes.Error(await Service.GetAsync(User, BookId, Guid.NewGuid(), "ch-1", Ct)).Code);
}
