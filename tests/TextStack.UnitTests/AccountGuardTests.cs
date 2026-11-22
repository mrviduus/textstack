using Api.Middleware;
using Application.Identity;
using Domain.Enums;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace TextStack.UnitTests;

public class AccountGuardTests
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
            var users = Substitute.For<IUserRepository>();
            users.GetAsync(id, Arg.Any<CancellationToken>()).Returns(account);
            var auth = Substitute.For<IAuthService>();
            auth.ValidateAccessTokenIdentity(Arg.Any<string>()).Returns(c => tokens.ValidateAccessToken(c.Arg<string>()));
            var reached = false;

            await new AccountGuard(_ => { reached = true; return Task.CompletedTask; }).InvokeAsync(http, auth, users);

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
        var auth = Substitute.For<IAuthService>();
        auth.ValidateAccessTokenIdentity(Arg.Any<string>()).Returns(c => tokens.ValidateAccessToken(c.Arg<string>()));
        var users = Substitute.For<IUserRepository>(); // every account is gone
        var reached = false;

        await new AccountGuard(_ => { reached = true; return Task.CompletedTask; }).InvokeAsync(http, auth, users);

        Assert.Equal(expectedReached, reached);
        Assert.Equal(expectedReached ? 200 : 401, http.Response.StatusCode);
    }

    private static DefaultHttpContext Request(string path, JwtTokens? tokens)
    {
        var services = new ServiceCollection();
        if (tokens is not null) services.AddSingleton(tokens);
        var http = new DefaultHttpContext { RequestServices = services.BuildServiceProvider() };
        http.Request.Path = path;
        http.Request.Method = "GET";
        http.Response.Body = new MemoryStream();
        return http;
    }
}
