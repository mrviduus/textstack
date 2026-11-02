using Application.Common.Interfaces;
using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests.V2;

/// <summary>M2.2's bridge: the legacy session user gets a V2 row with its id before any V2 write.</summary>
public class V2ShadowUsersTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<IUserRepository> _users = new();
    private readonly Mock<IAppDbContext> _legacy = new();
    private readonly User _guest = new() { Id = Guid.NewGuid(), Email = "guest-1@guest.textstack.app", IsGuest = true };
    private readonly V2ShadowUsers _shadows;

    public V2ShadowUsersTests()
    {
        _legacy.Setup(d => d.Users).Returns(() => new FakeDbSet<User>([_guest]));
        _shadows = new(_users.Object, new MemoryCache(new MemoryCacheOptions()), NullLogger<V2ShadowUsers>.Instance);
    }

    private void CreateSucceeds() =>
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());

    [Fact]
    public async Task EnsureAsync_NewUser_CreatesTheShadowWithTheLegacyIdEmailAndGuestFlag()
    {
        CreateSucceeds();

        Assert.True(await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct));

        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _guest.Id && a.Email == _guest.Email && a.IsGuest), It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task EnsureAsync_Cached_WritesOnceUntilForgotten()
    {
        CreateSucceeds();
        await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct);
        await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct);
        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Once);

        // A V2 row that turned out to be gone (an ETL reset, a rollback) is created again.
        _shadows.Forget(_guest.Id);
        await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct);
        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public async Task EnsureAsync_RowAlreadyThere_IsReady()
    {
        _users.Setup(u => u.GetAsync(_guest.Id, It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount { Id = _guest.Id });

        Assert.True(await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct));
    }

    [Fact]
    public async Task EnsureAsync_EmailHeldByAnotherV2Account_IsFalseAndCached()
    {
        Assert.False(await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct));
        Assert.False(await _shadows.EnsureAsync(_legacy.Object, _guest.Id, Ct));

        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task HasLegacyAccountAsync_DeletedAccount_IsFalse()
    {
        Assert.True(await V2ShadowUsers.HasLegacyAccountAsync(_legacy.Object, _guest.Id, Ct));
        Assert.False(await V2ShadowUsers.HasLegacyAccountAsync(_legacy.Object, Guid.NewGuid(), Ct));
    }
}
