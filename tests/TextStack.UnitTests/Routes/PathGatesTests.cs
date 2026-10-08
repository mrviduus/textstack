using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Text;
using Api.Middleware;
using Application.Auth;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace TextStack.UnitTests.Routes;

/// <summary>
/// ADR-024 gates in isolation: behind them sit endpoints that check NOTHING, so any 200 an anonymous
/// or off-network request gets here is a gate bypass, not a handler that happened to save the day.
/// </summary>
public class PathGatesTests : IAsyncLifetime
{
    private const string Secret = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh";
    private const string Issuer = "textstack.app";
    private const string FakeKeyHeader = "X-Test-Resolved-Key";

    private static readonly IPAddress DockerPeer = IPAddress.Parse("172.18.0.5");
    private static readonly IPAddress Outsider = IPAddress.Parse("203.0.113.7");

    private WebApplication _app = null!;
    private TestServer _server = null!;

    public async ValueTask InitializeAsync()
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        builder.Services.AddScoped(_ => new AuthService(
            db: null!,
            jwtSettings: Options.Create(new JwtSettings { SecretKey = Secret, Issuer = Issuer }),
            googleSettings: Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" })));

        _app = builder.Build();
        _app.UseRouting();
        // Stands in for McpKeyAuthMiddleware: a resolved connect key / OAuth token lands on Items.
        _app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Headers.TryGetValue(FakeKeyHeader, out var id))
                ctx.Items[McpKeyAuthMiddleware.UserIdItemKey] = Guid.Parse(id!);
            await next(ctx);
        });
        _app.UsePathGates();
        _app.MapMethods("/me/x", ["GET", "POST", "OPTIONS"], () => "open");
        _app.MapGet("/me", () => "open");
        _app.MapGet("/internal/x", () => "open");
        _app.MapGet("/public", () => "open");
        _app.MapGet("/mega", () => "open");
        await _app.StartAsync();
        _server = _app.GetTestServer();
    }

    public async ValueTask DisposeAsync() => await _app.DisposeAsync();

    private Task<HttpContext> Send(string path, string method = "GET", IPAddress? remote = null,
        Action<HttpRequest>? configure = null) =>
        _server.SendAsync(ctx =>
        {
            ctx.Request.Method = method;
            ctx.Request.Path = new PathString(path);
            ctx.Connection.RemoteIpAddress = remote ?? Outsider;
            configure?.Invoke(ctx.Request);
        }, TestContext.Current.CancellationToken);

    private static string Token(Guid userId, string secret = Secret)
    {
        var token = new JwtSecurityToken(
            issuer: Issuer,
            audience: JwtSettings.UserAudience,
            claims: [new Claim(ClaimTypes.NameIdentifier, userId.ToString())],
            expires: DateTime.UtcNow.AddMinutes(5),
            signingCredentials: new SigningCredentials(
                new SymmetricSecurityKey(Encoding.UTF8.GetBytes(secret)), SecurityAlgorithms.HmacSha256));
        return new JwtSecurityTokenHandler().WriteToken(token);
    }

    [Theory]
    [InlineData("/me")]
    [InlineData("/me/x")]
    [InlineData("/ME/x")]
    [InlineData("/Me/X")]
    [InlineData("/me/x/")]
    public async Task Me_Anonymous_Returns401(string path)
    {
        var ctx = await Send(path);
        Assert.Equal(401, ctx.Response.StatusCode);
    }

    /// <summary>Spellings the gate does not match must not match the route either: 404, never 200.</summary>
    [Theory]
    [InlineData("//me/x")]
    [InlineData("/me%2Fx")]
    [InlineData("/me%2fx")]
    [InlineData("/%6De/x")]
    public async Task Me_OddSpellings_Anonymous_NeverReachTheEndpoint(string path)
    {
        var ctx = await Send(path);
        Assert.NotEqual(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_PrefixOfAnotherSegment_IsNotGated()
    {
        // "/mega" is not under "/me": segment match, not string prefix.
        var ctx = await Send("/mega");
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_Options_PassesForCorsPreflight()
    {
        var ctx = await Send("/me/x", "OPTIONS");
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Theory]
    [InlineData("GET")]
    [InlineData("POST")]
    public async Task Me_BearerJwt_PassesThrough(string method)
    {
        var token = Token(Guid.NewGuid());
        var ctx = await Send("/me/x", method, configure: r => r.Headers.Authorization = $"Bearer {token}");
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_LowercaseBearerScheme_PassesThrough()
    {
        var token = Token(Guid.NewGuid());
        var ctx = await Send("/me/x", configure: r => r.Headers.Authorization = $"bearer {token}");
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_CookieJwt_PassesThrough()
    {
        var token = Token(Guid.NewGuid());
        var ctx = await Send("/me/x", configure: r => r.Headers.Cookie = $"access_token={token}");
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_ResolvedConnectKeyOrOAuthToken_PassesThrough()
    {
        var ctx = await Send("/me/x", configure: r => r.Headers[FakeKeyHeader] = Guid.NewGuid().ToString());
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_JwtSignedWithAnotherKey_Returns401()
    {
        var token = Token(Guid.NewGuid(), secret: "a-DIFFERENT-signing-key-long-enough-for-hmac-sha256-xyz");
        var ctx = await Send("/me/x", configure: r => r.Headers.Authorization = $"Bearer {token}");
        Assert.Equal(401, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Me_UnresolvedKeyShapedBearer_Returns401()
    {
        // McpKeyAuth found no live key, so Items is empty and the bearer is not a JWT.
        var ctx = await Send("/me/x", configure: r => r.Headers.Authorization = "Bearer tsk_unknown");
        Assert.Equal(401, ctx.Response.StatusCode);
    }

    [Theory]
    [InlineData("/internal/x")]
    [InlineData("/INTERNAL/x")]
    public async Task Internal_FromOutside_Returns403(string path)
    {
        var ctx = await Send(path, remote: Outsider);
        Assert.Equal(403, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Internal_WithNoRemoteAddress_Returns403()
    {
        var ctx = await _server.SendAsync(c => c.Request.Path = "/internal/x", TestContext.Current.CancellationToken);
        Assert.Equal(403, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Internal_FromDockerNetwork_PassesThrough()
    {
        var ctx = await Send("/internal/x", remote: DockerPeer);
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Internal_FromLoopback_PassesThrough()
    {
        var ctx = await Send("/internal/x", remote: IPAddress.Loopback);
        Assert.Equal(200, ctx.Response.StatusCode);
    }

    [Fact]
    public async Task Public_Anonymous_FromOutside_IsUntouched()
    {
        var ctx = await Send("/public");
        Assert.Equal(200, ctx.Response.StatusCode);
    }
}
