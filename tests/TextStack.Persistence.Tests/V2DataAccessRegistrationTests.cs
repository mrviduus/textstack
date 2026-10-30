using Application.Library;
using Application.Reading;
using Infrastructure.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace TextStack.Persistence.Tests;

/// <summary>
/// V1 must keep serving while V2 is broken or absent (docs/incidents/2026-10-30-migrator-v2-took-down-the-api.md):
/// without <c>ConnectionStrings:V2</c> nothing V2 is registered, and with it nothing connects until used.
/// </summary>
public class V2DataAccessRegistrationTests
{
    private const string Legacy = "Host=localhost;Database=legacy";

    [Fact]
    public async Task AddTextStackDataAccess_NoV2ConnectionString_RegistersNoV2Services()
    {
        await using var services = new ServiceCollection().AddTextStackDataAccess(Legacy, null).BuildServiceProvider();

        Assert.Null(services.GetService<V2DataSource>());
        Assert.Null(services.GetService<ILibraryRepository>());
        Assert.Null(services.GetService<IReadingStateRepository>());
    }

    [Fact]
    public async Task AddTextStackDataAccess_UnreachableV2Database_ResolvesWithoutConnecting()
    {
        // Port 1: nothing listens there, so any connection attempt would throw.
        await using var services = new ServiceCollection()
            .AddTextStackDataAccess(Legacy, "Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=1")
            .BuildServiceProvider();

        Assert.NotNull(services.GetService<ILibraryRepository>());
        Assert.NotNull(services.GetService<IReadingStateRepository>());
    }
}
