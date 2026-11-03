using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily retention sweep deletes only rows past their rule, never a live one.</summary>
public class RetentionCleanupTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task CleanupAsync_CredentialSweeps_EachGetsADayPastNow()
    {
        // The identity ports sweep with the cutoff they are given (their contract tests); the grace is the worker's.
        var sessions = new Mock<ISessionTokenRepository>();
        var devices = new Mock<IDeviceLoginRepository>();
        var oauth = new Mock<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        oauth.Setup(o => o.DeleteDeadGrantsAsync(It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()))
            .Callback(lastSweep.SetResult).ReturnsAsync(0);
        await using var services = new ServiceCollection()
            .AddScoped(_ => Mock.Of<IAppDbContext>())
            .AddScoped(_ => sessions.Object)
            .AddScoped(_ => devices.Object)
            .AddScoped(_ => oauth.Object)
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance);
        var before = DateTimeOffset.UtcNow - RetentionCleanupWorker.TokenGrace;

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        var after = DateTimeOffset.UtcNow - RetentionCleanupWorker.TokenGrace;
        Func<DateTimeOffset, bool> atGrace = cutoff => cutoff >= before && cutoff <= after;
        sessions.Verify(s => s.DeleteExpiredSessionsAsync(It.Is<DateTimeOffset>(c => atGrace(c)), It.IsAny<CancellationToken>()), Times.Once);
        sessions.Verify(s => s.DeleteExpiredPasswordResetsAsync(It.Is<DateTimeOffset>(c => atGrace(c)), It.IsAny<CancellationToken>()), Times.Once);
        devices.Verify(d => d.DeleteExpiredAsync(It.Is<DateTimeOffset>(c => atGrace(c)), It.IsAny<CancellationToken>()), Times.Once);
        oauth.Verify(o => o.DeleteDeadGrantsAsync(It.Is<DateTimeOffset>(c => atGrace(c)), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task CleanupAsync_APortMissing_TheOtherRulesStillRun()
    {
        var oauth = new Mock<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        oauth.Setup(o => o.DeleteDeadGrantsAsync(It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()))
            .Callback(lastSweep.SetResult).ReturnsAsync(0);
        var devices = new Mock<IDeviceLoginRepository>();
        // No ISessionTokenRepository: its two rules fail, logged, and the rest go on.
        await using var services = new ServiceCollection()
            .AddScoped(_ => Mock.Of<IAppDbContext>())
            .AddScoped(_ => devices.Object)
            .AddScoped(_ => oauth.Object)
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        devices.Verify(d => d.DeleteExpiredAsync(It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    private static bool IsOldSsgJob(DateTimeOffset? finishedAt) =>
        RetentionCleanupWorker.OldSsgRebuildJob(Now).Compile()(
            new SsgRebuildJob { CreatedAt = Now.AddYears(-1), FinishedAt = finishedAt });

    [Fact]
    public void OldSsgRebuildJob_FinishedLongAgo_Deleted() =>
        Assert.True(IsOldSsgJob(Now.AddDays(-31)));

    [Fact]
    public void OldSsgRebuildJob_NeverFinished_Kept() =>
        Assert.False(IsOldSsgJob(null));

    [Fact]
    public void OldSsgRebuildJob_FinishedRecently_Kept() =>
        Assert.False(IsOldSsgJob(Now.AddDays(-29)));

    private static bool IsOldTutorSession(DateTimeOffset updatedAt) =>
        RetentionCleanupWorker.OldTutorSession(Now).Compile()(
            new TutorSession { PlanJson = "{}", UpdatedAt = updatedAt });

    [Fact]
    public void OldTutorSession_IdleOver90Days_Deleted() =>
        Assert.True(IsOldTutorSession(Now.AddDays(-91)));

    [Fact]
    public void OldTutorSession_UsedRecently_Kept() =>
        Assert.False(IsOldTutorSession(Now.AddDays(-89)));

    private static LlmTrace Trace(DateTimeOffset createdAt, string messages = "[{\"role\":\"user\"}]", string? response = "text") =>
        new() { FeatureTag = "f", ModelId = "m", PromptHash = "h", MessagesJson = messages, ResponseText = response, CreatedAt = createdAt };

    [Fact]
    public void LlmTraceTextToScrub_OldWithText_Selected()
    {
        var rule = RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile();
        Assert.True(rule(Trace(Now.AddDays(-31))));
    }

    [Fact]
    public void LlmTraceTextToScrub_Recent_Kept() =>
        Assert.False(RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile()(Trace(Now.AddDays(-29))));

    [Fact]
    public void LlmTraceTextToScrub_AlreadyScrubbed_NotRewrittenDaily() =>
        Assert.False(RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile()(
            Trace(Now.AddDays(-31), RetentionCleanupWorker.ScrubbedMessages, response: null)));

    private static AgentRun Run(DateTimeOffset at) =>
        new() { Agent = "a", Goal = "g", Status = "done", StepsJson = "[]", CreatedAt = at };

    [Fact]
    public void OldAgentRun_Over30Days_Deleted() =>
        Assert.True(RetentionCleanupWorker.OldAgentRun(Now).Compile()(Run(Now.AddDays(-31))));

    [Fact]
    public void OldAgentRun_Recent_Kept() =>
        Assert.False(RetentionCleanupWorker.OldAgentRun(Now).Compile()(Run(Now.AddDays(-29))));
}
