using Api.Middleware;
using Api.V2;
using Application.Auth;
using Application.Identity;
using Domain.Enums;
using Domain.Identity;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Moq;

namespace TextStack.UnitTests;

public class SelectedDatabaseGuardTests
{
    private sealed class Clock(DateTimeOffset now) : TimeProvider { public override DateTimeOffset GetUtcNow() => now; }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ResetWithinOneSecond_RejectsOldTokenAndAcceptsNewToken(bool admin)
    {
        var second = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddSeconds(-5).ToUnixTimeSeconds());
        var id = Guid.NewGuid();
        var account = new UserAccount { Id = id, Role = admin ? UserAccount.AdminRole : UserAccount.ReaderRole, CredentialsResetAt = second.AddMilliseconds(500) };
        foreach (var millis in new[] { 200, 700 })
        {
            var tokens = new JwtTokens(new JwtSettings { SecretKey = TestTokens.Secret, Issuer = TestTokens.Issuer }, new Clock(second.AddMilliseconds(millis)));
            var raw = admin ? tokens.MintAdminAccessToken(id, "admin@test", AdminRole.Admin, 15) : tokens.MintAccessToken(id, "reader@test", null, false);
            var http = Request(admin ? "/admin/auth/me/" : "/auth/me/", tokens);
            if (admin) http.Request.Headers.Cookie = "admin_access_token=" + raw;
            else http.Request.Headers.Authorization = "Bearer " + raw;
            var users = new Mock<IUserRepository>();
            users.Setup(u => u.GetAsync(id, It.IsAny<CancellationToken>())).ReturnsAsync(account);
            var auth = new Mock<IAuthService>();
            auth.Setup(a => a.ValidateAccessTokenIdentity(It.IsAny<string>())).Returns((string value) => tokens.ValidateAccessToken(value));
            var reached = false;

            await new SelectedDatabaseGuard(_ => { reached = true; return Task.CompletedTask; }, new(true)).InvokeAsync(http, auth.Object, users.Object);

            Assert.Equal(millis == 700, reached);
            Assert.Equal(millis == 700 ? 200 : 401, http.Response.StatusCode);
        }
    }

    [Theory]
    [InlineData("/auth/guest", true)]
    [InlineData("/auth/me", false)]
    public async Task GoneAccountToken_OnlyGuestSessionCreationPasses(string path, bool expectedReached)
    {
        var tokens = new JwtTokens(new JwtSettings { SecretKey = TestTokens.Secret, Issuer = TestTokens.Issuer });
        var http = Request(path, tokens);
        http.Request.Method = path == "/auth/guest" ? "POST" : "GET";
        http.Request.Headers.Authorization = "Bearer " + tokens.MintAccessToken(Guid.NewGuid(), "gone@test", null, false);
        var auth = new Mock<IAuthService>();
        auth.Setup(a => a.ValidateAccessTokenIdentity(It.IsAny<string>())).Returns((string value) => tokens.ValidateAccessToken(value));
        var users = new Mock<IUserRepository>(); // every account is gone
        var reached = false;

        await new SelectedDatabaseGuard(_ => { reached = true; return Task.CompletedTask; }, new(true)).InvokeAsync(http, auth.Object, users.Object);

        Assert.Equal(expectedReached, reached);
        Assert.Equal(expectedReached ? 200 : 401, http.Response.StatusCode);
    }

    [Theory]
    [InlineData("GET", "/me/books/{id:guid}", "/me/books/7d2c0c56-8f5e-4a0e-9a59-0b1c1f0e0a11", 410)]
    [InlineData("DELETE", "/me/books/{id:guid}", "/me/books/7d2c0c56-8f5e-4a0e-9a59-0b1c1f0e0a11", 410)]
    [InlineData("PUT", "/me/progress/{editionId:guid}", "/me/progress/7d2c0c56-8f5e-4a0e-9a59-0b1c1f0e0a11", 410)]
    [InlineData("POST", "/admin/editions/{id:guid}/publish", "/admin/editions/7d2c0c56-8f5e-4a0e-9a59-0b1c1f0e0a11/publish", 410)]
    [InlineData("GET", "/me/reading/stats", "/me/reading/stats", 410)]
    [InlineData("GET", "/me/library/shelves", "/me/library/shelves", 410)]
    [InlineData("GET", "/me/highlights/all", "/me/highlights/all", 410)]
    [InlineData("POST", "/explain/", "/explain", 503)]
    [InlineData("POST", "/translate", "/translate", 503)]
    public async Task UnadaptedNativeRoute_IsGoneOrPendingBeforeAnyUserLookup(string method, string pattern, string path, int expected)
    {
        var http = Request(path, null, selected: false, pattern: pattern);
        http.Request.Method = method;
        var reached = false;
        var users = new Mock<IUserRepository>(MockBehavior.Strict);

        await new SelectedDatabaseGuard(_ => { reached = true; return Task.CompletedTask; }, new(true))
            .InvokeAsync(http, Mock.Of<IAuthService>(), users.Object);

        Assert.False(reached);
        Assert.Equal(expected, http.Response.StatusCode);
        http.Response.Body.Position = 0;
        Assert.Contains(expected == 410 ? "gone_in_v2" : "v2_compatibility_pending", new StreamReader(http.Response.Body).ReadToEnd());
        users.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task GoneRoute_LogsRouteAppVersionAndOutcome()
    {
        var http = Request("/me/bookmarks", null, selected: false, pattern: "/me/bookmarks");
        http.Request.Headers[Api.Middleware.AppVersionMiddleware.VersionHeader] = "1.4.2";
        var logger = new ListLogger();

        await new SelectedDatabaseGuard(_ => Task.CompletedTask, new(true), logger)
            .InvokeAsync(http, Mock.Of<IAuthService>(), Mock.Of<IUserRepository>());

        Assert.Equal(410, http.Response.StatusCode);
        var line = Assert.Single(logger.Lines);
        Assert.Contains("GET /me/bookmarks", line);
        Assert.Contains("1.4.2", line);
        Assert.Contains("410", line);
    }

    [Fact]
    public void Pending_EveryLineIsARealRoute()
    {
        var routes = TextStack.Tests.Routes.ApiRouteTable.Routes.Select(r => r.ToString()).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.All(SelectedDatabaseGuard.Pending, p => Assert.Contains(p, routes));
    }

    private sealed class ListLogger : Microsoft.Extensions.Logging.ILogger<SelectedDatabaseGuard>
    {
        public List<string> Lines { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(Microsoft.Extensions.Logging.LogLevel logLevel) => true;
        public void Log<TState>(Microsoft.Extensions.Logging.LogLevel logLevel, Microsoft.Extensions.Logging.EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add(formatter(state, exception));
    }

    [Fact]
    public async Task LegacyMode_DoesNotQueryV2()
    {
        var http = Request("/me/books", null, selected: false);
        var reached = false;
        var users = new Mock<IUserRepository>(MockBehavior.Strict);
        await new SelectedDatabaseGuard(_ => { reached = true; return Task.CompletedTask; }, new(false))
            .InvokeAsync(http, Mock.Of<IAuthService>(), users.Object);
        Assert.True(reached);
        users.VerifyNoOtherCalls();
    }

    private static DefaultHttpContext Request(string path, JwtTokens? tokens, bool selected = true, string? pattern = null)
    {
        if (pattern is not null)
        {
            var routed = Request(path, tokens, selected);
            routed.SetEndpoint(new Microsoft.AspNetCore.Routing.RouteEndpoint(_ => Task.CompletedTask,
                Microsoft.AspNetCore.Routing.Patterns.RoutePatternFactory.Parse(pattern), 0, EndpointMetadataCollection.Empty, "test"));
            return routed;
        }
        var services = new ServiceCollection();
        if (tokens is not null) services.AddSingleton(tokens);
        var http = new DefaultHttpContext { RequestServices = services.BuildServiceProvider() };
        http.Request.Path = path;
        http.Request.Method = "GET";
        http.Response.Body = new MemoryStream();
        http.SetEndpoint(new Endpoint(_ => Task.CompletedTask, new EndpointMetadataCollection(selected ? [V2SelectedRoute.Instance] : Array.Empty<object>()), "test"));
        return http;
    }
}
