using System.Diagnostics;
using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Api.Sync;
using Application.Identity;
using Infrastructure.Persistence.Repositories;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests.Sync;

/// <summary>
/// #1053, in process: V2 that is unconfigured or unreachable answers <c>/me/v2</c> with 503 <c>v2_unavailable</c>.
/// A healthy stack cannot produce the 503, so it is pinned here rather than in the integration suite.
/// </summary>
public class SyncGateTests
{
    // Port 1: nothing listens, so a connection attempt fails at once.
    private const string Unreachable = "Host=127.0.0.1;Port=1;Database=textstack_v2;Timeout=2";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // A writable library root: with V2 on, an unwritable one is a 503 of its own (#1110), and these
    // tests pin what V2's database does to the status code, nothing else. The default /library is
    // not writable on a CI runner.
    private static readonly string LibraryRoot =
        Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "textstack-v2-gate-library")).FullName;

    private static WebApplicationFactory<Api.ApiMarker> Api(string? v2ConnectionString) =>
        new WebApplicationFactory<Api.ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("Jwt:SecretKey", TestTokens.Secret);
            b.UseSetting("Jwt:Issuer", TestTokens.Issuer);
            b.UseSetting("ConnectionStrings:V2", v2ConnectionString);
            b.UseSetting("Storage:RootPath", Path.Combine(Path.GetTempPath(), "textstack-v2-gate"));
            b.UseSetting("Storage:LibraryRoot", LibraryRoot);
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<IHostedService>();
            });
        });

    private static Task<HttpResponseMessage> GetStatusAsync(WebApplicationFactory<Api.ApiMarker> api, bool withSession = true) =>
        SendAsync(api, new HttpRequestMessage(HttpMethod.Get, "/me/v2/status"), withSession);

    private static async Task<HttpResponseMessage> SendAsync(WebApplicationFactory<Api.ApiMarker> api, HttpRequestMessage request, bool withSession = true)
    {
        if (withSession)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", TestTokens.Token(Guid.NewGuid()));
        return await api.CreateClient().SendAsync(request, Ct);
    }

    private static async Task<(HttpStatusCode Status, JsonElement V2)> GetReadyAsync(WebApplicationFactory<Api.ApiMarker> api)
    {
        using var response = await api.CreateClient().GetAsync("/health/ready", Ct);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        return (response.StatusCode, body.GetProperty("components").GetProperty("v2"));
    }

    [Theory]
    [InlineData(typeof(IUserRepository), typeof(UserRepository))]
    [InlineData(typeof(ISessionTokenRepository), typeof(SessionTokenRepository))]
    [InlineData(typeof(IOAuthRepository), typeof(OAuthRepository))]
    [InlineData(typeof(IDeviceLoginRepository), typeof(DeviceLoginRepository))]
    [InlineData(typeof(IMcpKeyRepository), typeof(McpKeyRepository))]
    [InlineData(typeof(IAuthService), typeof(AuthService))]
    [InlineData(typeof(IAdminAuthService), typeof(AdminAuthService))]
    public void ApiContainer_IdentityPort_IsTheV2Implementation(Type port, Type implementation)
    {
        using var api = Api(Unreachable);
        using var scope = api.Services.CreateScope();

        Assert.IsType(implementation, scope.ServiceProvider.GetRequiredService(port));
    }

    [Fact]
    public async Task Status_WithoutASession_IsUnauthorized()
    {
        await using var api = Api(null);

        Assert.Equal(HttpStatusCode.Unauthorized, (await GetStatusAsync(api, withSession: false)).StatusCode);
    }

    [Fact]
    public async Task Status_V2Unreachable_IsV2UnavailableWithRetryAfter()
    {
        await using var api = Api(Unreachable);

        using var response = await GetStatusAsync(api);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("v2_unavailable", (await response.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("code").GetString());
        Assert.Equal(TimeSpan.FromSeconds(30), response.Headers.RetryAfter!.Delta);
        Assert.Equal(ReadinessState.Unreachable, (await GetReadyAsync(api)).V2.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Import_V2Unreachable_IsV2UnavailableNotAServerError()
    {
        await using var api = Api(Unreachable);
        var request = new HttpRequestMessage(HttpMethod.Put, $"/me/v2/books/{Guid.NewGuid()}") { Content = JsonContent.Create(new { title = "A book" }) };

        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await SendAsync(api, request)).StatusCode);
    }
}
