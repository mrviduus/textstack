using Application.Identity;
using Domain.Identity;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// What <see cref="IDeviceLoginRepository"/> does on legacy too (the retention sweep), run against V2
/// (<see cref="DeviceLoginRepositoryTests"/>) and the legacy EF adapter
/// (<see cref="EfDeviceLoginRepositoryTests"/>) (#1100).
/// </summary>
public abstract class DeviceLoginRepositoryContract(IIdentityFixture db, IDeviceLoginRepository repo)
{
    private readonly IDeviceLoginRepository _sweeps = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Stores a pending login as it is (legacy has no device flow on the port).</summary>
    protected abstract Task SeedAsync(DeviceLogin login);

    private Task<long> CountAsync(DeviceLogin login) =>
        db.ScalarAsync<long>("SELECT count(*) FROM device_authorizations WHERE id = @Id", login);

    [Fact]
    public async Task DeleteExpiredAsync_Cutoff_DeletesOnlyLoginsExpiredBeforeIt()
    {
        var (old, fresh) = (NewDeviceLogin(), NewDeviceLogin());
        old.ExpiresAt = new DateTimeOffset(2005, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await SeedAsync(old);
        await SeedAsync(fresh);

        Assert.Equal(1, await _sweeps.DeleteExpiredAsync(new DateTimeOffset(2005, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(0L, await CountAsync(old));
        Assert.Equal(1L, await CountAsync(fresh));
    }
}
