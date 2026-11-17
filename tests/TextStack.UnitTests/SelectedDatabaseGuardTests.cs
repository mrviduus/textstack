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
    [InlineData("GET", "/me/books")]
    [InlineData("DELETE", "/me/books/book")]
    [InlineData("POST", "/translate")]
    public async Task UnadaptedNativeRoute_Is503BeforeAnyUserLookup(string method, string path)
    {
        var http = Request(path, null, selected: false);
        http.Request.Method = method;
        var reached = false;
        var users = new Mock<IUserRepository>(MockBehavior.Strict);

        await new SelectedDatabaseGuard(_ => { reached = true; return Task.CompletedTask; }, new(true))
            .InvokeAsync(http, Mock.Of<IAuthService>(), users.Object);

        Assert.False(reached);
        Assert.Equal(503, http.Response.StatusCode);
        users.VerifyNoOtherCalls();
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

    private static DefaultHttpContext Request(string path, JwtTokens? tokens, bool selected = true)
    {
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
