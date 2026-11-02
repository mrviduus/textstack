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

    [Fact]
    public async Task EnqueueAsync_File_QueuesAJobWithNoAttempts()
    {
        var (book, job) = await QueuedAsync();

        Assert.Equal((book.UserId, book.Id, FileIngestionJob.Queued, 0), (job.UserId, job.BookId, job.Status, job.AttemptCount));
    }

    [Fact]
    public async Task GetLatestForFileAsync_TwoJobs_IsTheNewerOneAndNullForAnotherUser()
    {
        var (book, _) = await QueuedAsync();
        var second = await _repo.EnqueueAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);
        await DrainAsync(NothingStuck);

        var latest = await _repo.GetLatestForFileAsync(book.UserId, book.Id, book.CurrentFile.Id, Ct);

        Assert.Equal(second.Id, latest!.Id);
        Assert.Null(await _repo.GetLatestForFileAsync(await db.NewReaderAsync(), book.Id, book.CurrentFile.Id, Ct));
    }

    [Fact]
    public async Task EnqueueAsync_AnotherUsersFile_IsRefusedByTheFk()
    {
        var (alices, bob) = (await db.NewReaderWithBookAsync(), await db.NewReaderAsync());

        var error = await Assert.ThrowsAsync<PostgresException>(() =>
            _repo.EnqueueAsync(bob, alices.Id, alices.CurrentFile!.Id, Ct));

        Assert.Equal("23503", error.SqlState);
    }

    [Fact]
    public async Task CancelActiveAsync_QueuedJob_FailsItAsCancelled()
    {
        var (book, job) = await QueuedAsync();

        Assert.True(await _repo.CancelActiveAsync(book.UserId, book.Id, Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Failed, "Cancelled by user"), (read.Status, read.Error));
        Assert.False(await _repo.CancelActiveAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task CancelActiveAsync_ProcessingJob_FailsItToo()
    {
        // As legacy UserBookService.CancelAsync: queued or processing.
        var (book, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1);

        Assert.True(await _repo.CancelActiveAsync(book.UserId, book.Id, Ct));

        Assert.Equal(FileIngestionJob.Failed, (await ReadAsync(job)).Status);
    }

    [Fact]
    public async Task CancelActiveAsync_Bob_LeavesAlicesJobQueued()
    {
        var (alices, job) = await QueuedAsync();

        Assert.False(await _repo.CancelActiveAsync(await db.NewReaderAsync(), alices.Id, Ct));

        Assert.Equal(FileIngestionJob.Queued, (await ReadAsync(job)).Status);
    }

    [Fact]
    public async Task ClaimNextAsync_QueuedJob_StartsItWithOneAttempt()
    {
        await DrainAsync(NothingStuck);
        var (_, job) = await QueuedAsync();

        var claimed = (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct))!;

        Assert.Equal((job.Id, FileIngestionJob.Processing, 1), (claimed.Id, claimed.Status, claimed.AttemptCount));
        Assert.NotNull(claimed.StartedAt);
    }

    [Fact]
    public async Task ClaimNextAsync_TwoQueuedJobs_TakesTheOldestFirst()
    {
        await DrainAsync(NothingStuck);
        var (_, older) = await QueuedAsync();
        await QueuedAsync();

        Assert.Equal(older.Id, (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct))?.Id);
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

    [Fact]
    public async Task ClaimNextAsync_StuckJob_IsReclaimedWithAnotherAttempt()
    {
        await DrainAsync(Stuck);
        var (_, job) = await QueuedAsync();
        await SetAsync(job, Stuck * 2, attempts: 1);

        var claimed = (await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct))!;

        Assert.Equal((job.Id, 2), (claimed.Id, claimed.AttemptCount));
    }

    [Fact]
    public async Task ClaimNextAsync_ProcessingJobStartedJustNow_IsNotReclaimed()
    {
        await DrainAsync(Stuck);
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1);

        Assert.Null(await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct));
    }

    [Fact]
    public async Task ClaimNextAsync_ExhaustedJob_IsLeftForFailExhausted()
    {
        await DrainAsync(Stuck);
        var (_, job) = await QueuedAsync();
        await SetAsync(job, Stuck * 2, attempts: MaxAttempts);

        Assert.Null(await _repo.ClaimNextAsync(MaxAttempts, Stuck, Ct));
    }

    [Fact]
    public async Task FailExhaustedAsync_ExhaustedStuckJob_FailsItWithTheError()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, Stuck * 2, attempts: MaxAttempts);

        var failed = await _repo.FailExhaustedAsync(MaxAttempts, Stuck, "too many attempts", Ct);

        var row = Assert.Single(failed, j => j.Id == job.Id);
        Assert.Equal((FileIngestionJob.Failed, "too many attempts"), (row.Status, row.Error));
        Assert.NotNull(row.FinishedAt);
    }

    [Fact]
    public async Task SucceedAsync_ClaimingRun_FinishesItWithTheFormatAndNoError()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1, error: "an earlier attempt's");

        Assert.True(await _repo.SucceedAsync(job.Id, 1, "epub", Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Succeeded, "epub", (string?)null), (read.Status, read.SourceFormat, read.Error));
        Assert.NotNull(read.FinishedAt);
    }

    [Fact]
    public async Task SucceedAsync_CancelledSinceTheClaim_ReturnsFalseAndStaysFailed()
    {
        var (book, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1);
        await _repo.CancelActiveAsync(book.UserId, book.Id, Ct);

        Assert.False(await _repo.SucceedAsync(job.Id, 1, "epub", Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Failed, "Cancelled by user"), (read.Status, read.Error));
    }

    [Fact]
    public async Task FailAsync_ReclaimedByAnotherRun_ReturnsFalseAndLeavesItProcessing()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 2);

        Assert.False(await _repo.FailAsync(job.Id, 1, "corrupt", null, Ct));

        Assert.Equal(FileIngestionJob.Processing, (await ReadAsync(job)).Status);
    }

    [Fact]
    public async Task FailAsync_NoFormatGiven_KeepsTheRecordedOne()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1, sourceFormat: "pdf");

        Assert.True(await _repo.FailAsync(job.Id, 1, "corrupt", null, Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Failed, "corrupt", "pdf"), (read.Status, read.Error, read.SourceFormat));
    }

    [Fact]
    public async Task ReturnToQueueAsync_ClaimingRun_RequeuesItAndUncountsTheAttempt()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 2);

        Assert.True(await _repo.ReturnToQueueAsync(job.Id, 2, Ct));

        var read = await ReadAsync(job);
        Assert.Equal((FileIngestionJob.Queued, 1, (DateTimeOffset?)null), (read.Status, read.AttemptCount, read.StartedAt));
    }

    [Fact]
    public async Task ReturnToQueueAsync_ReclaimedSince_ReturnsFalse()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 2);

        Assert.False(await _repo.ReturnToQueueAsync(job.Id, 1, Ct));
    }

    [Fact]
    public async Task ReturnToQueueAsync_CancelledSince_ReturnsFalseAndStaysFailed()
    {
        var (_, job) = await QueuedAsync();
        await SetAsync(job, TimeSpan.Zero, attempts: 1, status: FileIngestionJob.Failed);

        Assert.False(await _repo.ReturnToQueueAsync(job.Id, 1, Ct));

        Assert.Equal(FileIngestionJob.Failed, (await ReadAsync(job)).Status);
    }

    [Fact]
    public async Task CountStuckAsync_ProcessingLongerThanTheWindow_CountsIt()
    {
        var before = await _repo.CountStuckAsync(Stuck, Ct);
        var (_, job) = await QueuedAsync();

        await SetAsync(job, Stuck * 2, attempts: 1);

        Assert.Equal(before + 1, await _repo.CountStuckAsync(Stuck, Ct));
    }

    [Fact]
    public async Task CountStuckAsync_FinishedJobStartedLongAgo_IsNotCounted()
    {
        var before = await _repo.CountStuckAsync(Stuck, Ct);
        var (_, job) = await QueuedAsync();

        await SetAsync(job, Stuck * 2, attempts: 1, status: FileIngestionJob.Failed);

        Assert.Equal(before, await _repo.CountStuckAsync(Stuck, Ct));
    }
}
