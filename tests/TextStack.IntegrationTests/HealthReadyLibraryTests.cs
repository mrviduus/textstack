using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace TextStack.IntegrationTests;

/// <summary>
/// /health/ready's <c>library</c> component (#1110), the Api in process on the migrated database
/// (TEST_DB_CONNECTION, skipped without it): critical with Features:V2Api on, only reported with it off.
/// </summary>
public sealed class HealthReadyLibraryTests : IDisposable
{
    private static string? DbConn => Environment.GetEnvironmentVariable("TEST_DB_CONNECTION");

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "health-library-" + Guid.NewGuid());

    public HealthReadyLibraryTests() => Directory.CreateDirectory(Path.Combine(_dir, "storage"));

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
    }

    /// <summary>Below a regular file, so no one, root included, can create anything there.</summary>
    private string UnavailableLibrary()
    {
        var file = Path.Combine(_dir, "not-a-dir");
        File.WriteAllText(file, "");
        return Path.Combine(file, "library");
    }

    private async Task<(HttpStatusCode Status, JsonElement Components)> ReadyAsync(bool v2Api, string libraryRoot)
    {
        var ct = TestContext.Current.CancellationToken;
        using var api = new WebApplicationFactory<Api.ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("ConnectionStrings:Default", DbConn);
            b.UseSetting("Features:V2Api", v2Api ? "true" : "false");
            b.UseSetting("Storage:RootPath", Path.Combine(_dir, "storage"));
            b.UseSetting("Storage:LibraryRoot", libraryRoot);
            b.UseSetting("Jwt:SecretKey", "health-library-tests-secret-at-least-32-chars"); // auth is resolved per request
            b.ConfigureTestServices(s => s.RemoveAll<IHostedService>());
        });
        using var response = await api.CreateClient().GetAsync("/health/ready", ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        var body = JsonSerializer.Deserialize<JsonElement>(text);
        Assert.True(body.TryGetProperty("components", out var components), $"{(int)response.StatusCode}: {text}");
        return (response.StatusCode, components);
    }

    [Fact]
    public async Task HealthReady_V2OffLibraryUnavailable_OkWithLibraryReportedDown()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");

        var (status, components) = await ReadyAsync(v2Api: false, UnavailableLibrary());

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("down", components.GetProperty("library").GetProperty("status").GetString());
    }

    [Fact]
    public async Task HealthReady_V2OnLibraryUnavailable_ServiceUnavailable()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");

        var (status, components) = await ReadyAsync(v2Api: true, UnavailableLibrary());

        Assert.Equal(HttpStatusCode.ServiceUnavailable, status);
        Assert.Equal("down", components.GetProperty("library").GetProperty("status").GetString());
        Assert.Equal("ok", components.GetProperty("schema").GetProperty("status").GetString()); // the library alone made it 503
    }

    [Fact]
    public async Task HealthReady_V2OnLibraryWritable_Ok()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        var library = Path.Combine(_dir, "library");
        Directory.CreateDirectory(library);

        var (status, components) = await ReadyAsync(v2Api: true, library);

        Assert.Equal(HttpStatusCode.OK, status);
        Assert.Equal("ok", components.GetProperty("library").GetProperty("status").GetString());
    }
}
