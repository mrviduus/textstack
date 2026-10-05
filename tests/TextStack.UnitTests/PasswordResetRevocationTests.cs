using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.Extensions.Options;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A password reset signs out every session AND every connected assistant: refresh tokens are
/// deleted, MCP connect keys and OAuth grants of that user are revoked; other users' stay live.
/// </summary>
public class PasswordResetRevocationTests
{
    private readonly List<User> _users = [];
    private readonly List<PasswordResetToken> _resetTokens = [];
    private readonly List<UserRefreshToken> _refreshTokens = [];
    private readonly List<McpAccessKey> _keys = [];
    private readonly List<OAuthGrant> _grants = [];
    private readonly AuthService _auth;

    public PasswordResetRevocationTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => new FakeDbSet<User>(_users));
        db.Setup(x => x.PasswordResetTokens).Returns(() => new FakeDbSet<PasswordResetToken>(_resetTokens));
        db.Setup(x => x.UserRefreshTokens).Returns(() => new FakeDbSet<UserRefreshToken>(_refreshTokens));
        db.Setup(x => x.McpAccessKeys).Returns(() => new FakeDbSet<McpAccessKey>(_keys));
        db.Setup(x => x.OAuthGrants).Returns(() => new FakeDbSet<OAuthGrant>(_grants));
        _auth = new AuthService(db.Object,
            Options.Create(new JwtSettings { SecretKey = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh" }),
            Options.Create(new GoogleSettings { ClientId = "test" }));
    }

    [Fact]
    public async Task ResetPasswordAsync_ValidToken_RevokesKeysAndGrantsOfThatUserOnly()
    {
        var user = new User { Id = Guid.NewGuid(), Email = "reader@test.dev", PasswordHash = "x" };
        var other = Guid.NewGuid();
        _users.Add(user);
        var earlier = DateTimeOffset.UtcNow.AddDays(-3);
        _refreshTokens.Add(new UserRefreshToken { Id = Guid.NewGuid(), UserId = user.Id, TokenHash = "h" });
        _keys.Add(new McpAccessKey { Id = Guid.NewGuid(), UserId = user.Id });
        _keys.Add(new McpAccessKey { Id = Guid.NewGuid(), UserId = user.Id, RevokedAt = earlier });
        _keys.Add(new McpAccessKey { Id = Guid.NewGuid(), UserId = other });
        _grants.Add(new OAuthGrant { Id = Guid.NewGuid(), UserId = user.Id });
        _grants.Add(new OAuthGrant { Id = Guid.NewGuid(), UserId = other });

        var raw = await _auth.RequestPasswordResetAsync(user.Email, CancellationToken.None);
        foreach (var t in _resetTokens) t.User = user;

        var ok = await _auth.ResetPasswordAsync(raw!, "a-new-password", CancellationToken.None);

        Assert.True(ok);
        Assert.Empty(_refreshTokens);
        Assert.All(_keys.Where(k => k.UserId == user.Id), k => Assert.NotNull(k.RevokedAt));
        Assert.Equal(earlier, _keys.Single(k => k.UserId == user.Id && k.RevokedAt == earlier).RevokedAt);
        Assert.Null(_keys.Single(k => k.UserId == other).RevokedAt);
        Assert.NotNull(_grants.Single(g => g.UserId == user.Id).RevokedAt);
        Assert.Null(_grants.Single(g => g.UserId == other).RevokedAt);
    }
}
