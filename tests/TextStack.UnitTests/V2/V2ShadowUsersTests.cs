using Application.Identity;
using Domain.Entities;
using Domain.Identity;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>M2.2's bridge: the legacy session user gets a V2 row with its id before any V2 write.</summary>
public class V2ShadowUsersTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<IUserRepository> _users = new();
    private readonly User _legacy = new() { Id = Guid.NewGuid(), Email = "guest-1@guest.textstack.app", IsGuest = true };

    private V2ShadowUsers Shadows() => new(_users.Object, NullLogger<V2ShadowUsers>.Instance);

    [Fact]
    public async Task EnsureAsync_NewUser_CreatesTheShadowWithTheLegacyIdEmailAndGuestFlag()
    {
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());

        Assert.Equal(ShadowOutcome.Ready, await Shadows().EnsureAsync(_legacy.Id, () => Task.FromResult<User?>(_legacy), Ct));

        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _legacy.Id && a.Email == _legacy.Email && a.IsGuest), It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task EnsureAsync_SeenBefore_TouchesNeitherDatabase()
    {
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());
        var shadows = Shadows();
        await shadows.EnsureAsync(_legacy.Id, () => Task.FromResult<User?>(_legacy), Ct);
        var legacyReads = 0;

        await shadows.EnsureAsync(_legacy.Id, () => { legacyReads++; return Task.FromResult<User?>(_legacy); }, Ct);

        Assert.Equal(0, legacyReads);
        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task EnsureAsync_RowAlreadyThere_IsReady()
    {
        _users.Setup(u => u.GetAsync(_legacy.Id, It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount { Id = _legacy.Id });

        Assert.Equal(ShadowOutcome.Ready, await Shadows().EnsureAsync(_legacy.Id, () => Task.FromResult<User?>(_legacy), Ct));
    }

    [Fact]
    public async Task EnsureAsync_EmailHeldByAnotherV2Account_IsEmailHeldAndNotRemembered()
    {
        var shadows = Shadows();

        Assert.Equal(ShadowOutcome.EmailHeld, await shadows.EnsureAsync(_legacy.Id, () => Task.FromResult<User?>(_legacy), Ct));
        Assert.Equal(ShadowOutcome.EmailHeld, await shadows.EnsureAsync(_legacy.Id, () => Task.FromResult<User?>(_legacy), Ct));
    }

    [Fact]
    public async Task EnsureAsync_NoLegacyAccount_IsNoAccount() =>
        Assert.Equal(ShadowOutcome.NoAccount, await Shadows().EnsureAsync(Guid.NewGuid(), () => Task.FromResult<User?>(null), Ct));
}
