using Dapper;
using Domain.Library;
using Domain.Transitional;
using Infrastructure.Persistence.Repositories;
using Npgsql;

namespace TextStack.Persistence.Tests.Transitional;

// The claim is cross-user, so the claim tests first drain the queue of every earlier test's jobs, and
// count stuck jobs only at times no other test uses. No other class leaves a job queued (the seed's is finished).
public class IngestionJobRepositoryTests(V2PostgresFixture db)
{
    private readonly IngestionJobRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const int MaxAttempts = 3;
    // Before every job's start, so a claim takes queued jobs only.
    private static readonly DateTimeOffset NothingStuck = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private async Task<(Book Book, FileIngestionJob Job)> QueuedAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        return (book, await _repo.EnqueueAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct));
    }

    private async Task DrainQueueAsync()
    {
        while (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct) is not null) { }
    }

    /// <summary>Puts the job in the state a worker that died at <paramref name="startedAt"/> left it.</summary>
    private async Task StartedAtAsync(FileIngestionJob job, DateTimeOffset startedAt, int attempts)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE ingestion_jobs SET status = 'processing', started_at = @startedAt, attempt_count = @attempts WHERE id = @Id",
            new { job.Id, startedAt, attempts }, cancellationToken: Ct));
    }

    [Fact]
    public async Task EnqueueAsync_File_QueuesAJobWithNoAttempts()
    {
        var (book, job) = await QueuedAsync();

        Assert.Equal((book.UserId, book.Id, FileIngestionJob.Queued, 0), (job.UserId, job.BookId, job.Status, job.AttemptCount));
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
        var (book, _) = await QueuedAsync();

        Assert.True(await _repo.CancelActiveAsync(book.UserId, book.Id, Ct));

        Assert.False(await _repo.CancelActiveAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task CancelActiveAsync_Bob_LeavesAlicesJobQueued()
    {
        var (alices, _) = await QueuedAsync();

        Assert.False(await _repo.CancelActiveAsync(await db.NewReaderAsync(), alices.Id, Ct));
        Assert.True(await _repo.CancelActiveAsync(alices.UserId, alices.Id, Ct));
    }

    [Fact]
    public async Task ClaimNextAsync_QueuedJob_StartsItWithOneAttempt()
    {
        await DrainQueueAsync();
        var (_, job) = await QueuedAsync();

        var claimed = (await _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct))!;

        Assert.Equal((job.Id, FileIngestionJob.Processing, 1), (claimed.Id, claimed.Status, claimed.AttemptCount));
        Assert.NotNull(claimed.StartedAt);
    }

    [Fact]
    public async Task ClaimNextAsync_TwoClaimersOneJob_ExactlyOneGetsIt()
    {
        await DrainQueueAsync();
        var (_, job) = await QueuedAsync();

        var claims = await Task.WhenAll(
            _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct), _repo.ClaimNextAsync(MaxAttempts, NothingStuck, Ct));

        Assert.Equal(job.Id, Assert.Single(claims, c => c is not null)!.Id);
    }

    [Fact]
    public async Task ClaimNextAsync_JobLockedByAnotherClaimer_SkipsItWithoutWaiting()
    {
        await DrainQueueAsync();
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
        await DrainQueueAsync();
        var (_, job) = await QueuedAsync();
        await StartedAtAsync(job, new DateTimeOffset(2006, 1, 1, 0, 0, 0, TimeSpan.Zero), attempts: 1);

        var claimed = (await _repo.ClaimNextAsync(MaxAttempts, new DateTimeOffset(2006, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct))!;

        Assert.Equal((job.Id, 2), (claimed.Id, claimed.AttemptCount));
    }

    [Fact]
    public async Task ClaimNextAsync_ExhaustedJob_IsLeftForFailExhausted()
    {
        await DrainQueueAsync();
        var (_, job) = await QueuedAsync();
        await StartedAtAsync(job, new DateTimeOffset(2007, 1, 1, 0, 0, 0, TimeSpan.Zero), attempts: MaxAttempts);

        Assert.Null(await _repo.ClaimNextAsync(MaxAttempts, new DateTimeOffset(2007, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));
    }

    [Fact]
    public async Task FailExhaustedAsync_ExhaustedStuckJob_FailsItWithTheError()
    {
        var (_, job) = await QueuedAsync();
        await StartedAtAsync(job, new DateTimeOffset(2008, 1, 1, 0, 0, 0, TimeSpan.Zero), attempts: MaxAttempts);

        var failed = await _repo.FailExhaustedAsync(MaxAttempts, new DateTimeOffset(2008, 1, 2, 0, 0, 0, TimeSpan.Zero), "too many attempts", Ct);

        var row = Assert.Single(failed, j => j.Id == job.Id);
        Assert.Equal((FileIngestionJob.Failed, "too many attempts"), (row.Status, row.Error));
        Assert.NotNull(row.FinishedAt);
    }

    [Fact]
    public async Task SucceedAsync_ClaimedJob_FinishesItWithTheFormat()
    {
        var (book, job) = await QueuedAsync();

        Assert.True(await _repo.SucceedAsync(job.Id, "epub", Ct));

        Assert.Equal(1L, await CountAsync(book, "status = 'succeeded' AND source_format = 'epub' AND finished_at IS NOT NULL"));
    }

    [Fact]
    public async Task FailAsync_ClaimedJob_FinishesItWithTheError()
    {
        var (book, job) = await QueuedAsync();

        Assert.True(await _repo.FailAsync(job.Id, "corrupt", "pdf", Ct));

        Assert.Equal(1L, await CountAsync(book, "status = 'failed' AND error = 'corrupt' AND source_format = 'pdf'"));
    }

    [Fact]
    public async Task ReturnToQueueAsync_ClaimingRun_RequeuesItAndUncountsTheAttempt()
    {
        var (book, job) = await QueuedAsync();
        await StartedAtAsync(job, DateTimeOffset.UtcNow, attempts: 2);

        Assert.True(await _repo.ReturnToQueueAsync(job.Id, 2, Ct));

        Assert.Equal(1L, await CountAsync(book, "status = 'queued' AND attempt_count = 1 AND started_at IS NULL"));
    }

    [Fact]
    public async Task ReturnToQueueAsync_ReclaimedSince_ReturnsFalse()
    {
        var (_, job) = await QueuedAsync();
        await StartedAtAsync(job, DateTimeOffset.UtcNow, attempts: 2);

        Assert.False(await _repo.ReturnToQueueAsync(job.Id, 1, Ct));
    }

    [Fact]
    public async Task CountStuckAsync_ProcessingSinceBeforeTheCutoff_CountsIt()
    {
        var cutoff = new DateTimeOffset(2009, 1, 2, 0, 0, 0, TimeSpan.Zero);
        // Other tests of this class leave older stuck jobs behind: the count is relative.
        var before = await _repo.CountStuckAsync(cutoff, Ct);
        var (_, job) = await QueuedAsync();

        await StartedAtAsync(job, cutoff.AddDays(-1), attempts: 1);

        Assert.Equal(before + 1, await _repo.CountStuckAsync(cutoff, Ct));
    }

    private async Task<long> CountAsync(Book book, string condition)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            $"SELECT count(*) FROM ingestion_jobs WHERE user_id = @UserId AND book_id = @Id AND {condition}", book, cancellationToken: Ct));
    }
}
