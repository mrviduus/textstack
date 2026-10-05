using Application.AdminAuth;
using Application.AdminSettings;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// Refresh tokens are stored as <see cref="DeviceCodes.HashToken"/> and looked up by hash; a
/// rotated-away token presented again revokes its successor; user and admin access tokens are not
/// accepted in each other's place. Over list-backed fake sets, like <c>AuthServicePromotedAtTests</c>.
/// </summary>
public class RefreshTokenHardeningTests
{
    private const string Secret = "a-test-signing-key-long-enough-for-hmac-sha256-abcdefgh";

    private readonly List<User> _users = [];
    private readonly List<UserRefreshToken> _refreshTokens = [];
    private readonly List<AdminUser> _admins = [];
    private readonly List<AdminRefreshToken> _adminRefreshTokens = [];
    private readonly AuthService _auth;
    private readonly AdminAuthService _adminAuth;

    public RefreshTokenHardeningTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => FakeSet(_users).Object);
        db.Setup(x => x.UserRefreshTokens).Returns(() => FakeSet(_refreshTokens).Object);
        db.Setup(x => x.AdminUsers).Returns(() => FakeSet(_admins).Object);
        db.Setup(x => x.AdminRefreshTokens).Returns(() => FakeSet(_adminRefreshTokens).Object);
        db.Setup(x => x.AdminSettings).Returns(() => FakeSet(new List<AdminSettings>()).Object);
        db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(0);

        var jwt = Options.Create(new JwtSettings { SecretKey = Secret });
        _auth = new AuthService(db.Object, jwt, Options.Create(new GoogleSettings { ClientId = "test" }));
        _adminAuth = new AdminAuthService(
            db.Object, jwt, new AdminSettingsService(db.Object, new MemoryCache(new MemoryCacheOptions())));
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        set.Setup(m => m.Add(It.IsAny<T>())).Callback<T>(e => data.Add(e));
        set.Setup(m => m.Remove(It.IsAny<T>())).Callback<T>(e => data.Remove(e));
        set.Setup(m => m.RemoveRange(It.IsAny<IEnumerable<T>>()))
            .Callback<IEnumerable<T>>(es => { foreach (var e in es.ToList()) data.Remove(e); });
        return set;
    }

    /// <summary>Signs a reader in and links each stored row to its user, as EF's Include would.</summary>
    private async Task<(User User, string Refresh, string Access)> SignInAsync()
    {
        var (user, access, refresh) = await _auth.TestLoginAsync("reader@test.dev", CancellationToken.None);
        LinkUsers();
        return (user, refresh, access);
    }

    private void LinkUsers()
    {
        foreach (var t in _refreshTokens)
            t.User = _users.Single(u => u.Id == t.UserId);
    }

    [Fact]
    public void HashToken_SampleToken_MatchesTheMigrationSqlExpression()
    {
        // Produced on PostgreSQL 16 by the exact expression the HashRefreshTokens migration runs:
        //   SELECT encode(sha256(convert_to('abc+/=XYZ09', 'UTF8')), 'hex');
        // If C# and SQL disagreed, every session would be signed out by the deploy.
        Assert.Equal(
            "54f6437b08e8ff35b22ec194475a9f8837ad8cd27cad2ea7473c449b1cfc9e45",
            DeviceCodes.HashToken("abc+/=XYZ09"));
    }

    [Fact]
    public async Task TestLoginAsync_NewSession_StoresOnlyTheHash()
    {
        var (_, refresh, _) = await SignInAsync();

        var row = Assert.Single(_refreshTokens);
        Assert.Equal(DeviceCodes.HashToken(refresh), row.TokenHash);
        Assert.NotEqual(refresh, row.TokenHash);
        Assert.Null(row.PreviousTokenHash);
    }

    [Fact]
    public async Task RefreshTokenAsync_RawToken_RotatesAndRemembersThePreviousHash()
    {
        var (user, refresh, _) = await SignInAsync();

        var result = await _auth.RefreshTokenAsync(refresh, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(user.Id, result.Value.user.Id);
        var row = Assert.Single(_refreshTokens);
        Assert.Equal(DeviceCodes.HashToken(result.Value.refreshToken), row.TokenHash);
        Assert.Equal(DeviceCodes.HashToken(refresh), row.PreviousTokenHash);
    }

    [Fact]
    public async Task RefreshTokenAsync_StoredHashPresentedAsToken_IsRefused()
    {
        // A copy of the table is not a set of working tokens.
        await SignInAsync();

        var result = await _auth.RefreshTokenAsync(_refreshTokens[0].TokenHash, CancellationToken.None);

        Assert.Null(result);
        Assert.Single(_refreshTokens);
    }

    [Fact]
    public async Task LogoutAsync_RawToken_DeletesTheRow()
    {
        var (_, refresh, _) = await SignInAsync();

        Assert.True(await _auth.LogoutAsync(refresh, CancellationToken.None));
        Assert.Empty(_refreshTokens);
    }

    [Fact]
    public async Task RefreshTokenAsync_RotatedTokenReplayedAfterGrace_RevokesItsSuccessor()
    {
        var (_, first, _) = await SignInAsync();
        var second = (await _auth.RefreshTokenAsync(first, CancellationToken.None))!.Value.refreshToken;
        LinkUsers();
        _refreshTokens[0].CreatedAt -= AuthService.RefreshReuseGrace + TimeSpan.FromSeconds(1);

        Assert.Null(await _auth.RefreshTokenAsync(first, CancellationToken.None));

        Assert.Empty(_refreshTokens);
        Assert.Null(await _auth.RefreshTokenAsync(second, CancellationToken.None));
    }

    [Fact]
    public async Task RefreshTokenAsync_RotatedTokenReplayedWithinGrace_IsRefusedButSuccessorLives()
    {
        // Two tabs refreshing with the same cookie at once: the loser is refused, nobody is signed out.
        var (_, first, _) = await SignInAsync();
        var second = (await _auth.RefreshTokenAsync(first, CancellationToken.None))!.Value.refreshToken;
        LinkUsers();

        Assert.Null(await _auth.RefreshTokenAsync(first, CancellationToken.None));

        Assert.NotNull(await _auth.RefreshTokenAsync(second, CancellationToken.None));
    }

    [Fact]
    public async Task AdminRefreshTokenAsync_RawToken_StoredAsHashAndRotates()
    {
        var (_, _, refresh) = await AdminSignInAsync();
        Assert.Equal(DeviceCodes.HashToken(refresh), Assert.Single(_adminRefreshTokens).TokenHash);
        LinkAdmins();

        var result = await _adminAuth.RefreshTokenAsync(refresh, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(DeviceCodes.HashToken(result.Value.refreshToken), Assert.Single(_adminRefreshTokens).TokenHash);
    }

    [Fact]
    public async Task ValidateAccessToken_UserTokenAtAdminAndAdminTokenAtUser_BothRejected()
    {
        var (user, _, userAccess) = await SignInAsync();
        var (admin, adminAccess, _) = await AdminSignInAsync();

        // Each is accepted where it belongs...
        Assert.Equal(user.Id, _auth.ValidateAccessToken(userAccess));
        Assert.Equal(admin.Id, _adminAuth.ValidateAccessToken(adminAccess).adminId);
        // ...and nowhere else.
        Assert.Null(_auth.ValidateAccessToken(adminAccess));
        Assert.Null(_adminAuth.ValidateAccessToken(userAccess).adminId);
    }

    private async Task<(AdminUser Admin, string Access, string Refresh)> AdminSignInAsync()
    {
        _admins.Add(new AdminUser
        {
            Id = Guid.NewGuid(),
            Email = "admin@test.dev",
            PasswordHash = BCrypt.Net.BCrypt.HashPassword("password123", workFactor: 4),
            Role = AdminRole.Admin,
            IsActive = true,
        });
        var (admin, access, refresh) = (await _adminAuth.LoginAsync("admin@test.dev", "password123", CancellationToken.None))!.Value;
        return (admin, access, refresh);
    }

    private void LinkAdmins()
    {
        foreach (var t in _adminRefreshTokens)
            t.AdminUser = _admins.Single(a => a.Id == t.AdminUserId);
    }
}
