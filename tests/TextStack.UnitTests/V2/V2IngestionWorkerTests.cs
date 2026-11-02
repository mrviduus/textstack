using Application.Library;
using Application.Transitional;
using Domain.Library;
using Domain.Transitional;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Npgsql;
using TextStack.Extraction.Contracts;
using TextStack.Extraction.Enums;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Registry;
using TextStack.UnitTests.Fakes;
using Worker.Services;

namespace TextStack.UnitTests.V2;

/// <summary>The transitional V2 extraction worker on fakes: a job's run, its failures, the give-back, the sweep, the host's gates.</summary>
public sealed class V2IngestionWorkerTests : IDisposable
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private const string Key = "library/key.epub";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly string _bytes = Path.GetTempFileName();
    private readonly Mock<IIngestionJobRepository> _jobs = new();
    private readonly Mock<ILibraryRepository> _library = new();
    private readonly Mock<IBookChapterRepository> _chapters = new();
    private readonly Mock<ILibraryFileStore> _files = new();
    private readonly Mock<ITextExtractor> _extractor = new();
    private readonly FileIngestionJob _job = new() { Id = Guid.NewGuid(), UserId = User, BookId = BookId, FileId = FileId, AttemptCount = 2 };
    private List<BookChapter>? _stored;

    public V2IngestionWorkerTests()
    {
        _library.Setup(l => l.GetFileAsync(User, BookId, FileId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new BookFile { Id = FileId, Format = "epub", ServerStorageKey = Key });
        _files.Setup(f => f.Locate(Key)).Returns(_bytes);
        _chapters.Setup(c => c.ReplaceForFileAsync(User, BookId, FileId, It.IsAny<IReadOnlyList<BookChapter>>(), It.IsAny<CancellationToken>()))
            .Callback((Guid _, Guid _, Guid _, IReadOnlyList<BookChapter> chapters, CancellationToken _) => _stored = chapters.ToList());
    }

    public void Dispose() => File.Delete(_bytes);

    private V2IngestionService Service()
    {
        var registry = new Mock<IExtractorRegistry>();
        registry.Setup(r => r.Resolve(It.IsAny<ExtractionRequest>())).Returns(_extractor.Object);
        return new(_jobs.Object, _library.Object, _chapters.Object, _files.Object, registry.Object, NullLogger<V2IngestionService>.Instance);
    }

    private void Extracts(IReadOnlyList<ContentUnit> units, TextSource source = TextSource.NativeText, string? warning = null) =>
        _extractor.Setup(e => e.ExtractAsync(It.IsAny<ExtractionRequest>(), It.IsAny<CancellationToken>())).ReturnsAsync(new ExtractionResult(
            SourceFormat.Epub, new ExtractionMetadata(null, null, null, null), units, [],
            new ExtractionDiagnostics(source, null, warning is null ? [] : [new ExtractionWarning(ExtractionWarningCode.NoTextLayer, warning)])));

    private static ContentUnit Unit(string? title, int orderIndex) => new(ContentUnitType.Chapter, title, "<p>x\0y</p>", "x", orderIndex, WordCount: 1);

    [Fact]
    public async Task ProcessAsync_Extracted_ReplacesTheFilesChaptersNumberedDenselyAndSucceeds()
    {
        Extracts([Unit("The Beginning", 3), Unit(null, 7), Unit("", 9)]);

        await Service().ProcessAsync(_job, Ct);

        Assert.Equal([1, 2, 3], _stored!.Select(c => c.ChapterNumber));
        Assert.Equal(["1-the-beginning", "2-chapter-2", "section-3"], _stored!.Select(c => c.ChapterKey));
        Assert.Equal("<p>xy</p>", _stored![0].Html);
        _jobs.Verify(j => j.SucceedAsync(_job.Id, 2, "epub", It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task ProcessAsync_ExtractorPickedByTheStoredFormat_NotTheClientsName()
    {
        Extracts([Unit("One", 0)]);
        var registry = new Mock<IExtractorRegistry>();
        registry.Setup(r => r.Resolve(It.Is<ExtractionRequest>(q => q.FileName == $"{FileId}.epub" && !q.Options.ExtractInlineImages))).Returns(_extractor.Object);

        await new V2IngestionService(_jobs.Object, _library.Object, _chapters.Object, _files.Object, registry.Object, NullLogger<V2IngestionService>.Instance).ProcessAsync(_job, Ct);

        _jobs.Verify(j => j.SucceedAsync(_job.Id, 2, "epub", It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task ProcessAsync_BytesMissingOnDisk_FailsTheJobWithoutExtracting()
    {
        _files.Setup(f => f.Locate(Key)).Returns((string?)null);

        await Service().ProcessAsync(_job, Ct);

        _jobs.Verify(j => j.FailAsync(_job.Id, 2, "The file's bytes are not on the server.", null, It.IsAny<CancellationToken>()));
        _extractor.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ProcessAsync_NoTextLayer_FailsWithTheExtractorsMessage()
    {
        Extracts([], TextSource.None, "Only images, no text.");

        await Service().ProcessAsync(_job, Ct);

        _jobs.Verify(j => j.FailAsync(_job.Id, 2, "Only images, no text.", "epub", It.IsAny<CancellationToken>()));
        _chapters.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task ProcessAsync_NoUnits_FailsAsNoReadableContent()
    {
        Extracts([]);

        await Service().ProcessAsync(_job, Ct);

        _jobs.Verify(j => j.FailAsync(_job.Id, 2, "No readable content extracted", "epub", It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task ProcessAsync_ExtractorThrows_FailsTheJobWithTheMessage()
    {
        _extractor.Setup(e => e.ExtractAsync(It.IsAny<ExtractionRequest>(), It.IsAny<CancellationToken>())).ThrowsAsync(new InvalidDataException("corrupt zip"));

        await Service().ProcessAsync(_job, Ct);

        _jobs.Verify(j => j.FailAsync(_job.Id, 2, "corrupt zip", null, CancellationToken.None));
    }

    [Fact]
    public async Task ProcessAsync_Shutdown_GivesTheJobBackAndRethrows()
    {
        using var shutdown = new CancellationTokenSource();
        _extractor.Setup(e => e.ExtractAsync(It.IsAny<ExtractionRequest>(), It.IsAny<CancellationToken>()))
            .Returns(async (ExtractionRequest _, CancellationToken ct) =>
            {
                await shutdown.CancelAsync();
                ct.ThrowIfCancellationRequested();
                return null!;
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Service().ProcessAsync(_job, shutdown.Token));

        _jobs.Verify(j => j.ReturnToQueueAsync(_job.Id, 2, CancellationToken.None));
        _jobs.Verify(j => j.FailAsync(It.IsAny<Guid>(), It.IsAny<int>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public void ToChapters_TitleAndKeyPastTheirCaps_AreCutWithoutSplittingASurrogatePair()
    {
        var title = new string('a', 499) + "😀";

        var chapter = Assert.Single(V2IngestionService.ToChapters([Unit(title, 0)]));

        Assert.Equal(new string('a', 499), chapter.Title);
        Assert.Equal(200, chapter.ChapterKey.Length);
    }

    [Fact]
    public async Task SweepAsync_SupersededStoredFile_DeletesTheBytesThenForgetsTheKey()
    {
        var old = new BookFile { Id = Guid.NewGuid(), ServerStorageKey = "library/old.epub" };
        _library.Setup(l => l.ListSupersededWithContentAsync(It.IsAny<int>(), It.IsAny<CancellationToken>())).ReturnsAsync([old]);

        await Service().SweepAsync(Ct);

        _files.Verify(f => f.Delete("library/old.epub"));
        _library.Verify(l => l.ForgetSupersededContentAsync(old.Id, It.IsAny<CancellationToken>()));
        _files.Verify(f => f.SweepStaleParts(It.IsAny<DateTimeOffset>()));
    }

    [Fact]
    public async Task SweepAsync_DeleteFails_KeepsTheKeyForTheNextPass()
    {
        var old = new BookFile { Id = Guid.NewGuid(), ServerStorageKey = "library/old.epub" };
        _library.Setup(l => l.ListSupersededWithContentAsync(It.IsAny<int>(), It.IsAny<CancellationToken>())).ReturnsAsync([old]);
        _files.Setup(f => f.Delete("library/old.epub")).Throws(new IOException("busy"));

        await Service().SweepAsync(Ct);

        _library.Verify(l => l.ForgetSupersededContentAsync(It.IsAny<Guid>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    private static IConfiguration Config(bool flag, string? v2) => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = flag.ToString(), ["ConnectionStrings:V2"] = v2 }).Build();

    [Theory]
    [InlineData(false, "Host=x")]
    [InlineData(true, null)]
    public async Task ExecuteAsync_FlagOffOrNoV2Database_EndsWithoutResolvingAnything(bool flag, string? v2)
    {
        // An empty container: resolving the V2 service would throw.
        using var worker = new V2IngestionWorker(Config(flag, v2), new ServiceCollection().BuildServiceProvider(), NullLogger<V2IngestionWorker>.Instance);

        await worker.StartAsync(Ct);
        await worker.ExecuteTask!.WaitAsync(TimeSpan.FromSeconds(5), Ct);

        Assert.True(worker.ExecuteTask.IsCompletedSuccessfully);
    }

    [Fact]
    public async Task ExecuteAsync_V2Unreachable_LogsAWarningAndKeepsRunning()
    {
        _jobs.Setup(j => j.FailExhaustedAsync(It.IsAny<int>(), It.IsAny<TimeSpan>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new NpgsqlException("connection refused"));
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        var log = new CapturingLogger<V2IngestionWorker>();
        using var worker = new V2IngestionWorker(Config(true, "Host=x"), services, log) { Backoff = TimeSpan.FromMilliseconds(10) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && log.Entries.Count(e => e.Level == LogLevel.Warning) < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(log.Entries.Count(e => e.Level == LogLevel.Warning) >= 2);
        Assert.True(worker.ExecuteTask!.IsCompletedSuccessfully);
    }
}
