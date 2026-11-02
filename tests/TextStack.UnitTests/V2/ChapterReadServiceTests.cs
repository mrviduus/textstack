using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.V2;
using Domain.Transitional;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>The transitional chapter reads (dropped at M6.4) on fakes.</summary>
public class ChapterReadServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, FileId);
    private readonly Mock<IBookChapterRepository> _chapters = new();
    private readonly Mock<IIngestionJobRepository> _jobs = new();
    private ChapterReadService Service => new(_library.Object, _chapters.Object, _jobs.Object);

    [Fact]
    public async Task ListAsync_JobStillRunning_EmptyItemsAndItsStatus()
    {
        _chapters.Setup(c => c.ListTocAsync(User, BookId, FileId, It.IsAny<CancellationToken>())).ReturnsAsync([]);
        _jobs.Setup(j => j.GetLatestForFileAsync(User, BookId, FileId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new FileIngestionJob { Status = FileIngestionJob.Processing });

        var toc = Assert.IsType<FileChaptersDto>((await Service.ListAsync(User, BookId, FileId, Ct)).Body);

        Assert.Equal((0, "processing"), (toc.Items.Count, toc.Ingestion));
    }

    [Fact]
    public async Task ListAsync_FileNotAVersion_IsUnknownFile()
    {
        var result = await Service.ListAsync(User, BookId, Guid.NewGuid(), Ct);

        Assert.Equal(SyncCodes.UnknownFile, V2Fakes.Error(result).Code);
        _chapters.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GetAsync_KeyWithANul_IsInvalidPayloadBeforeAnyRead()
    {
        var result = await Service.GetAsync(User, BookId, FileId, "ch\0", Ct);

        Assert.Equal((400, "chapterKey"), (result.Status, V2Fakes.Error(result).Field));
        _library.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GetAsync_NoSuchChapter_IsNotFound() =>
        Assert.Equal(SyncCodes.NotFound, V2Fakes.Error(await Service.GetAsync(User, BookId, FileId, "ch-9", Ct)).Code);

    [Fact]
    public async Task GetAsync_Chapter_CarriesItsNeighboursWithoutAProvenanceRead()
    {
        _chapters.Setup(c => c.GetWithNeighboursAsync(User, BookId, FileId, "2-two", It.IsAny<CancellationToken>()))
            .ReturnsAsync((new BookChapter { ChapterKey = "2-two", ChapterNumber = 2, Title = "Two", Html = "<p>2</p>" },
                new BookChapterHeading { ChapterKey = "1-one", ChapterNumber = 1, Title = "One" }, null));

        var chapter = Assert.IsType<ChapterDto>((await Service.GetAsync(User, BookId, FileId, "2-two", Ct)).Body);

        Assert.Equal(("<p>2</p>", "1-one", (ChapterHeadingDto?)null), (chapter.Html, chapter.Previous!.ChapterKey, chapter.Next));
        _library.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GetAsync_FileNotAVersion_IsUnknownFile() =>
        Assert.Equal(SyncCodes.UnknownFile, V2Fakes.Error(await Service.GetAsync(User, BookId, Guid.NewGuid(), "ch-1", Ct)).Code);
}
