using Domain.Entities;
using Domain.Enums;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Worker.Services;
using CatalogIngestion = Application.Ingestion.IngestionService;

namespace TextStack.UnitTests;

/// <summary>
/// ADR-022: a graceful shutdown (every deploy restarts the Worker) gives the claim back — Queued, the
/// attempt not counted — instead of failing the job and telling the reader the file is corrupted.
/// The set-based give-back runs on Sqlite through a context that maps only the three queue tables.
/// </summary>
public class ShutdownRequeueTests : IDisposable
{
    private sealed class Ctx(DbContextOptions<Ctx> options) : DbContext(options)
    {
        public DbSet<IngestionJob> IngestionJobs => Set<IngestionJob>();
        public DbSet<UserIngestionJob> UserIngestionJobs => Set<UserIngestionJob>();
        public DbSet<UserBook> UserBooks => Set<UserBook>();

        protected override void OnModelCreating(ModelBuilder b)
        {
            b.Entity<IngestionJob>(e =>
            {
                e.Ignore(x => x.Edition); e.Ignore(x => x.BookFile); e.Ignore(x => x.Work); e.Ignore(x => x.SourceEdition);
            });
            b.Entity<UserIngestionJob>(e => { e.Ignore(x => x.UserBook); e.Ignore(x => x.UserBookFile); });
            b.Entity<UserBook>(e =>
            {
                e.Ignore(x => x.User); e.Ignore(x => x.Chapters); e.Ignore(x => x.BookFiles); e.Ignore(x => x.IngestionJobs);
            });
        }
    }

    private readonly SqliteConnection _conn = new("Filename=:memory:");
    private readonly Ctx _db;

    public ShutdownRequeueTests()
    {
        _conn.Open();
        _db = new Ctx(new DbContextOptionsBuilder<Ctx>().UseSqlite(_conn).Options);
        _db.Database.EnsureCreated();
    }

    public void Dispose()
    {
        _db.Dispose();
        _conn.Dispose();
    }

    private T Seed<T>(T entity) where T : class
    {
        _db.Add(entity);
        _db.SaveChanges();
        _db.ChangeTracker.Clear();
        return entity;
    }

    private static IngestionJob CatalogJob(JobStatus status, int attempts) => new()
    {
        Id = Guid.NewGuid(),
        TargetLanguage = "en",
        Status = status,
        AttemptCount = attempts,
        StartedAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };

    private static UserIngestionJob UserJob(JobStatus status, int attempts) => new()
    {
        Id = Guid.NewGuid(),
        Status = status,
        AttemptCount = attempts,
        StartedAt = DateTimeOffset.UtcNow,
        CreatedAt = DateTimeOffset.UtcNow,
    };

    [Fact]
    public async Task ReturnToQueueAsync_CatalogJobInFlight_QueuedAttemptNotCounted()
    {
        var job = Seed(CatalogJob(JobStatus.Processing, attempts: 1));

        var n = await CatalogIngestion.ReturnToQueueAsync(_db.IngestionJobs, job.Id, claimedAttempt: 1);

        var row = await _db.IngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, n);
        Assert.Equal(JobStatus.Queued, row.Status);
        Assert.Equal(0, row.AttemptCount);
        Assert.Null(row.StartedAt);
        Assert.Null(row.Error);
    }

    [Fact]
    public async Task ReturnToQueueAsync_UserJobInFlight_QueuedAttemptNotCounted()
    {
        var job = Seed(UserJob(JobStatus.Processing, attempts: 1));

        var n = await UserIngestionService.ReturnToQueueAsync(_db.UserIngestionJobs, job.Id, claimedAttempt: 1);

        var row = await _db.UserIngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, n);
        Assert.Equal(JobStatus.Queued, row.Status);
        Assert.Equal(0, row.AttemptCount);
        Assert.Null(row.StartedAt);
        Assert.Null(row.Error);
    }

    [Fact]
    public async Task ReturnToQueueAsync_StaleRepickInterruptedBeforeClaimCommitted_CrashedAttemptStaysCounted()
    {
        // A crash left it Processing at 1. The stale re-pick bumped it to 2 in memory, but the shutdown
        // cancelled that save. Giving back would un-count the crash and let a poison file loop forever.
        var job = Seed(UserJob(JobStatus.Processing, attempts: 1));

        var n = await UserIngestionService.ReturnToQueueAsync(_db.UserIngestionJobs, job.Id, claimedAttempt: 2);

        var row = await _db.UserIngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(0, n);
        Assert.Equal(JobStatus.Processing, row.Status);
        Assert.Equal(1, row.AttemptCount);
    }

    [Fact]
    public async Task ReturnToQueueAsync_StaleRepickInterruptedAfterClaim_OnlyThisAttemptGivenBack()
    {
        var job = Seed(CatalogJob(JobStatus.Processing, attempts: 2)); // crash (1) + this claim (2)

        await CatalogIngestion.ReturnToQueueAsync(_db.IngestionJobs, job.Id, claimedAttempt: 2);

        var row = await _db.IngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(JobStatus.Queued, row.Status);
        Assert.Equal(1, row.AttemptCount);
    }

    [Theory]
    [InlineData(JobStatus.Succeeded)]
    [InlineData(JobStatus.Failed)]
    public async Task ReturnToQueueAsync_JobAlreadyFinished_LeftAlone(JobStatus status)
    {
        var job = Seed(UserJob(status, attempts: 1));

        var n = await UserIngestionService.ReturnToQueueAsync(_db.UserIngestionJobs, job.Id, claimedAttempt: 1);

        var row = await _db.UserIngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(0, n);
        Assert.Equal(status, row.Status);
        Assert.Equal(1, row.AttemptCount);
    }

    [Fact]
    public async Task ReturnToQueueAsync_MoreDeploysThanTheCap_JobNeverExhausted()
    {
        var job = Seed(UserJob(JobStatus.Queued, attempts: 0));

        for (var deploy = 0; deploy < CatalogIngestion.MaxAttempts + 2; deploy++)
        {
            // The claim, as ProcessJobAsync makes it.
            var claimed = await _db.UserIngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
            claimed.Status = JobStatus.Processing;
            claimed.AttemptCount++;
            await _db.SaveChangesAsync(TestContext.Current.CancellationToken);
            _db.ChangeTracker.Clear();

            await UserIngestionService.ReturnToQueueAsync(_db.UserIngestionJobs, job.Id, claimed.AttemptCount);
        }

        var row = await _db.UserIngestionJobs.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(JobStatus.Queued, row.Status);
        Assert.Equal(0, row.AttemptCount);
    }

    private UserBook Book(MetadataEnrichmentStatus status) => Seed(new UserBook
    {
        Id = Guid.NewGuid(),
        Title = "t",
        Slug = "t",
        Language = "en",
        Status = UserBookStatus.Ready,
        MetadataEnrichmentStatus = status,
    });

    [Fact]
    public async Task ReturnClaimAsync_EnrichmentInFlight_BackToPending()
    {
        var book = Book(MetadataEnrichmentStatus.Running);

        var n = await UserBookEnrichmentService.ReturnClaimAsync(_db.UserBooks, book.Id);

        var row = await _db.UserBooks.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(1, n);
        Assert.Equal(MetadataEnrichmentStatus.Pending, row.MetadataEnrichmentStatus);
        Assert.Equal(UserBookStatus.Ready, row.Status);
    }

    [Theory]
    [InlineData(MetadataEnrichmentStatus.Completed)]
    [InlineData(MetadataEnrichmentStatus.Failed)]
    public async Task ReturnClaimAsync_EnrichmentFinished_LeftAlone(MetadataEnrichmentStatus status)
    {
        var book = Book(status);

        var n = await UserBookEnrichmentService.ReturnClaimAsync(_db.UserBooks, book.Id);

        var row = await _db.UserBooks.SingleAsync(TestContext.Current.CancellationToken);
        Assert.Equal(0, n);
        Assert.Equal(status, row.MetadataEnrichmentStatus);
    }
}
