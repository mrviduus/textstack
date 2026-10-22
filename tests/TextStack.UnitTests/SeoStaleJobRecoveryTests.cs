using Application.Auth;
using Application.Common.Interfaces;
using Application.Seo;
using Domain.Entities;
using Domain.Enums;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// A Running SEO job whose poller died is re-queued after <see cref="SeoJobProcessor.StaleAfter"/> until
/// <see cref="SeoJobProcessor.MaxAttempts"/>, then ends Failed — instead of staying Running and blocking the entity.
/// </summary>
public class SeoStaleJobRecoveryTests : IDisposable
{
    // ExecuteUpdate needs a real provider; SQLite is enough for the status transitions. Postgres-only array
    // columns are ignored. The claim's FOR UPDATE SKIP LOCKED is not covered here.
    private sealed class Ctx(DbContextOptions<Ctx> o) : DbContext(o)
    {
        public DbSet<SeoBackfillJob> Jobs => Set<SeoBackfillJob>();

        // SQLite can't compare DateTimeOffset in SQL; store as ticks so the sweep's `started_at < cutoff` runs.
        protected override void ConfigureConventions(ModelConfigurationBuilder c) =>
            c.Properties<DateTimeOffset>().HaveConversion<DateTimeOffsetToBinaryConverter>();

        protected override void OnModelCreating(ModelBuilder b) =>
            b.Entity<SeoBackfillJob>(e =>
            {
                e.Ignore(x => x.TargetFields);
                e.Ignore(x => x.TemplateIds);
                e.Ignore(x => x.TemplateVersions);
            });
    }

    private readonly SqliteConnection _conn = new("Data Source=:memory:");
    private readonly Ctx _ctx;
    private readonly SeoJobProcessor _processor;

    public SeoStaleJobRecoveryTests()
    {
        _conn.Open();
        _ctx = new Ctx(new DbContextOptionsBuilder<Ctx>().UseSqlite(_conn).Options);
        _ctx.Database.EnsureCreated();
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.SeoBackfillJobs).Returns(_ctx.Jobs);
        _processor = new SeoJobProcessor(db.Object, null!, null!, Mock.Of<IEmailService>());
    }

    public void Dispose()
    {
        _ctx.Dispose();
        _conn.Dispose();
    }

    private Guid AddJob(SeoJobStatus status, int attempts, TimeSpan? runningFor)
    {
        var job = new SeoBackfillJob
        {
            Id = Guid.NewGuid(),
            TargetFields = [],
            TemplateIds = [],
            TemplateVersions = [],
            Status = status,
            AttemptCount = attempts,
            StartedAt = runningFor is null ? null : DateTimeOffset.UtcNow - runningFor,
        };
        _ctx.Jobs.Add(job);
        _ctx.SaveChanges();
        return job.Id;
    }

    private SeoBackfillJob Reload(Guid id) => _ctx.Jobs.AsNoTracking().Single(j => j.Id == id);

    [Fact]
    public async Task RecoverStaleAsync_StaleRunningUnderCap_RequeuedForNextClaim()
    {
        var id = AddJob(SeoJobStatus.Running, attempts: 1, SeoJobProcessor.StaleAfter + TimeSpan.FromMinutes(1));

        await _processor.RecoverStaleAsync(CancellationToken.None);
        var job = Reload(id);

        Assert.Equal(SeoJobStatus.Queued, job.Status);
        Assert.Null(job.StartedAt);
        Assert.Equal(1, job.AttemptCount);
    }

    [Fact]
    public async Task RecoverStaleAsync_StaleRunningAtCap_FailedWithError()
    {
        var id = AddJob(SeoJobStatus.Running, SeoJobProcessor.MaxAttempts, SeoJobProcessor.StaleAfter + TimeSpan.FromMinutes(1));

        await _processor.RecoverStaleAsync(CancellationToken.None);
        var job = Reload(id);

        Assert.Equal(SeoJobStatus.Failed, job.Status);
        Assert.Equal(SeoJobProcessor.ExceededAttemptsError, job.Error);
        Assert.NotNull(job.CompletedAt);
    }

    [Fact]
    public async Task RecoverStaleAsync_RunningWithinWindow_LeftAlone()
    {
        var id = AddJob(SeoJobStatus.Running, attempts: 1, TimeSpan.FromMinutes(5));

        await _processor.RecoverStaleAsync(CancellationToken.None);
        var job = Reload(id);

        Assert.Equal(SeoJobStatus.Running, job.Status);
        Assert.NotNull(job.StartedAt);
    }

    [Fact]
    public async Task RecoverStaleAsync_NonRunningJobs_Untouched()
    {
        var queuedId = AddJob(SeoJobStatus.Queued, attempts: 0, runningFor: null);
        var doneId = AddJob(SeoJobStatus.Success, attempts: 1, SeoJobProcessor.StaleAfter + TimeSpan.FromHours(5));

        await _processor.RecoverStaleAsync(CancellationToken.None);

        Assert.Equal(SeoJobStatus.Queued, Reload(queuedId).Status);
        Assert.Equal(SeoJobStatus.Success, Reload(doneId).Status);
    }
}
