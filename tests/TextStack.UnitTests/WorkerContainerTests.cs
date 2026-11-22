using System.Diagnostics;
using System.Reflection;
using Application.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>
/// The Worker's container as its <c>Program</c> builds it, what <c>SyncGateTests</c> is for the Api: every
/// identity port is its V2 repository, and no auth service resolves (the Worker signs nobody in).
/// </summary>
public class WorkerContainerTests
{
    [Theory]
    [InlineData(typeof(IUserRepository), typeof(UserRepository))]
    [InlineData(typeof(ISessionTokenRepository), typeof(SessionTokenRepository))]
    [InlineData(typeof(IOAuthRepository), typeof(OAuthRepository))]
    [InlineData(typeof(IDeviceLoginRepository), typeof(DeviceLoginRepository))]
    [InlineData(typeof(IMcpKeyRepository), typeof(McpKeyRepository))]
    public void WorkerContainer_IdentityPort_IsTheV2Repository(Type port, Type adapter)
    {
        using var scope = WorkerServices().CreateScope();

        Assert.IsType(adapter, scope.ServiceProvider.GetRequiredService(port));
    }

    [Fact]
    public void WorkerContainer_ResolvesNoAuthService()
    {
        using var scope = WorkerServices().CreateScope();

        // The Worker signs nobody in (it binds no JwtSettings): it must not even know the V2 services.
        foreach (var type in new[] { typeof(AuthService), typeof(AdminAuthService) })
            Assert.Null(scope.ServiceProvider.GetService(type));
    }

    [Fact]
    public void WorkerHost_Development_PassesDiValidation()
    {
        // Development turns on ValidateOnBuild + ValidateScopes: Build() throws if any registration
        // cannot resolve (#1108), so reaching the built host is the assertion.
        var services = WorkerServices("Development");

        Assert.True(services.GetRequiredService<IHostEnvironment>().IsDevelopment());
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
    private static IServiceProvider WorkerServices(string environment = "Production")
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
                $"--environment={environment}", $"--applicationName={ApplicationName}", $"--Storage:RootPath={StorageRoot}",
                // Port 1: should the host ever run, nothing it opens reaches a real database.
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
