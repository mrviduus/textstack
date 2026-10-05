using Application.Common.Interfaces;
using Application.Ingestion;
using Domain.Entities;
using Domain.Enums;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A catalog job that crashes the worker is re-picked as "stuck" — but only until it has used
/// <see cref="IngestionService.MaxAttempts"/>; then it ends Failed instead of looping forever.
/// </summary>
public class IngestionRetryCapTests
{
    private readonly List<IngestionJob> _jobs = [];
    private readonly IngestionService _service;

    public IngestionRetryCapTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.IngestionJobs).Returns(() => new FakeDbSet<IngestionJob>(_jobs));
        _service = new IngestionService(db.Object, Mock.Of<IFileStorageService>(), NullLogger<IngestionService>.Instance);
    }

    private IngestionJob AddJob(JobStatus status, int attempts, DateTimeOffset? startedAt = null)
    {
        var job = new IngestionJob
        {
            Id = Guid.NewGuid(),
            TargetLanguage = "en",
            Status = status,
            AttemptCount = attempts,
            StartedAt = startedAt,
            CreatedAt = DateTimeOffset.UtcNow.AddHours(-1),
        };
        _jobs.Add(job);
        return job;
    }

    [Fact]
    public async Task GetNextJobAsync_StuckJobUnderCap_IsRepicked()
    {
        var job = AddJob(JobStatus.Processing, attempts: 2, DateTimeOffset.UtcNow.AddMinutes(-30));

        var next = await _service.GetNextJobAsync(CancellationToken.None);

        Assert.Same(job, next);
        Assert.Equal(JobStatus.Processing, job.Status);
    }

    [Fact]
    public async Task GetNextJobAsync_StuckJobAtCap_MarkedFailedAndNotPicked()
    {
        var job = AddJob(JobStatus.Processing, attempts: IngestionService.MaxAttempts, DateTimeOffset.UtcNow.AddMinutes(-30));

        var next = await _service.GetNextJobAsync(CancellationToken.None);

        Assert.Null(next);
        Assert.Equal(JobStatus.Failed, job.Status);
        Assert.Equal(IngestionService.ExceededAttemptsError, job.Error);
        Assert.NotNull(job.FinishedAt);
    }

    [Fact]
    public async Task GetNextJobAsync_RunningJobAtCapNotYetStuck_LeftAlone()
    {
        var job = AddJob(JobStatus.Processing, attempts: IngestionService.MaxAttempts, DateTimeOffset.UtcNow.AddMinutes(-1));

        var next = await _service.GetNextJobAsync(CancellationToken.None);

        Assert.Null(next);
        Assert.Equal(JobStatus.Processing, job.Status);
    }

    [Fact]
    public async Task ResetJobForRetryAsync_FailedAtCap_ResetsAttemptsSoItIsPickedAgain()
    {
        var job = AddJob(JobStatus.Failed, attempts: IngestionService.MaxAttempts);

        await _service.ResetJobForRetryAsync(job, CancellationToken.None);
        var next = await _service.GetNextJobAsync(CancellationToken.None);

        Assert.Equal(0, job.AttemptCount);
        Assert.Same(job, next);
    }
}
