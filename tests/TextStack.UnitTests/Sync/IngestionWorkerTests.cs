using Application.Library;
using Application.Transitional;
using Domain.Library;
using Domain.Transitional;
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

namespace TextStack.UnitTests.Sync;

/// <summary>The transitional V2 extraction worker on fakes: a job's run, its failures, the give-back, the sweeps, the host's gates.</summary>
public sealed class IngestionWorkerTests : IDisposable
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private const string Key = "library/key.epub";
    private static readonly TimeSpan StuckAfter = TimeSpan.FromMinutes(2);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly string _bytes = Path.GetTempFileName();
    private readonly IIngestionJobRepository _jobs = Substitute.For<IIngestionJobRepository>();
    private readonly ILibraryRepository _library = Substitute.For<ILibraryRepository>();
    private readonly IBookChapterRepository _chapters = Substitute.For<IBookChapterRepository>();
    private readonly ILibraryFileStore _files = Substitute.For<ILibraryFileStore>();
    private readonly IExtractorRegistry _registry = Substitute.For<IExtractorRegistry>();
    private readonly ITextExtractor _extractor = Substitute.For<ITextExtractor>();
    private readonly SteppedClock _clock = new() { Now = new DateTimeOffset(2026, 11, 17, 12, 0, 0, TimeSpan.Zero) };
    private readonly FileIngestionJob _job = new() { Id = Guid.NewGuid(), UserId = User, BookId = BookId, FileId = FileId, AttemptCount = 2 };
    private List<BookChapter>? _stored;

    public IngestionWorkerTests()
    {
        _library.GetFileAsync(User, BookId, FileId, Arg.Any<CancellationToken>())
            .Returns(new BookFile { Id = FileId, Format = "epub", ServerStorageKey = Key });
        _files.Locate(Key).Returns(_bytes);
        _registry.Resolve(Arg.Any<ExtractionRequest>()).Returns(_extractor);
        _chapters.When(c => c.ReplaceForFileAsync(User, BookId, FileId, Arg.Any<IReadOnlyList<BookChapter>>(), Arg.Any<CancellationToken>()))
            .Do(call => _stored = call.ArgAt<IReadOnlyList<BookChapter>>(3).ToList());
        _jobs.FailExhaustedAsync(default, default, default!, Ct).ReturnsForAnyArgs([]);
    }

    public void Dispose() => File.Delete(_bytes);

    private IngestionService Service() =>
        new(_jobs, _library, _chapters, _files, _registry, NullLogger<IngestionService>.Instance, _clock);

    private void Extracts(IReadOnlyList<ContentUnit> units, TextSource source = TextSource.NativeText, string? warning = null) =>
        _extractor.ExtractAsync(Arg.Any<ExtractionRequest>(), Arg.Any<CancellationToken>()).Returns(new ExtractionResult(
            SourceFormat.Epub, new ExtractionMetadata(null, null, null, null), units, [],
            new ExtractionDiagnostics(source, null, warning is null ? [] : [new ExtractionWarning(ExtractionWarningCode.NoTextLayer, warning)])));

    private static ContentUnit Unit(string? title, int orderIndex) => new(ContentUnitType.Chapter, title, "<p>x\0y</p>", "x", orderIndex, WordCount: 1);

    [Fact]
    public async Task ProcessAsync_ABookExtracts_ChaptersReplacedNumberedDenselyAndTheJobSucceeds()
    {
        var longTitle = new string('a', 499) + "😀";
        Extracts([Unit("The Beginning", 3), Unit(null, 7), Unit("", 9), Unit(longTitle, 12)]);

        await Service().ProcessAsync(_job, Ct);

        // The stored format, not the client's file name, picks the extractor; inline images are not stored.
        _registry.Received(1).Resolve(Arg.Is<ExtractionRequest>(q => q.FileName == $"{FileId}.epub" && !q.Options.ExtractInlineImages));
        Assert.Equal([1, 2, 3, 4], _stored!.Select(c => c.ChapterNumber));
        Assert.Equal(["1-the-beginning", "2-chapter-2", "section-3"], _stored!.Take(3).Select(c => c.ChapterKey));
        Assert.Equal("<p>xy</p>", _stored![0].Html);
        // Title and key past their caps are cut without splitting a surrogate pair.
        Assert.Equal(new string('a', 499), _stored![3].Title);
        Assert.Equal(200, _stored![3].ChapterKey.Length);
        await _jobs.Received(1).SucceedAsync(_job.Id, 2, "epub", Arg.Any<CancellationToken>());
        await _jobs.DidNotReceiveWithAnyArgs().FailAsync(default, default, default!, default, Ct);
    }

    public enum Unreadable { NoFileRow, BytesMissing, NoTextLayer, NoTextLayerSilent, NoUnits }

    /// <summary>A file the server cannot read fails its job with why; no chapters are written.</summary>
    [Theory]
    [InlineData(Unreadable.NoFileRow, "The file's bytes are not on the server.", null, false)]
    [InlineData(Unreadable.BytesMissing, "The file's bytes are not on the server.", null, false)]
    [InlineData(Unreadable.NoTextLayer, "Only images, no text.", "epub", true)]
    [InlineData(Unreadable.NoTextLayerSilent, "Unsupported format", "epub", true)]
    [InlineData(Unreadable.NoUnits, "No readable content extracted", "epub", true)]
    public async Task ProcessAsync_UnreadableFile_FailsTheJobWithWhy(Unreadable why, string error, string? format, bool extracted)
    {
        switch (why)
        {
            case Unreadable.NoFileRow:
                _library.GetFileAsync(User, BookId, FileId, Arg.Any<CancellationToken>()).Returns((BookFile?)null);
                break;
            case Unreadable.BytesMissing:
                _files.Locate(Key).Returns((string?)null);
                break;
            case Unreadable.NoTextLayer:
                Extracts([], TextSource.None, "Only images, no text.");
                break;
            case Unreadable.NoTextLayerSilent:
                Extracts([], TextSource.None);
                break;
            case Unreadable.NoUnits:
                Extracts([]);
                break;
        }

        await Service().ProcessAsync(_job, Ct);

        await _jobs.Received(1).FailAsync(_job.Id, 2, error, format, Arg.Any<CancellationToken>());
        await _jobs.DidNotReceiveWithAnyArgs().SucceedAsync(default, default, default, Ct);
        await _chapters.DidNotReceiveWithAnyArgs().ReplaceForFileAsync(default, default, default, default!, Ct);
        if (extracted)
            await _extractor.ReceivedWithAnyArgs(1).ExtractAsync(default!, Ct);
        else
            await _extractor.DidNotReceiveWithAnyArgs().ExtractAsync(default!, Ct);
    }

    [Fact]
    public async Task ProcessAsync_ServerTroubleMidJob_LeavesItProcessingForTheStuckReclaim()
    {
        _chapters.ReplaceForFileAsync(User, BookId, FileId, Arg.Any<IReadOnlyList<BookChapter>>(), Arg.Any<CancellationToken>())
            .ThrowsAsync(new NpgsqlException("connection reset"));
        Extracts([Unit("One", 0)]);

        await Service().ProcessAsync(_job, Ct);

        // Not failed, not given back, not succeeded: the claim reclaims it as stuck and counts the attempt, up to MaxAttempts.
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
                call.ArgAt<CancellationToken>(1).ThrowIfCancellationRequested();
                return null!;
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Service().ProcessAsync(_job, shutdown.Token));

        await _jobs.Received(1).ReturnToQueueAsync(_job.Id, 2, CancellationToken.None);
        await _jobs.DidNotReceiveWithAnyArgs().FailAsync(default, default, default!, default, Ct);
        await _jobs.DidNotReceiveWithAnyArgs().SucceedAsync(default, default, default, Ct);
    }

    [Fact]
    public async Task ProcessNextAsync_AJobCrashedEveryAttempt_FailedBeforeTheClaimAndAnEmptyQueueSaysSo()
    {
        // Without this a job that crashed its worker on every attempt stays processing, and its TOC says so for good.
        _jobs.FailExhaustedAsync(3, StuckAfter, Application.Ingestion.IngestionRetry.ExceededAttemptsError, Arg.Any<CancellationToken>()).Returns([_job]);
        _jobs.ClaimNextAsync(default, default, Ct).ReturnsForAnyArgs((FileIngestionJob?)null);

        Assert.False(await Service().ProcessNextAsync(Ct));

        Received.InOrder(() =>
        {
            _jobs.FailExhaustedAsync(3, StuckAfter, Application.Ingestion.IngestionRetry.ExceededAttemptsError, Arg.Any<CancellationToken>());
            _jobs.ClaimNextAsync(3, StuckAfter, Arg.Any<CancellationToken>());
        });
    }

    [Fact]
    public async Task Sweeps_OldBytesNoRowNames_DeletedOnTheClocksCutoffs()
    {
        var cutoff = _clock.Now - TimeSpan.FromHours(1);
        _library.AllStorageKeysAsync(Arg.Any<CancellationToken>()).Returns(new HashSet<string> { "library/kept.epub" });
        _files.EnumerateLibraryFilesOlderThan(cutoff).Returns(["library/kept.epub", "library/busy.epub", "library/orphan.epub", "library/stale.tmp"]);
        _files.TryDelete(Arg.Any<string>()).Returns(true);
        _files.TryDelete("library/busy.epub").Returns(false);

        await Service().SweepAsync(Ct);
        await Service().SweepOrphansAsync(Ct);

        // Upload parts: swept against now; the stuck gauge counts with the reclaim's own threshold.
        _files.Received(1).SweepStaleParts(_clock.Now);
        await _jobs.Received(1).CountStuckAsync(StuckAfter, Arg.Any<CancellationToken>());
        // Orphans: a failed delete does not stop the rest; a named file is never touched; empty dirs go last.
        Received.InOrder(() =>
        {
            _files.TryDelete("library/busy.epub");
            _files.TryDelete("library/orphan.epub");
            _files.TryDelete("library/stale.tmp");
            _files.RemoveEmptyDirectories(cutoff);
        });
        _files.DidNotReceive().TryDelete("library/kept.epub");
    }

    [Fact]
    public async Task ExecuteAsync_SteadyQueue_StillSweepsOnItsInterval()
    {
        // Every pass claims a job: the queue never drains.
        _jobs.ClaimNextAsync(default, default, Ct).ReturnsForAnyArgs(_job);
        _library.AllStorageKeysAsync(Arg.Any<CancellationToken>()).Returns(new HashSet<string>());
        _files.EnumerateLibraryFilesOlderThan(Arg.Any<DateTimeOffset>()).Returns([]);
        Extracts([Unit("One", 0)]);
        var sweeps = 0;
        _files.When(f => f.SweepStaleParts(Arg.Any<DateTimeOffset>())).Do(_ => Interlocked.Increment(ref sweeps));
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        using var worker = new IngestionWorker(services, NullLogger<IngestionWorker>.Instance) { SweepEvery = TimeSpan.FromMilliseconds(20) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && Volatile.Read(ref sweeps) < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(sweeps >= 2);
        _files.ReceivedWithAnyArgs(1).RemoveEmptyDirectories(default); // the daily orphan sweep ran once, not per pass
    }

    [Fact]
    public async Task ExecuteAsync_V2Unreachable_LogsAWarningAndKeepsRunning()
    {
        _jobs.FailExhaustedAsync(default, default, default!, Ct).ThrowsAsyncForAnyArgs(new NpgsqlException("connection refused"));
        var services = new ServiceCollection().AddSingleton(Service()).BuildServiceProvider();
        var log = new CapturingLogger<IngestionWorker>();
        using var worker = new IngestionWorker(services, log) { Backoff = TimeSpan.FromMilliseconds(10) };

        await worker.StartAsync(Ct);
        for (var waited = 0; waited < 5000 && log.Entries.Count(e => e.Level == LogLevel.Warning) < 2; waited += 10) await Task.Delay(10, Ct);
        await worker.StopAsync(Ct);

        Assert.True(log.Entries.Count(e => e.Level == LogLevel.Warning) >= 2);
        Assert.True(worker.ExecuteTask!.IsCompletedSuccessfully);
    }
}
