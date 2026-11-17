using Application.Auth;
using Application.Identity;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Legacy;
using Infrastructure.Persistence.Repositories;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Worker.Services;

namespace TextStack.UnitTests;

public class DatabaseModeTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("legacy", false)]
    [InlineData("V2", true)]
    public void Read_KnownMode_SelectsOnce(string? value, bool expected)
    {
        Assert.Equal(expected, DatabaseMode.Read(Config(value)).IsV2);
    }

    [Theory]
    [InlineData("")]
    [InlineData("v3")]
    [InlineData(" legacy")]
    public void Read_Typo_FailsInsteadOfFallingBack(string value) =>
        Assert.Throws<InvalidOperationException>(() => DatabaseMode.Read(Config(value)));

    [Theory]
    [InlineData(false, "Host=127.0.0.1;Port=1")]
    [InlineData(true, null)]
    [InlineData(true, " ")]
    public void Read_V2MissingPrerequisite_FailsStartup(bool flag, string? connection) =>
        Assert.Throws<InvalidOperationException>(() => DatabaseMode.Read(Config("v2", flag, connection)));

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IdentityPorts_ChooseAllFiveTogether_WithoutConnecting(bool v2)
    {
        var services = new ServiceCollection();
        services.AddTextStackDataAccess("Host=127.0.0.1;Port=1;Database=legacy", "Host=127.0.0.1;Port=1;Database=v2");
        services.AddSelectedIdentityPorts(new(v2));
        Type[] contracts = [typeof(IUserRepository), typeof(ISessionTokenRepository), typeof(IOAuthRepository), typeof(IDeviceLoginRepository), typeof(IMcpKeyRepository)];
        Type[] native = [typeof(UserRepository), typeof(SessionTokenRepository), typeof(OAuthRepository), typeof(DeviceLoginRepository), typeof(McpKeyRepository)];
        Type[] legacy = [typeof(EfUserRepository), typeof(EfSessionTokenRepository), typeof(EfOAuthRepository), typeof(EfDeviceLoginRepository), typeof(EfMcpKeyRepository)];
        // Resolve native singleton ports with an unreachable pool: selection itself performs no I/O.
        using var provider = services.BuildServiceProvider();
        for (var i = 0; i < contracts.Length; i++)
        {
            var registration = Assert.Single(services, s => s.ServiceType == contracts[i]);
            if (v2) Assert.Equal(native[i], provider.GetRequiredService(contracts[i]).GetType());
            else Assert.Equal(legacy[i], registration.ImplementationType);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void WorkerLoops_NativeModeNeverStartsLegacyConsumers(bool v2)
    {
        var services = new ServiceCollection();
        services.AddSelectedWorkerLoops(Config(v2 ? "v2" : "legacy"), new(v2), "Host=127.0.0.1;Port=1");
        var loops = services.Where(s => s.ServiceType == typeof(IHostedService)).ToArray();
        Assert.NotNull(loops[0].ImplementationFactory); // SingleInstanceLock is registered first.
        Assert.Contains(loops, s => s.ImplementationType == typeof(V2IngestionWorker));
        Assert.Contains(loops, s => s.ImplementationType == typeof(RetentionCleanupWorker));
        foreach (var type in new[] { typeof(MetadataEnrichmentWorker), typeof(GuestCleanupWorker) })
            Assert.Equal(!v2, loops.Any(s => s.ImplementationType == type));
    }

    private static IConfiguration Config(string? mode, bool flag = true, string? connection = "Host=127.0.0.1;Port=1") =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [DatabaseMode.ConfigurationKey] = mode,
            ["Features:V2Api"] = flag.ToString(),
            ["ConnectionStrings:V2"] = connection,
        }).Build();
}
