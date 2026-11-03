using Api.Extensions;
using Api.Middleware;
using Application.Auth;
using Application.Identity;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// The request-level identity paths on the ports (#1100): the guest activity stamp, the connect key's
/// throttled use stamp, and the access token's <c>iat</c> as every endpoint reads it.
/// </summary>
public class IdentityMiddlewareTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly AuthService Auth = new(
        null!,
        Options.Create(new JwtSettings { SecretKey = TestTokens.Secret, Issuer = TestTokens.Issuer }),
        Options.Create(new GoogleSettings { ClientId = "unused.apps.googleusercontent.com" }));

    private static DefaultHttpContext Request(string bearer, Action<IServiceCollection>? services = null)
    {
        var collection = new ServiceCollection();
        services?.Invoke(collection);
        var http = new DefaultHttpContext { RequestServices = collection.BuildServiceProvider() };
        http.Request.Headers.Authorization = $"Bearer {bearer}";
        return http;
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task GuestActivity_GuestOrAccountToken_StampsGuestsOnly(bool isGuest)
    {
        var users = new Mock<IUserRepository>();
        var userId = Guid.NewGuid();
        var http = Request(TestTokens.Token(userId, guestClaim: isGuest), s => s.AddSingleton(users.Object));

        await new GuestActivityMiddleware(_ => Task.CompletedTask).InvokeAsync(http, Auth, new MemoryCache(new MemoryCacheOptions()));

        users.Verify(u => u.TouchActiveAsync(userId, It.IsAny<DateTimeOffset>(), It.IsAny<CancellationToken>()), isGuest ? Times.Once() : Times.Never());
    }

    [Theory]
    [InlineData(false)] // used a minute ago: inside the interval, no write
    [InlineData(true)]  // used before the interval: written
    public async Task McpKeyAuth_KeyLastUsedAt_TouchedOnlyPastTheInterval(bool stale)
    {
        var lastUsed = stale ? DateTimeOffset.UtcNow - McpKeys.LastUsedWriteInterval - TimeSpan.FromMinutes(1) : DateTimeOffset.UtcNow.AddMinutes(-1);
        var key = new McpConnectKey { Id = Guid.NewGuid(), UserId = Guid.NewGuid(), LastUsedAt = lastUsed };
        var keys = new Mock<IMcpKeyRepository>();
        keys.Setup(k => k.GetLiveByHashAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(key);
        var http = Request(McpKeys.Generate());

        await new McpKeyAuthMiddleware(_ => Task.CompletedTask).InvokeAsync(http, keys.Object, Mock.Of<IOAuthRepository>(), new ConfigurationBuilder().Build());

        Assert.Equal(key.UserId, http.Items[McpKeyAuthMiddleware.UserIdItemKey]);
        keys.Verify(k => k.TouchAsync(key.Id, It.IsAny<CancellationToken>()), stale ? Times.Once() : Times.Never());
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Fact]
    public void GetAccessTokenIdentity_TokenMintedEarlier_CarriesItsIatAndIsMemoized()
    {
        // Ten minutes ago, whole seconds as iat has: still unexpired (60 minutes), not "now".
        var minted = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.AddMinutes(-10).ToUnixTimeSeconds());
        var tokens = new JwtTokens(new JwtSettings { SecretKey = TestTokens.Secret, Issuer = TestTokens.Issuer }, new FixedClock(minted));
        var http = Request(tokens.MintAccessToken(Guid.NewGuid(), "reader@example.test", null, isGuest: false));

        var identity = http.GetAccessTokenIdentity(Auth);

        Assert.Equal(minted, identity!.IssuedAt);
        Assert.Same(identity, http.GetAccessTokenIdentity(Auth));
    }
}
