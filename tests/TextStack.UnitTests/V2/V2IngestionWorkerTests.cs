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

    /// <summary>The service under test; its registry resolves the fake extractor for requests that <paramref name="match"/> (all by default).</summary>
    private V2IngestionService Service(System.Linq.Expressions.Expression<Func<ExtractionRequest, bool>>? match = null)
    {
        var registry = new Mock<IExtractorRegistry>();
        registry.Setup(r => r.Resolve(It.Is(match ?? (_ => true)))).Returns(_extractor.Object);
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

        await Service(q => q.FileName == $"{FileId}.epub" && !q.Options.ExtractInlineImages).ProcessAsync(_job, Ct);

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
    public async Task ProcessAsync_SomethingThrows_LeavesTheJobProcessingForTheStuckReclaim()
    {
        _chapters.Setup(c => c.ReplaceForFileAsync(User, BookId, FileId, It.IsAny<IReadOnlyList<BookChapter>>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new NpgsqlException("connection reset"));
        Extracts([Unit("One", 0)]);

        await Service().ProcessAsync(_job, Ct);

        // Not failed, not given back: the claim reclaims it as stuck and counts the attempt, up to MaxAttempts.
        _jobs.VerifyNoOtherCalls();
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
    public async Task ProcessNextAsync_EmptyQueue_FailsExhaustedJobsFirst()
    {
        // Without this a job that crashed its worker on every attempt stays processing, and its TOC says so for good.
        _jobs.Setup(j => j.FailExhaustedAsync(3, It.IsAny<TimeSpan>(), It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync([_job]);

        Assert.False(await Service().ProcessNextAsync(Ct));

        _jobs.Verify(j => j.FailExhaustedAsync(3, TimeSpan.FromMinutes(2), Application.Ingestion.IngestionService.ExceededAttemptsError, It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task SweepAsync_Pass_SweepsStalePartsAndSetsTheGauge()
    {
        await Service().SweepAsync(Ct);

        _files.Verify(f => f.SweepStaleParts(It.IsAny<DateTimeOffset>()));
        _jobs.Verify(j => j.CountStuckAsync(It.IsAny<TimeSpan>(), It.IsAny<CancellationToken>()));
    }

    private void OrphanCandidates(params string[] keys)
    {
        _files.Setup(f => f.EnumerateLibraryFilesOlderThan(It.Is<DateTimeOffset>(t => t < DateTimeOffset.UtcNow - TimeSpan.FromMinutes(59)))).Returns(keys);
        _library.Setup(l => l.AllStorageKeysAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new HashSet<string> { "library/kept.epub" });
        _files.Setup(f => f.TryDelete(It.IsAny<string>())).Returns(true);
    }

    [Fact]
    public async Task SweepOrphansAsync_OldFiles_DeletesOnlyThoseNoRowNamesThenEmptyDirectories()
    {
        OrphanCandidates("library/kept.epub", "library/orphan.epub", "library/stale.tmp");

        await Service().SweepOrphansAsync(Ct);

        _files.Verify(f => f.TryDelete("library/orphan.epub"));
        _files.Verify(f => f.TryDelete("library/stale.tmp"));
        _files.Verify(f => f.TryDelete("library/kept.epub"), Times.Never);
        _files.Verify(f => f.RemoveEmptyDirectories(It.Is<DateTimeOffset>(t => t < DateTimeOffset.UtcNow - TimeSpan.FromMinutes(59))));
    }

    [Fact]
    public async Task SweepOrphansAsync_ADeleteFails_GoesOnWithTheRest()
    {
        OrphanCandidates("library/busy.epub", "library/orphan.epub");
        _files.Setup(f => f.TryDelete("library/busy.epub")).Returns(false);

        await Service().SweepOrphansAsync(Ct);

        _files.Verify(f => f.TryDelete("library/orphan.epub"));
    }

    private static IConfiguration Config(bool flag, string? v2) => V2Fakes.Config(flag, v2);

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
    public async Task ExecuteAsync_SteadyQueue_StillSweepsOnItsInterval()
    {
        // Every pass claims a job: the queue never drains.
        _jobs.Setup(j => j.FailExhaustedAsync(It.IsAny<int>(), It.IsAny<TimeSpan>(), It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync([]);
        _jobs.Setup(j => j.ClaimNextAsync(It.IsAny<int>(), It.IsAny<TimeSpan>(), It.IsAny<CancellationToken>())).ReturnsAsync(_job);
        _library.Setup(l => l.AllStorageKeysAsync(It.IsAny<CancellationToken>())).ReturnsAsync(new HashSet<string>());
        _files.Setup(f => f.EnumerateLibraryFilesOlderThan(It.IsAny<DateTimeOffset>())).Returns([]);
        Extracts([Unit("One", 0)]);
        var sweeps = 0;
        _files.Setup(f => f.SweepStaleParts(It.IsAny<DateTimeOffset>())).Callback(() => sweeps++);
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        using var worker = new V2IngestionWorker(Config(true, "Host=x"), services, NullLogger<V2IngestionWorker>.Instance) { SweepEvery = TimeSpan.FromMilliseconds(20) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && sweeps < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(sweeps >= 2);
        _files.Verify(f => f.RemoveEmptyDirectories(It.IsAny<DateTimeOffset>()), Times.Once);
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
