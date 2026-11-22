using Api.Extensions;
using Api.Middleware;
using Application.Identity;
using Domain.Identity;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using NSubstitute;

namespace TextStack.UnitTests;

/// <summary>
/// The request-level identity paths on the ports (#1100): the guest activity stamp, the connect key's
/// throttled use stamp, and the access token's <c>iat</c> as every endpoint reads it.
/// </summary>
public class IdentityMiddlewareTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly IAuthService Auth = TestTokens.ReadOnlyAuth();

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
        var users = Substitute.For<IUserRepository>();
        var userId = Guid.NewGuid();
        var http = Request(TestTokens.Token(userId, guestClaim: isGuest), s => s.AddSingleton(users));

        await new GuestActivityMiddleware(_ => Task.CompletedTask).InvokeAsync(http, Auth, new MemoryCache(new MemoryCacheOptions()), NullLogger<GuestActivityMiddleware>.Instance, TimeProvider.System);

        if (isGuest) await users.Received(1).TouchActiveAsync(userId, Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
        else await users.DidNotReceive().TouchActiveAsync(Arg.Any<Guid>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(false)] // used a minute ago: inside the interval, no write
    [InlineData(true)]  // used before the interval: written
    public async Task McpKeyAuth_KeyLastUsedAt_TouchedOnlyPastTheInterval(bool stale)
    {
        var lastUsed = stale ? DateTimeOffset.UtcNow - McpKeys.LastUsedWriteInterval - TimeSpan.FromMinutes(1) : DateTimeOffset.UtcNow.AddMinutes(-1);
        var key = new McpConnectKey { Id = Guid.NewGuid(), UserId = Guid.NewGuid(), LastUsedAt = lastUsed };
        var keys = Substitute.For<IMcpKeyRepository>();
        keys.GetLiveByHashAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(key);
        var http = Request(McpKeys.Generate());

        await new McpKeyAuthMiddleware(_ => Task.CompletedTask).InvokeAsync(http, keys, Substitute.For<IOAuthRepository>(), new ConfigurationBuilder().Build(), TimeProvider.System);

        Assert.Equal(key.UserId, http.Items[McpKeyAuthMiddleware.UserIdItemKey]);
        if (stale) await keys.Received(1).TouchAsync(key.Id, Arg.Any<CancellationToken>());
        else await keys.DidNotReceive().TouchAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>());
    }

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task McpKeyAuth_Frozen_AuthenticatesWithoutWritingUseStamp(bool oauthToken)
    {
        var userId = Guid.NewGuid();
        var keys = Substitute.For<IMcpKeyRepository>();
        var oauth = Substitute.For<IOAuthRepository>();
        keys.GetLiveByHashAsync(Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(new McpConnectKey { Id = Guid.NewGuid(), UserId = userId });
        oauth.GetByAccessTokenAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>()).Returns(new OAuthTokenGrant { Id = Guid.NewGuid(), UserId = userId });
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            [WriteFreezeMiddleware.ConfigurationKey] = "true",
        }).Build();
        var http = Request(oauthToken ? "tso_" + new string('a', 64) : McpKeys.Generate());
        var reached = false;

        await new McpKeyAuthMiddleware(_ => { reached = true; return Task.CompletedTask; })
            .InvokeAsync(http, keys, oauth, config, TimeProvider.System);

        Assert.True(reached);
        Assert.Equal(userId, http.Items[McpKeyAuthMiddleware.UserIdItemKey]);
        await keys.DidNotReceive().TouchAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>());
        await oauth.DidNotReceive().TouchAsync(Arg.Any<Guid>(), Arg.Any<CancellationToken>());
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
