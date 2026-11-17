using Application.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily retention sweep deletes only rows past their rule, never a live one.</summary>
public class RetentionCleanupTests
{
    [Fact]
    public async Task CleanupAsync_CredentialPortsThenAiSweeps_AllRulesRun()
    {
        var oauth = new Mock<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        await using var services = new ServiceCollection()
            .AddScoped(_ => Mock.Of<ISessionTokenRepository>())
            .AddScoped(_ => Mock.Of<IDeviceLoginRepository>())
            .AddScoped(_ => oauth.Object)
            // The last V2 rule: resolving its writer marks the end of the sweep (the failure is logged).
            .AddScoped<Infrastructure.Persistence.Repositories.V2AgentRunWriter>(_ =>
            {
                lastSweep.TrySetResult();
                throw new InvalidOperationException("no V2 database in a unit test");
            })
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        oauth.Verify(o => o.DeleteDeadGrantsAsync(It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()), Times.Once);
    }

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
            .AddScoped(_ => devices.Object)
            .AddScoped(_ => oauth.Object)
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        devices.Verify(d => d.DeleteExpiredAsync(It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()), Times.Once);
    }
}
