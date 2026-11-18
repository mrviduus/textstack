using Application.Library;
using Application.Transitional;
using Domain.Library;
using Domain.Transitional;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using NSubstitute;
using NSubstitute.ExceptionExtensions;
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
    private readonly IIngestionJobRepository _jobs = Substitute.For<IIngestionJobRepository>();
    private readonly ILibraryRepository _library = Substitute.For<ILibraryRepository>();
    private readonly IBookChapterRepository _chapters = Substitute.For<IBookChapterRepository>();
    private readonly ILibraryFileStore _files = Substitute.For<ILibraryFileStore>();
    private readonly ITextExtractor _extractor = Substitute.For<ITextExtractor>();
    private readonly FileIngestionJob _job = new() { Id = Guid.NewGuid(), UserId = User, BookId = BookId, FileId = FileId, AttemptCount = 2 };
    private List<BookChapter>? _stored;

    public V2IngestionWorkerTests()
    {
        _library.GetFileAsync(User, BookId, FileId, Arg.Any<CancellationToken>())
            .Returns(new BookFile { Id = FileId, Format = "epub", ServerStorageKey = Key });
        _files.Locate(Key).Returns(_bytes);
        _chapters.When(c => c.ReplaceForFileAsync(User, BookId, FileId, Arg.Any<IReadOnlyList<BookChapter>>(), Arg.Any<CancellationToken>()))
            .Do(call => _stored = call.ArgAt<IReadOnlyList<BookChapter>>(3).ToList());
    }

    public void Dispose() => File.Delete(_bytes);

    /// <summary>The service under test; its registry resolves the fake extractor for requests that <paramref name="match"/> (all by default).</summary>
    private V2IngestionService Service(System.Linq.Expressions.Expression<Predicate<ExtractionRequest>>? match = null)
    {
        var registry = Substitute.For<IExtractorRegistry>();
        registry.Resolve(Arg.Is(match ?? (_ => true))).Returns(_extractor);
        return new(_jobs, _library, _chapters, _files, registry, NullLogger<V2IngestionService>.Instance);
    }

    private void Extracts(IReadOnlyList<ContentUnit> units, TextSource source = TextSource.NativeText, string? warning = null) =>
        _extractor.ExtractAsync(Arg.Any<ExtractionRequest>(), Arg.Any<CancellationToken>()).Returns(new ExtractionResult(
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
        await _jobs.Received().SucceedAsync(_job.Id, 2, "epub", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ProcessAsync_ExtractorPickedByTheStoredFormat_NotTheClientsName()
    {
        Extracts([Unit("One", 0)]);

        await Service(q => q.FileName == $"{FileId}.epub" && !q.Options.ExtractInlineImages).ProcessAsync(_job, Ct);

        await _jobs.Received().SucceedAsync(_job.Id, 2, "epub", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ProcessAsync_BytesMissingOnDisk_FailsTheJobWithoutExtracting()
    {
        _files.Locate(Key).Returns((string?)null);

        await Service().ProcessAsync(_job, Ct);

        await _jobs.Received().FailAsync(_job.Id, 2, "The file's bytes are not on the server.", null, Arg.Any<CancellationToken>());
        Assert.Empty(_extractor.ReceivedCalls());
    }

    [Fact]
    public async Task ProcessAsync_NoTextLayer_FailsWithTheExtractorsMessage()
    {
        Extracts([], TextSource.None, "Only images, no text.");

        await Service().ProcessAsync(_job, Ct);

        await _jobs.Received().FailAsync(_job.Id, 2, "Only images, no text.", "epub", Arg.Any<CancellationToken>());
        Assert.Empty(_chapters.ReceivedCalls());
    }

    [Fact]
    public async Task ProcessAsync_NoUnits_FailsAsNoReadableContent()
    {
        Extracts([]);

        await Service().ProcessAsync(_job, Ct);

        await _jobs.Received().FailAsync(_job.Id, 2, "No readable content extracted", "epub", Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ProcessAsync_SomethingThrows_LeavesTheJobProcessingForTheStuckReclaim()
    {
        _chapters.ReplaceForFileAsync(User, BookId, FileId, Arg.Any<IReadOnlyList<BookChapter>>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new NpgsqlException("connection reset"));
        Extracts([Unit("One", 0)]);

        await Service().ProcessAsync(_job, Ct);

        // Not failed, not given back: the claim reclaims it as stuck and counts the attempt, up to MaxAttempts.
        Assert.Empty(_jobs.ReceivedCalls());
    }

    [Fact]
    public async Task ProcessAsync_Shutdown_GivesTheJobBackAndRethrows()
    {
        using var shutdown = new CancellationTokenSource();
        _extractor.ExtractAsync(Arg.Any<ExtractionRequest>(), Arg.Any<CancellationToken>())
            .Returns(async call =>
            {
                await shutdown.CancelAsync();
                call.Arg<CancellationToken>().ThrowIfCancellationRequested();
                return (ExtractionResult)null!;
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Service().ProcessAsync(_job, shutdown.Token));

        await _jobs.Received().ReturnToQueueAsync(_job.Id, 2, CancellationToken.None);
        await _jobs.DidNotReceiveWithAnyArgs().FailAsync(default, default, default!, default, Ct);
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
        _jobs.FailExhaustedAsync(3, Arg.Any<TimeSpan>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns([_job]);

        Assert.False(await Service().ProcessNextAsync(Ct));

        await _jobs.Received().FailExhaustedAsync(3, TimeSpan.FromMinutes(2), Application.Ingestion.IngestionRetry.ExceededAttemptsError, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SweepAsync_Pass_SweepsStalePartsAndSetsTheGauge()
    {
        await Service().SweepAsync(Ct);

        _files.Received().SweepStaleParts(Arg.Any<DateTimeOffset>());
        await _jobs.Received().CountStuckAsync(Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>());
    }

    private void OrphanCandidates(params string[] keys)
    {
        _files.EnumerateLibraryFilesOlderThan(Arg.Is<DateTimeOffset>(t => t < DateTimeOffset.UtcNow - TimeSpan.FromMinutes(59))).Returns(keys);
        _library.AllStorageKeysAsync(Arg.Any<CancellationToken>()).Returns(new HashSet<string> { "library/kept.epub" });
        _files.TryDelete(Arg.Any<string>()).Returns(true);
    }

    [Fact]
    public async Task SweepOrphansAsync_OldFiles_DeletesOnlyThoseNoRowNamesThenEmptyDirectories()
    {
        OrphanCandidates("library/kept.epub", "library/orphan.epub", "library/stale.tmp");

        await Service().SweepOrphansAsync(Ct);

        _files.Received().TryDelete("library/orphan.epub");
        _files.Received().TryDelete("library/stale.tmp");
        _files.DidNotReceive().TryDelete("library/kept.epub");
        _files.Received().RemoveEmptyDirectories(Arg.Is<DateTimeOffset>(t => t < DateTimeOffset.UtcNow - TimeSpan.FromMinutes(59)));
    }

    [Fact]
    public async Task SweepOrphansAsync_ADeleteFails_GoesOnWithTheRest()
    {
        OrphanCandidates("library/busy.epub", "library/orphan.epub");
        _files.TryDelete("library/busy.epub").Returns(false);

        await Service().SweepOrphansAsync(Ct);

        _files.Received().TryDelete("library/orphan.epub");
    }

    [Fact]
    public async Task ExecuteAsync_SteadyQueue_StillSweepsOnItsInterval()
    {
        // Every pass claims a job: the queue never drains.
        _jobs.FailExhaustedAsync(default, default, default!, Ct).ReturnsForAnyArgs([]);
        _jobs.ClaimNextAsync(default, default, Ct).ReturnsForAnyArgs(_job);
        _library.AllStorageKeysAsync(Ct).ReturnsForAnyArgs(new HashSet<string>());
        _files.EnumerateLibraryFilesOlderThan(default).ReturnsForAnyArgs([]);
        Extracts([Unit("One", 0)]);
        var sweeps = 0;
        _files.WhenForAnyArgs(f => f.SweepStaleParts(default)).Do(_ => sweeps++);
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        using var worker = new V2IngestionWorker(services, NullLogger<V2IngestionWorker>.Instance) { SweepEvery = TimeSpan.FromMilliseconds(20) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && sweeps < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(sweeps >= 2);
        _files.Received(1).RemoveEmptyDirectories(Arg.Any<DateTimeOffset>());
    }

    [Fact]
    public async Task ExecuteAsync_V2Unreachable_LogsAWarningAndKeepsRunning()
    {
        _jobs.FailExhaustedAsync(default, default, default!, Ct)
            .ThrowsAsyncForAnyArgs(new NpgsqlException("connection refused"));
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        var log = new CapturingLogger<V2IngestionWorker>();
        using var worker = new V2IngestionWorker(services, log) { Backoff = TimeSpan.FromMilliseconds(10) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && log.Entries.Count(e => e.Level == LogLevel.Warning) < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(log.Entries.Count(e => e.Level == LogLevel.Warning) >= 2);
        Assert.True(worker.ExecuteTask!.IsCompletedSuccessfully);
    }
}
