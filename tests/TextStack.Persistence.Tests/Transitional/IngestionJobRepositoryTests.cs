using Dapper;
using Domain.Library;
using Domain.Transitional;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Transitional;

// The claim, the sweep and the count are cross-user: the claim tests first drain every earlier
// test's eligible jobs, and the count is compared before and after. No other class leaves a job
// queued or processing (the seed's is finished).
public class IngestionJobRepositoryTests(V2PostgresFixture db)
{
    private readonly IngestionJobRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const int MaxAttempts = 3;
    private static readonly TimeSpan Stuck = TimeSpan.FromHours(1);
    // Longer than any job here has been running, so a claim takes queued jobs only.
    private static readonly TimeSpan NothingStuck = TimeSpan.FromDays(365 * 100);

    private async Task<(Book Book, FileIngestionJob Job)> QueuedAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        return (book, await _repo.EnqueueAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct));
    }

    private async Task DrainAsync(TimeSpan stuckAfter)
    {
        while (await _repo.ClaimNextAsync(MaxAttempts, stuckAfter, Ct) is not null) { }
    }

    /// <summary>Puts the job in <paramref name="status"/>, as a run started <paramref name="ago"/> by the database's clock left it.</summary>
    private async Task SetAsync(FileIngestionJob job, TimeSpan ago, int attempts, string status = FileIngestionJob.Processing,
        string? error = null, string? sourceFormat = null)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            UPDATE ingestion_jobs SET status = @status, started_at = now() - @ago, attempt_count = @attempts, error = @error, source_format = @sourceFormat
            WHERE id = @Id
            """, new { job.Id, status, ago, attempts, error, sourceFormat }, cancellationToken: Ct));
    }

    private async Task<FileIngestionJob> ReadAsync(FileIngestionJob job)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return await conn.QuerySingleAsync<FileIngestionJob>(new CommandDefinition(
            "SELECT id, status, attempt_count, error, source_format, started_at, finished_at FROM ingestion_jobs WHERE id = @Id", job, cancellationToken: Ct));
    }

    /// <summary>The library feed's watermark for the book (#1118): every job status write moves it.</summary>
    private Task<DateTimeOffset> BookUpdatedAtAsync(Book book) =>
        db.ScalarAsync<DateTimeOffset>("SELECT updated_at FROM books WHERE id = @id", new { id = book.Id });

    [Fact]
    public async Task EnqueueAsync_AReaderUploadsAFileTwice_QueuesJobsAndTheNewerIsTheLatest()
    {
        var (book, first) = await QueuedAsync();

        Assert.Equal((book.UserId, book.Id, FileIngestionJob.Queued, 0), (first.UserId, first.BookId, first.Status, first.AttemptCount));
        Assert.True(await BookUpdatedAtAsync(book) > book.UpdatedAt, "an enqueue moves the book's feed watermark");

        var second = await _repo.EnqueueAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);
        await DrainAsync(NothingStuck); // a claim reorders nothing

        Assert.Equal(second.Id, (await _repo.GetLatestForFileAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct))!.Id);
    }

    [Fact]
    public async Task EnqueueAsync_AnotherReaderHoldingAlicesIds_CanNeitherQueueNorSeeNorCancelHerJobs()
    {
        var (alices, job) = await QueuedAsync();
        var bob = await db.NewReaderAsync();

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.EnqueueAsync(bob, alices.Id, alices.CurrentFile!.Id, Ct));
        Assert.Equal("23503", error.SqlState);
        Assert.Null(await _repo.GetLatestForFileAsync(bob, alices.Id, alices.CurrentFile!.Id, Ct));
        Assert.False(await _repo.CancelActiveAsync(bob, alices.Id, Ct));

        Assert.Equal(FileIngestionJob.Queued, (await ReadAsync(job)).Status);
    }

    // As legacy UserBookService.CancelAsync: queued or processing. A run that claimed the job before
    // the cancel can then neither finish it nor give it back.
    [Fact]
    public async Task CancelActiveAsync_AReaderCancelsQueuedAndRunningJobs_FailsThemAndTheRunCannotUndoIt()
    {
        var (queuedBook, queued) = await QueuedAsync();
        var (runningBook, running) = await QueuedAsync();
        await SetAsync(running, TimeSpan.Zero, attempts: 1);
        var watermark = await BookUpdatedAtAsync(queuedBook);

        Assert.True(await _repo.CancelActiveAsync(queuedBook.UserId, queuedBook.Id, Ct));
        Assert.True(await _repo.CancelActiveAsync(runningBook.UserId, runningBook.Id, Ct));

        foreach (var job in new[] { queued, running })
        {
            var read = await ReadAsync(job);
            Assert.Equal((FileIngestionJob.Failed, "Cancelled by user"), (read.Status, read.Error));
        }
        Assert.True(await BookUpdatedAtAsync(queuedBook) > watermark, "a cancel moves the book's feed watermark");
        Assert.False(await _repo.CancelActiveAsync(queuedBook.UserId, queuedBook.Id, Ct)); // nothing active left

        Assert.False(await _repo.SucceedAsync(running.Id, 1, "epub", Ct));
        Assert.False(await _repo.ReturnToQueueAsync(running.Id, 1, Ct));
        var after = await ReadAsync(running);
        Assert.Equal((FileIngestionJob.Failed, "Cancelled by user"), (after.Status, after.Error));
    }

    [Fact]
    public async Task ClaimNextAsync_TheWorkerPicksUpWork_StartsTheOldestQueuedJobWithOneAttempt()
    {
        await DrainAsync(NothingStuck);
        var (_, older) = await QueuedAsync();
        var (_, newer) = await QueuedAsync();

        var claimed = (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct))!;

        Assert.Equal((older.Id, FileIngestionJob.Processing, 1), (claimed.Id, claimed.Status, claimed.AttemptCount));
        Assert.NotNull(claimed.StartedAt);
        Assert.Equal(newer.Id, (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct))?.Id);
    }

    [Fact]
    public async Task ClaimNextAsync_TwoClaimersOneJob_ExactlyOneGetsIt()
    {
        await DrainAsync(NothingStuck);
        var (_, job) = await QueuedAsync();

        var claims = await Task.WhenAll(
            _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct), _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct));

        Assert.Equal(job.Id, Assert.Single(claims, c => c is not null)!.Id);
    }

    [Fact]
    public async Task ClaimNextAsync_JobLockedByAnotherClaimer_SkipsItWithoutWaiting()
    {
        await DrainAsync(NothingStuck);
        var (_, job) = await QueuedAsync();
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition("SELECT FROM ingestion_jobs WHERE id = @Id FOR UPDATE", job, tx, cancellationToken: Ct));

        var second = _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct);
        await db.WaitUntilBlockedByAsync(holder, second);
        await tx.CommitAsync(Ct);

        Assert.Null(await second);
    }

    // A worker that crashes mid-job leaves it "processing": counted and reclaimed once past the window,
    // until its attempts run out; then the sweep fails it, and a finished job is never counted.
    [Fact]
    public async Task ClaimNextAsync_AJobKeepsCrashingItsWorker_IsReclaimedUntilItsAttemptsRunOutThenFailed()
    {
        await DrainAsync(Stuck);
        var before = await _repo.CountStuckAsync(Stuck, Ct);
        var (_, job) = await QueuedAsync();

        await SetAsync(job, TimeSpan.Zero, attempts: 1);
        Assert.Null(await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct)); // started just now: not stuck
        Assert.Equal(before, await _repo.CountStuckAsync(Stuck, Ct));

        await SetAsync(job, Stuck * 2, attempts: 1);
        Assert.Equal(before + 1, await _repo.CountStuckAsync(Stuck, Ct));
        var reclaimed = (await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct))!;
        Assert.Equal((job.Id, 2), (reclaimed.Id, reclaimed.AttemptCount));

        await SetAsync(job, Stuck * 2, attempts: MaxAttempts);
        Assert.Null(await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct)); // exhausted: left for the sweep

        var row = Assert.Single(await _repo.FailExhaustedAsync(MaxAttempts, Stuck, "too many attempts", Ct), j => j.Id == job.Id);
        Assert.Equal((FileIngestionJob.Failed, "too many attempts"), (row.Status, row.Error));
        Assert.NotNull(row.FinishedAt);
        Assert.Equal(before, await _repo.CountStuckAsync(Stuck, Ct)); // failed, though started long ago
    }

    [Fact]
    public async Task SucceedAsync_TheClaimingRunFinishes_RecordsTheFormatAndClearsAnEarlierError()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1, error: "an earlier attempt's");
        Assert.Equal("an earlier attempt's", (await ReadAsync(job)).Error);

        Assert.True(await _repo.SucceedAsync(job.Id, 1, "epub", Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Succeeded, "epub", (string?)null), (read.Status, read.SourceFormat, read.Error));
        Assert.NotNull(read.FinishedAt);
    }

    [Fact]
    public async Task FailAsync_ARunReclaimedAsStuck_LosesItsFinishAndTheNewRunKeepsTheRecordedFormat()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 2, sourceFormat: "pdf");

        Assert.False(await _repo.FailAsync(job.Id, 1, "corrupt", null, Ct)); // the first run, reclaimed since
        Assert.Equal(FileIngestionJob.Processing, (await ReadAsync(job)).Status);

        Assert.True(await _repo.FailAsync(job.Id, 2, "corrupt", null, Ct)); // the claiming run, no format given

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Failed, "corrupt", "pdf"), (read.Status, read.Error, read.SourceFormat));
    }

    [Fact]
    public async Task ReturnToQueueAsync_AWorkerStopsMidJob_GivesItBackUncountedUnlessReclaimedSince()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 2);

        Assert.False(await _repo.ReturnToQueueAsync(job.Id, 1, Ct)); // the first run, reclaimed since
        var untouched = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Processing, 2), (untouched.Status, untouched.AttemptCount));

        Assert.True(await _repo.ReturnToQueueAsync(job.Id, 2, Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Queued, 1, (DateTimeOffset?)null), (read.Status, read.AttemptCount, read.StartedAt));
    }
}
