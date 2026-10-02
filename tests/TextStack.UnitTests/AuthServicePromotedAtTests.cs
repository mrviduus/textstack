using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Moq;

namespace TextStack.UnitTests;

// User.PromotedAt is the conversion measurement: set only when a guest row becomes the account.
public class AuthServicePromotedAtTests
{
    private readonly List<User> _users = [];
    private readonly List<UserRefreshToken> _refreshTokens = [];
    private readonly AuthService _service;

    public AuthServicePromotedAtTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Users).Returns(() => FakeSet(_users).Object);
        db.Setup(x => x.UserRefreshTokens).Returns(() => FakeSet(_refreshTokens).Object);
        db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(0);

        _service = new AuthService(
            db.Object,
            Options.Create(new JwtSettings { SecretKey = new string('k', 64) }),
            Options.Create(new GoogleSettings { ClientId = "test" }));
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
        return set;
    }

    private User SeedGuest()
    {
        var g = new User { Id = Guid.NewGuid(), Email = $"guest-{Guid.NewGuid():N}@guest.local", Name = "Guest", IsGuest = true };
        _users.Add(g);
        return g;
    }

    [Fact]
    public async Task RegisterWithEmailAsync_GuestToken_PromotesInPlaceAndSetsPromotedAt()
    {
        var guest = SeedGuest();

        var result = await _service.RegisterWithEmailAsync("new@test.dev", "password123", null, guest.Id, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Same(guest, result.Value.user);
        Assert.False(guest.IsGuest);
        Assert.NotNull(guest.PromotedAt);
        Assert.Single(_users);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_NoGuest_LeavesPromotedAtNull()
    {
        var result = await _service.RegisterWithEmailAsync("fresh@test.dev", "password123", null, null, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Null(result.Value.user.PromotedAt);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_GuestRowGone_CreatesFreshUserWithPromotedAtNull()
    {
        var result = await _service.RegisterWithEmailAsync("orphan@test.dev", "password123", null, Guid.NewGuid(), CancellationToken.None);

        Assert.NotNull(result);
        Assert.Null(result.Value.user.PromotedAt);
    }

    [Fact]
    public async Task RegisterWithEmailAsync_IdIsNotAGuest_DoesNotPromoteThatRow()
    {
        var account = new User { Id = Guid.NewGuid(), Email = "acct@test.dev", IsGuest = false };
        _users.Add(account);

        var result = await _service.RegisterWithEmailAsync("other@test.dev", "password123", null, account.Id, CancellationToken.None);

        Assert.NotNull(result);
        Assert.NotSame(account, result.Value.user);
        Assert.Null(account.PromotedAt);
        Assert.Null(result.Value.user.PromotedAt);
    }
}
