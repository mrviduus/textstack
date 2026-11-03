using System.Diagnostics;
using System.Reflection;
using Application.Identity;
using Infrastructure.Persistence.Legacy;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// The Worker's container as its <c>Program</c> builds it, what <c>V2GateTests</c> is for the Api: no
/// runtime database switch before M5.1 (#1100), so every identity port is its legacy EF adapter and no
/// V2 auth type resolves.
/// </summary>
public class WorkerContainerTests
{
    [Theory]
    [InlineData(typeof(IUserRepository), typeof(EfUserRepository))]
    [InlineData(typeof(ISessionTokenRepository), typeof(EfSessionTokenRepository))]
    [InlineData(typeof(IOAuthRepository), typeof(EfOAuthRepository))]
    [InlineData(typeof(IDeviceLoginRepository), typeof(EfDeviceLoginRepository))]
    [InlineData(typeof(IMcpKeyRepository), typeof(EfMcpKeyRepository))]
    public void WorkerContainer_V2On_IdentityPortIsTheLegacyAdapter(Type port, Type adapter)
    {
        using var scope = WorkerServices().CreateScope();

        Assert.IsType(adapter, scope.ServiceProvider.GetRequiredService(port));
    }

    [Fact]
    public void WorkerContainer_V2On_ResolvesNoV2AuthService()
    {
        using var scope = WorkerServices().CreateScope();

        // The Worker signs nobody in (it binds no JwtSettings): it must not even know the V2 services.
        foreach (var type in new[] { typeof(V2AuthService), typeof(V2AdminAuthService) })
            Assert.Null(scope.ServiceProvider.GetService(type));
    }

    // Unique, so the host this test stops is the Worker's and not one another test builds meanwhile.
    private const string ApplicationName = "TextStack.WorkerContainerTests";

    private static readonly string StorageRoot = Path.Combine(Path.GetTempPath(), "textstack-worker-container");

    private sealed class HostCaught : Exception;

    /// <summary>
    /// Runs the Worker's entry point and takes its host the moment it is built, before it runs (the
    /// hosting diagnostics event <c>HostBuilt</c>, as the test host factories do). Only the Worker's own
    /// host is stopped: other tests build hosts in parallel.
    /// </summary>
    private static IServiceProvider WorkerServices()
    {
        IHost? worker = null;
        using var listeners = DiagnosticListener.AllListeners.Subscribe(new Observer<DiagnosticListener>(listener =>
        {
            if (listener.Name != "Microsoft.Extensions.Hosting") return;
            listener.Subscribe(new Observer<KeyValuePair<string, object?>>(e =>
            {
                if (e is { Key: "HostBuilt", Value: IHost host }
                    && host.Services.GetService<IHostEnvironment>()?.ApplicationName == ApplicationName)
                {
                    worker = host;
                    throw new HostCaught();
                }
            }));
        }));
        try
        {
            typeof(HeartbeatWorker).Assembly.EntryPoint!.Invoke(null, [new[]
            {
                "--environment=Production", $"--applicationName={ApplicationName}", "--Features:V2Api=true", $"--Storage:RootPath={StorageRoot}",
                // Port 1: should the host ever run, nothing it opens reaches a real database.
                "--ConnectionStrings:Default=Host=127.0.0.1;Port=1;Database=none;Timeout=1",
                "--ConnectionStrings:V2=Host=127.0.0.1;Port=1;Database=none;Timeout=1",
            }]);
        }
        catch (TargetInvocationException e) when (e.InnerException is HostCaught)
        {
        }
        return worker?.Services ?? throw new InvalidOperationException("The Worker built no host");
    }

    private sealed class Observer<T>(Action<T> onNext) : IObserver<T>
    {
        public void OnNext(T value) => onNext(value);
        public void OnError(Exception error) { }
        public void OnCompleted() { }
    }
}
