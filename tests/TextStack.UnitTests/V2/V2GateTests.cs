using System.Diagnostics;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Api.Sites;
using Api.V2;
using Application.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests.V2;

/// <summary>
/// #1053, in process: V2 that is off, unconfigured or unreachable answers on <c>/me/v2</c> only, and
/// never changes <c>/health/ready</c>'s status code. A healthy stack cannot produce the 503, so it is
/// pinned here rather than in the integration suite.
/// </summary>
public class V2GateTests
{
    private const string Secret = "unit-test-secret-key-of-at-least-32-bytes";
    // Port 1: nothing listens, so a connection attempt fails at once.
    private const string Unreachable = "Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=2";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class AnySite : ISiteResolver
    {
        public Task<SiteContext?> ResolveAsync(string host, CancellationToken ct = default) =>
            Task.FromResult<SiteContext?>(new SiteContext(Guid.Empty, "general", host, "en", "default", false, false, false, "{}"));

        public void InvalidateCache() { }
    }

    private static WebApplicationFactory<Api.ApiMarker> Api(bool v2Api, string? v2ConnectionString) =>
        new WebApplicationFactory<Api.ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("Jwt:SecretKey", Secret);
            b.UseSetting("Features:V2Api", v2Api ? "true" : "false");
            b.UseSetting("ConnectionStrings:V2", v2ConnectionString);
            b.UseSetting("Storage:RootPath", Path.Combine(Path.GetTempPath(), "textstack-v2-gate"));
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<IHostedService>();
                s.RemoveAll<ISiteResolver>();
                s.AddSingleton<ISiteResolver, AnySite>();
            });
        });

    private static Task<HttpResponseMessage> GetStatusAsync(WebApplicationFactory<Api.ApiMarker> api, bool withSession = true) =>
        SendAsync(api, new HttpRequestMessage(HttpMethod.Get, "/me/v2/status"), withSession);

    private static async Task<HttpResponseMessage> SendAsync(WebApplicationFactory<Api.ApiMarker> api, HttpRequestMessage request, bool withSession = true)
    {
        if (withSession)
        {
            var jwt = api.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<JwtSettings>>().Value;
            var token = new JwtSecurityToken(jwt.Issuer, JwtSettings.UserAudience, [new Claim(ClaimTypes.NameIdentifier, Guid.NewGuid().ToString())],
                expires: DateTime.UtcNow.AddMinutes(5),
                signingCredentials: new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(Secret)), SecurityAlgorithms.HmacSha256));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", new JwtSecurityTokenHandler().WriteToken(token));
        }
        return await api.CreateClient().SendAsync(request, Ct);
    }

    private static async Task<(HttpStatusCode Status, JsonElement V2)> GetReadyAsync(WebApplicationFactory<Api.ApiMarker> api)
    {
        using var response = await api.CreateClient().GetAsync("/health/ready", Ct);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        return (response.StatusCode, body.GetProperty("components").GetProperty("v2"));
    }

    [Fact]
    public async Task Status_FlagOff_IsNotFoundWithASession()
    {
        await using var api = Api(v2Api: false, Unreachable);

        Assert.Equal(HttpStatusCode.NotFound, (await GetStatusAsync(api)).StatusCode);
        Assert.Equal("off", (await GetReadyAsync(api)).V2.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Status_FlagOnWithoutASession_IsUnauthorized()
    {
        await using var api = Api(v2Api: true, null);

        Assert.Equal(HttpStatusCode.Unauthorized, (await GetStatusAsync(api, withSession: false)).StatusCode);
    }

    [Theory]
    [InlineData(null, V2State.Unconfigured)]
    [InlineData(Unreachable, V2State.Unreachable)]
    public async Task Status_FlagOnAndV2NotThere_IsV2UnavailableWithRetryAfter(string? v2ConnectionString, string expected)
    {
        await using var api = Api(v2Api: true, v2ConnectionString);

        using var response = await GetStatusAsync(api);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("v2_unavailable", (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("code").GetString());
        Assert.Equal(TimeSpan.FromSeconds(30), response.Headers.RetryAfter!.Delta);
        Assert.Equal(expected, (await GetReadyAsync(api)).V2.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Import_FlagOnWithoutV2_IsV2UnavailableNotAServerError()
    {
        await using var api = Api(v2Api: true, null);
        var request = new HttpRequestMessage(HttpMethod.Put, $"/me/v2/books/{Guid.NewGuid()}") { Content = JsonContent.Create(new { title = "A book" }) };

        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await SendAsync(api, request)).StatusCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(Unreachable)]
    public async Task HealthReady_V2NotThere_HasTheStatusCodeOfAStackWithoutV2(string? v2ConnectionString)
    {
        await using var without = Api(v2Api: false, null);
        await using var broken = Api(v2Api: true, v2ConnectionString);
        var expected = (await GetReadyAsync(without)).Status;

        var watch = Stopwatch.StartNew();
        var (status, _) = await GetReadyAsync(broken);

        Assert.Equal(expected, status);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"the probe took {watch.Elapsed}");
    }

    [Fact]
    public async Task GetAsync_WithinTheTtl_SharesOneCheckAndAfterItChecksAgain()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection([new("ConnectionStrings:V2", Unreachable)]).Build();
        await using var services = new ServiceCollection().AddSingleton(new Infrastructure.Persistence.V2DataSource(Unreachable)).BuildServiceProvider();
        var clock = new SteppedClock();
        var readiness = new V2Readiness(config, services, clock, NullLogger<V2Readiness>.Instance);

        var first = readiness.GetAsync();
        clock.Now += V2Readiness.Ttl - TimeSpan.FromSeconds(1);
        var cached = readiness.GetAsync();
        clock.Now += TimeSpan.FromSeconds(1);
        var fresh = readiness.GetAsync();

        Assert.Same(first, cached);
        Assert.NotSame(first, fresh);
        Assert.Equal(V2State.Unreachable, (await fresh).Status);
    }
}
