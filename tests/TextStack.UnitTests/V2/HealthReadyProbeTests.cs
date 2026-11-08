using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace TextStack.UnitTests.V2;

/// <summary>
/// /health/ready's write probes (#1110), in process. No database here, so the status code is 503 either
/// way; the code is pinned in TextStack.IntegrationTests' HealthReadyLibraryTests. This pins the race.
/// </summary>
public sealed class HealthReadyProbeTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "health-probe-" + Guid.NewGuid());

    private string StorageRoot => Path.Combine(_dir, "storage");

    private string LibraryRoot => Path.Combine(_dir, "library");

    public HealthReadyProbeTests()
    {
        Directory.CreateDirectory(StorageRoot);
        Directory.CreateDirectory(LibraryRoot);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task HealthReady_TwentyConcurrentProbes_AllOkAndNoProbeFileLeft()
    {
        var ct = TestContext.Current.CancellationToken;
        using var api = new WebApplicationFactory<Api.ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("Jwt:SecretKey", TestTokens.Secret);
            b.UseSetting("Jwt:Issuer", TestTokens.Issuer);
            b.UseSetting("Storage:RootPath", StorageRoot);
            b.UseSetting("Storage:LibraryRoot", LibraryRoot);
            b.ConfigureTestServices(s => s.RemoveAll<IHostedService>());
        });
        var client = api.CreateClient();

        var bodies = await Task.WhenAll(Enumerable.Range(0, 20).Select(async _ =>
        {
            using var response = await client.GetAsync("/health/ready", ct);
            return await response.Content.ReadFromJsonAsync<JsonElement>(ct);
        }));

        foreach (var body in bodies)
        {
            var components = body.GetProperty("components");
            Assert.Equal("ok", components.GetProperty("storage").GetProperty("status").GetString());
            Assert.Equal("ok", components.GetProperty("library").GetProperty("status").GetString());
        }
        Assert.Empty(Directory.EnumerateFiles(_dir, ".health-probe*", SearchOption.AllDirectories));
    }
}
