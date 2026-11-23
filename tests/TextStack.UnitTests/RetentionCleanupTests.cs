using Application.Identity;
using Application.Library;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily retention sweep deletes only rows past their rule, never a live one; the library's
/// bytes go on their own cadence: stale upload parts every tick, orphans daily.</summary>
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
            .AddScoped<Infrastructure.Persistence.Repositories.AgentRunWriter>(_ =>
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

    private static ServiceProvider LibraryServices(ILibraryRepository library, ILibraryFileStore files) =>
        new ServiceCollection().AddSingleton(library).AddSingleton(files).BuildServiceProvider();

    [Fact]
    public async Task CleanupAsync_OldBytesNoRowNames_DeletedOnTheClocksCutoffs()
    {
        var clock = new SteppedClock();
        var cutoff = clock.Now - TimeSpan.FromHours(1);
        var (library, files) = (Substitute.For<ILibraryRepository>(), Substitute.For<ILibraryFileStore>());
        library.AllStorageKeysAsync(Arg.Any<CancellationToken>()).Returns(new HashSet<string> { "library/kept.epub" });
        files.EnumerateLibraryFilesOlderThan(cutoff).Returns(["library/kept.epub", "library/busy.epub", "library/orphan.epub", "library/stale.tmp"]);
        files.TryDelete(Arg.Any<string>()).Returns(true);
        files.TryDelete("library/busy.epub").Returns(false);
        var orphansSwept = new TaskCompletionSource();
        files.When(f => f.RemoveEmptyDirectories(Arg.Any<DateTimeOffset>())).Do(_ => orphansSwept.TrySetResult());
        await using var services = LibraryServices(library, files);
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance, clock);

        await worker.StartAsync(TestContext.Current.CancellationToken);
        await orphansSwept.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await worker.StopAsync(TestContext.Current.CancellationToken);

        // Upload parts: swept against now.
        files.Received(1).SweepStaleParts(clock.Now);
        // Orphans: a failed delete does not stop the rest; a named file is never touched; empty dirs go last.
        Received.InOrder(() =>
        {
            files.TryDelete("library/busy.epub");
            files.TryDelete("library/orphan.epub");
            files.TryDelete("library/stale.tmp");
            files.RemoveEmptyDirectories(cutoff);
        });
        files.DidNotReceive().TryDelete("library/kept.epub");
    }

    [Fact]
    public async Task ExecuteAsync_TicksAndADayPasses_PartsSweptEveryTickOrphansOncePerDay()
    {
        var clock = new SteppedClock();
        var (library, files) = (Substitute.For<ILibraryRepository>(), Substitute.For<ILibraryFileStore>());
        library.AllStorageKeysAsync(Arg.Any<CancellationToken>()).Returns(new HashSet<string>());
        files.EnumerateLibraryFilesOlderThan(Arg.Any<DateTimeOffset>()).Returns([]);
        int parts = 0, orphans = 0;
        files.When(f => f.SweepStaleParts(Arg.Any<DateTimeOffset>())).Do(_ => Interlocked.Increment(ref parts));
        files.When(f => f.RemoveEmptyDirectories(Arg.Any<DateTimeOffset>())).Do(_ => Interlocked.Increment(ref orphans));
        await using var services = LibraryServices(library, files);
        using var worker = new RetentionCleanupWorker(services.GetRequiredService<IServiceScopeFactory>(), NullLogger<RetentionCleanupWorker>.Instance, clock)
        { Tick = TimeSpan.FromMilliseconds(10) };
        var ct = TestContext.Current.CancellationToken;

        await worker.StartAsync(ct);
        for (var waited = 0; waited < 5000 && Volatile.Read(ref parts) < 3; waited += 10) await Task.Delay(10, ct);
        var orphansBeforeADay = Volatile.Read(ref orphans);
        clock.Now += TimeSpan.FromDays(1);
        for (var waited = 0; waited < 5000 && Volatile.Read(ref orphans) < 2; waited += 10) await Task.Delay(10, ct);
        await worker.StopAsync(ct);

        Assert.True(parts >= 3);
        Assert.Equal(1, orphansBeforeADay); // the daily rules ran on the first tick only
        Assert.Equal(2, orphans);           // and again on the first tick a day later
    }
}
