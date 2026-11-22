using Application.Identity;
using Domain.Identity;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// The retention sweep of <see cref="IDeviceLoginRepository"/>, run by <see cref="DeviceLoginRepositoryTests"/>
/// on V2; any other implementation of the port derives from it to run the same story (#1100).
/// </summary>
public abstract class DeviceLoginRepositoryContract(IIdentityFixture db, IDeviceLoginRepository repo)
{
    private readonly IDeviceLoginRepository _sweeps = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Stores a pending login as it is.</summary>
    protected abstract Task SeedAsync(DeviceLogin login);

    private Task<long> CountAsync(DeviceLogin login) =>
        db.ScalarAsync<long>("SELECT count(*) FROM device_authorizations WHERE id = @Id", login);

    [Fact]
    public async Task DeleteExpiredAsync_RetentionSweep_DeletesOnlyLoginsExpiredBeforeTheCutoff()
    {
        // Shared DB: own rows by id, never the deleted count. Expiring at the cutoff instant itself is not "before" it.
        var cutoff = new DateTimeOffset(2005, 1, 2, 0, 0, 0, TimeSpan.Zero);
        var (old, atCutoff, fresh) = (NewDeviceLogin(), NewDeviceLogin(), NewDeviceLogin());
        old.ExpiresAt = cutoff.AddDays(-1);
        atCutoff.ExpiresAt = cutoff;
        await SeedAsync(old);
        await SeedAsync(atCutoff);
        await SeedAsync(fresh);

        await _sweeps.DeleteExpiredAsync(cutoff, Ct);

        Assert.Equal(0L, await CountAsync(old));
        Assert.Equal(1L, await CountAsync(atCutoff));
        Assert.Equal(1L, await CountAsync(fresh));
    }
}
