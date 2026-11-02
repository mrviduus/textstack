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
    private readonly SteppedClock _clock = new();
    private readonly User _legacy = new() { Id = Guid.NewGuid(), Email = "guest-1@guest.textstack.app", IsGuest = true };

    private V2ShadowUsers Shadows() => new(_users.Object, _clock, NullLogger<V2ShadowUsers>.Instance);

    private void CreateSucceeds() =>
        _users.Setup(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount());

    [Fact]
    public async Task EnsureAsync_NewUser_CreatesTheShadowWithTheLegacyIdEmailAndGuestFlag()
    {
        CreateSucceeds();

        Assert.Equal(ShadowOutcome.Ready, await Shadows().EnsureAsync(_legacy, Ct));

        _users.Verify(u => u.CreateAsync(It.Is<UserAccount>(a => a.Id == _legacy.Id && a.Email == _legacy.Email && a.IsGuest), It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task EnsureAsync_WithinTheTtl_WritesOnceAndAfterItEnsuresAgain()
    {
        CreateSucceeds();
        var shadows = Shadows();
        await shadows.EnsureAsync(_legacy, Ct);

        _clock.Now += V2ShadowUsers.Ttl - TimeSpan.FromSeconds(1);
        await shadows.EnsureAsync(_legacy, Ct);
        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Once);

        // A V2 row that vanished since (an ETL reset, a rollback) is created again, not left to the FK.
        _clock.Now += TimeSpan.FromSeconds(1);
        await shadows.EnsureAsync(_legacy, Ct);
        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public async Task EnsureAsync_RowAlreadyThere_IsReady()
    {
        _users.Setup(u => u.GetAsync(_legacy.Id, It.IsAny<CancellationToken>())).ReturnsAsync(new UserAccount { Id = _legacy.Id });

        Assert.Equal(ShadowOutcome.Ready, await Shadows().EnsureAsync(_legacy, Ct));
    }

    [Fact]
    public async Task EnsureAsync_EmailHeldByAnotherV2Account_IsEmailHeldAndRememberedForTheTtl()
    {
        var shadows = Shadows();

        Assert.Equal(ShadowOutcome.EmailHeld, await shadows.EnsureAsync(_legacy, Ct));
        Assert.Equal(ShadowOutcome.EmailHeld, await shadows.EnsureAsync(_legacy, Ct));

        _users.Verify(u => u.CreateAsync(It.IsAny<UserAccount>(), It.IsAny<CancellationToken>()), Times.Once);
    }
}
