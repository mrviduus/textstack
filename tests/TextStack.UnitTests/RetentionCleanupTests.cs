using Application.Identity;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily retention sweep deletes only rows past their rule, never a live one.</summary>
public class RetentionCleanupTests
{
    [Fact]
    public async Task CleanupAsync_CredentialPortsThenAiSweeps_AllRulesRun()
    {
        var oauth = Substitute.For<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        await using var services = new ServiceCollection()
            .AddScoped(_ => Substitute.For<ISessionTokenRepository>())
            .AddScoped(_ => Substitute.For<IDeviceLoginRepository>())
            .AddScoped(_ => oauth)
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

        await oauth.Received(1).DeleteDeadGrantsAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CleanupAsync_CredentialSweeps_EachGetsADayPastNow()
    {
        // The identity ports sweep with the cutoff they are given (their contract tests); the grace is the worker's.
        var clock = new SteppedClock();
        var cutoff = clock.Now - RetentionCleanupWorker.TokenGrace;
        var sessions = Substitute.For<ISessionTokenRepository>();
        var devices = Substitute.For<IDeviceLoginRepository>();
        var oauth = Substitute.For<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        oauth.DeleteDeadGrantsAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(_ => { lastSweep.SetResult(); return 0; });
        await using var services = new ServiceCollection()
            .AddScoped(_ => sessions)
            .AddScoped(_ => devices)
            .AddScoped(_ => oauth)
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance, clock);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        await sessions.Received(1).DeleteExpiredSessionsAsync(cutoff, Arg.Any<CancellationToken>());
        await sessions.Received(1).DeleteExpiredPasswordResetsAsync(cutoff, Arg.Any<CancellationToken>());
        await devices.Received(1).DeleteExpiredAsync(cutoff, Arg.Any<CancellationToken>());
        await oauth.Received(1).DeleteDeadGrantsAsync(cutoff, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task CleanupAsync_APortMissing_TheOtherRulesStillRun()
    {
        var oauth = Substitute.For<IOAuthRepository>();
        var lastSweep = new TaskCompletionSource();
        oauth.DeleteDeadGrantsAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(_ => { lastSweep.SetResult(); return 0; });
        var devices = Substitute.For<IDeviceLoginRepository>();
        // No ISessionTokenRepository: its two rules fail, logged, and the rest go on.
        await using var services = new ServiceCollection()
            .AddScoped(_ => devices)
            .AddScoped(_ => oauth)
            .BuildServiceProvider();
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await lastSweep.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        await devices.Received(1).DeleteExpiredAsync(Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
    }
}
