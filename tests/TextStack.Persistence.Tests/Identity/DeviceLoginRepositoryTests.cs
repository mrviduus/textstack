using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

public class DeviceLoginRepositoryTests(V2PostgresFixture db)
{
    private readonly DeviceLoginRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private async Task<DeviceLogin> CreatedAsync()
    {
        var login = NewDeviceLogin();
        await _repo.CreateAsync(login, DateTimeOffset.UtcNow, Ct);
        return login;
    }

    [Fact]
    public async Task DecideAsync_Approval_BindsTheLoginToTheUser()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());

        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct));

        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        Assert.Equal((DeviceLogin.Approved, (Guid?)user), (read.Status, read.UserId));
    }

    [Fact]
    public async Task DecideAsync_Denial_DeniesWithoutAUser()
    {
        var login = await CreatedAsync();

        Assert.Equal(DeviceLogin.Denied, await _repo.DecideAsync(login.UserCode, null, DateTimeOffset.UtcNow, Ct));

        Assert.Null((await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.UserId);
    }

    [Fact]
    public async Task DecideAsync_PastTheDeadline_MarksItExpiredWithoutAUser()
    {
        var login = await CreatedAsync();

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow.AddHours(1), Ct));

        Assert.Null((await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.UserId);
    }

    [Fact]
    public async Task DecideAsync_DeadlineExactlyNow_MarksItExpired()
    {
        var login = NewDeviceLogin();
        login.ExpiresAt = new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.CreateAsync(login, DateTimeOffset.UtcNow, Ct);

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), login.ExpiresAt, Ct));
    }

    [Fact]
    public async Task DecideAsync_StaleAndLivePendingShareACode_DecidesTheLiveOne()
    {
        var user = await db.NewReaderAsync();
        var (stale, live) = (NewDeviceLogin(), NewDeviceLogin());
        stale.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        live.UserCode = stale.UserCode;
        await _repo.CreateAsync(stale, DateTimeOffset.UtcNow, Ct);
        await _repo.CreateAsync(live, DateTimeOffset.UtcNow, Ct);

        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(live.UserCode, user, DateTimeOffset.UtcNow, Ct));

        Assert.Equal(DeviceLogin.Approved, (await _repo.GetByDeviceCodeAsync(live.DeviceCodeHash, Ct))!.Status);
        Assert.Equal(DeviceLogin.Pending, (await _repo.GetByDeviceCodeAsync(stale.DeviceCodeHash, Ct))!.Status);
    }

    [Fact]
    public async Task DecideAsync_AlreadyDecided_ReturnsNull()
    {
        var login = await CreatedAsync();
        await _repo.DecideAsync(login.UserCode, null, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DecideAsync_ConcurrentDecisionCommitsFirst_ReturnsNullAndKeepsIt()
    {
        var login = await CreatedAsync();
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition(
            "UPDATE device_authorizations SET status = 'denied' WHERE id = @Id", login, tx, cancellationToken: Ct));

        var approval = _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(holder, approval);
        await tx.CommitAsync(Ct);

        Assert.Null(await approval);
        Assert.Equal(DeviceLogin.Denied, (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);
    }

    [Fact]
    public async Task CreateAsync_CodeShownByALivePendingLogin_ReturnsFalseAndStoresNothing()
    {
        var first = await CreatedAsync();
        var second = NewDeviceLogin();
        second.UserCode = first.UserCode;

        Assert.False(await _repo.CreateAsync(second, DateTimeOffset.UtcNow, Ct));

        Assert.Null(await _repo.GetByDeviceCodeAsync(second.DeviceCodeHash, Ct));
    }

    [Fact]
    public async Task CreateAsync_CodeOfAnExpiredLogin_IsFreeAgain()
    {
        var first = await CreatedAsync();
        var second = NewDeviceLogin();
        second.UserCode = first.UserCode;

        Assert.True(await _repo.CreateAsync(second, first.ExpiresAt, Ct));
    }

    [Fact]
    public async Task CreateAsync_CodeOfADecidedLogin_IsFreeAgain()
    {
        var first = await CreatedAsync();
        await _repo.DecideAsync(first.UserCode, null, DateTimeOffset.UtcNow, Ct);
        var second = NewDeviceLogin();
        second.UserCode = first.UserCode;

        Assert.True(await _repo.CreateAsync(second, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task ExpireAsync_Pending_MarksItExpiredOnce()
    {
        var login = await CreatedAsync();

        Assert.True(await _repo.ExpireAsync(login.Id, Ct));

        Assert.Equal(DeviceLogin.Expired, (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);
        Assert.False(await _repo.ExpireAsync(login.Id, Ct));
    }

    [Fact]
    public async Task RedeemAsync_Approved_ReturnsTheUserOnlyOnce()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct);

        Assert.Equal(user, await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));

        Assert.Null(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));
        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        Assert.Equal(DeviceLogin.Expired, read.Status);
        Assert.NotNull(read.ConsumedAt);
    }

    [Fact]
    public async Task RedeemAsync_Approved_StoresTheSessionWithTheRedemption()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct);
        var hash = NewHash();

        await _repo.RedeemAsync(login.Id, hash, DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct);

        Assert.Equal(user, (await new SessionTokenRepository(db.DataSource).GetLiveAsync(hash, DateTimeOffset.UtcNow, Ct))?.UserId);
    }

    [Fact]
    public async Task RedeemAsync_ResetHoldsTheUser_WaitsAndThenRedeemsNothing()
    {
        // QA probe P2: a reset between the redemption and the session insert used to leave a session.
        // A reset in flight: the user locked (as ResetPasswordAsync does), the approval expired and the
        // sessions deleted, not yet committed.
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct);
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            UPDATE device_authorizations SET status = 'expired' WHERE user_id = @user AND status = 'approved';
            DELETE FROM user_refresh_tokens WHERE user_id = @user;
            """, new { user }, tx, cancellationToken: Ct));

        var redeem = _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(reset, redeem);
        var waited = !redeem.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Null(await redeem);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RedeemAsync_ApprovedButPastItsDeadline_ReturnsNull()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), login.ExpiresAt, Ct));
    }

    [Fact]
    public async Task RedeemAsync_Pending_ReturnsNull()
    {
        var login = await CreatedAsync();

        Assert.Null(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DeleteExpiredAsync_Cutoff_DeletesOnlyLoginsExpiredBeforeIt()
    {
        var (old, fresh) = (NewDeviceLogin(), NewDeviceLogin());
        old.ExpiresAt = new DateTimeOffset(2005, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.CreateAsync(old, DateTimeOffset.UtcNow, Ct);
        await _repo.CreateAsync(fresh, DateTimeOffset.UtcNow, Ct);

        Assert.Equal(1, await _repo.DeleteExpiredAsync(new DateTimeOffset(2005, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Null(await _repo.GetByDeviceCodeAsync(old.DeviceCodeHash, Ct));
        Assert.NotNull(await _repo.GetByDeviceCodeAsync(fresh.DeviceCodeHash, Ct));
    }
}
