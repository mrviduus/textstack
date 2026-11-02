using Application.Identity;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// What <see cref="ISessionTokenRepository"/> does on legacy too (the retention sweeps), run against
/// V2 (<see cref="SessionTokenRepositoryTests"/>) and the legacy EF adapter
/// (<see cref="EfSessionTokenRepositoryTests"/>) (#1100). Rows are seeded by each side: legacy has no
/// session protocol on the port.
/// </summary>
public abstract class SessionTokenRepositoryContract(IIdentityFixture db, ISessionTokenRepository repo)
{
    private readonly ISessionTokenRepository _sweeps = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A reader session of the user, expiring at <paramref name="expiresAt"/>.</summary>
    protected abstract Task SeedSessionAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt);

    /// <summary>A reset code of the user, expiring at <paramref name="expiresAt"/>.</summary>
    protected abstract Task SeedPasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt);

    [Fact]
    public async Task DeleteExpiredSessionsAsync_Cutoff_DeletesOnlySessionsExpiredBeforeIt()
    {
        var user = await db.NewReaderAsync();
        // Far back, so another test's sessions are never on the wrong side of this cutoff.
        var cutoff = new DateTimeOffset(2001, 1, 2, 0, 0, 0, TimeSpan.Zero);
        await SeedSessionAsync(user, NewHash(), cutoff.AddDays(-1));
        // Expiring at the cutoff instant itself is not "before" it.
        await SeedSessionAsync(user, NewHash(), cutoff);

        Assert.Equal(1, await _sweeps.DeleteExpiredSessionsAsync(cutoff, Ct));

        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task DeleteExpiredPasswordResetsAsync_Cutoff_DeletesOnlyCodesExpiredBeforeIt()
    {
        var user = await db.NewReaderAsync();
        await SeedPasswordResetAsync(user, NewHash(), new DateTimeOffset(2002, 1, 1, 0, 0, 0, TimeSpan.Zero));
        await SeedPasswordResetAsync(user, NewHash(), new DateTimeOffset(2002, 1, 3, 0, 0, 0, TimeSpan.Zero));

        Assert.Equal(1, await _sweeps.DeleteExpiredPasswordResetsAsync(new DateTimeOffset(2002, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(1L, await db.CountAsync("password_reset_tokens", user));
    }
}
