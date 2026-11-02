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
        await _repo.CreateAsync(login, Ct);
        return login;
    }

    [Fact]
    public async Task DecideAsync_Approval_BindsTheLoginToTheUser()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());

        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));

        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        Assert.Equal((DeviceLogin.Approved, (Guid?)user), (read.Status, read.UserId));
    }

    [Fact]
    public async Task DecideAsync_Denial_DeniesWithoutAUser()
    {
        var login = await CreatedAsync();

        Assert.Equal(DeviceLogin.Denied, await _repo.DecideAsync(login.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));

        Assert.Null((await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.UserId);
    }

    [Fact]
    public async Task DecideAsync_PastTheDeadline_MarksItExpiredWithoutAUser()
    {
        var login = await CreatedAsync();

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddHours(1), Ct));

        Assert.Null((await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.UserId);
    }

    [Fact]
    public async Task DecideAsync_DeadlineExactlyNow_MarksItExpired()
    {
        var login = NewDeviceLogin();
        login.ExpiresAt = new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.CreateAsync(login, Ct);

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, login.ExpiresAt, Ct));
    }

    [Fact]
    public async Task DecideAsync_ApproverResetAfterTheToken_ReturnsPendingAndDecidesNothing()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);

        Assert.Equal(DeviceLogin.Pending, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, Ct));
        Assert.Null((await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.UserId);
        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(1), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DecideAsync_PastTheDeadlineAndApproverReset_MarksItExpired()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(-1), login.ExpiresAt, Ct));
    }

    [Fact]
    public async Task DecideAsync_ResetCommitsWhileTheApprovalWaits_ApprovesNothing()
    {
        // #1092: an access token minted before the reset approves while the reset, holding the user
        // (as ResetPasswordAsync does), has stamped it and not yet committed.
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());

        var (waited, approval) = await db.WhileUserHeldAsync(user, "UPDATE users SET credentials_reset_at = now() WHERE id = @user;",
            () => _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, Ct));

        Assert.True(waited);
        Assert.Equal(DeviceLogin.Pending, approval);
        Assert.Equal(DeviceLogin.Pending, (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);
    }

    [Fact]
    public async Task DecideAsync_AlreadyDecided_ReturnsNull()
    {
        var login = await CreatedAsync();
        await _repo.DecideAsync(login.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DecideAsync_ConcurrentDecisionCommitsFirst_ReturnsNullAndKeepsIt()
    {
        var login = await CreatedAsync();
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition(
            "UPDATE device_authorizations SET status = 'denied' WHERE id = @Id", login, tx, cancellationToken: Ct));

        var approval = _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
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

        Assert.False(await _repo.CreateAsync(second, Ct));

        Assert.Null(await _repo.GetByDeviceCodeAsync(second.DeviceCodeHash, Ct));
    }

    [Fact]
    public async Task CreateAsync_CodeOfAPendingLoginPastItsDeadline_StaysTakenUntilDecided()
    {
        var first = NewDeviceLogin();
        first.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        await _repo.CreateAsync(first, Ct);
        var second = NewDeviceLogin();
        second.UserCode = first.UserCode;

        Assert.False(await _repo.CreateAsync(second, Ct));
        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(first.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.True(await _repo.CreateAsync(second, Ct));
    }

    [Fact]
    public async Task CreateAsync_TwoAtOnceWithOneCode_ExactlyOneLands()
    {
        var (first, second) = (NewDeviceLogin(), NewDeviceLogin());
        second.UserCode = first.UserCode;

        var created = await Task.WhenAll(_repo.CreateAsync(first, Ct), _repo.CreateAsync(second, Ct));

        Assert.Single(created, landed => landed);
        Assert.Equal(1L, await db.ScalarAsync<long>(
            "SELECT count(*) FROM device_authorizations WHERE user_code = @UserCode", first));
    }

    [Fact]
    public async Task CreateAsync_CodeOfADecidedLogin_IsFreeAgain()
    {
        var first = await CreatedAsync();
        await _repo.DecideAsync(first.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        var second = NewDeviceLogin();
        second.UserCode = first.UserCode;

        Assert.True(await _repo.CreateAsync(second, Ct));
    }

    [Fact]
    public async Task RedeemAsync_Approved_RedeemsOnlyOnce()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.True(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));

        Assert.False(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));
        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        Assert.Equal(DeviceLogin.Expired, read.Status);
        Assert.NotNull(read.ConsumedAt);
    }

    [Fact]
    public async Task RedeemAsync_Approved_StoresTheSessionWithTheRedemption()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        var hash = NewHash();

        await _repo.RedeemAsync(login.Id, hash, DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct);

        Assert.Equal(user, await db.ScalarAsync<Guid>("SELECT user_id FROM user_refresh_tokens WHERE token_hash = @hash AND expires_at > now()", new { hash }));
    }

    [Fact]
    public async Task RedeemAsync_ResetHoldsTheUser_WaitsAndThenRedeemsNothing()
    {
        // QA probe P2: a reset between the redemption and the session insert used to leave a session.
        // A reset in flight: the user locked (as ResetPasswordAsync does), the approval expired and the
        // sessions deleted, not yet committed.
        var user = await db.NewReaderAsync();
        var login = await db.ApprovedDeviceLoginAsync(user);

        var (waited, redeemed) = await db.WhileUserHeldAsync(user, """
            UPDATE device_authorizations SET status = 'expired' WHERE user_id = @user AND status = 'approved';
            DELETE FROM user_refresh_tokens WHERE user_id = @user;
            """, () => _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));

        Assert.True(waited);
        Assert.False(redeemed);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RedeemAsync_UserRowHeldByAResetNotYetAtItsWrites_Waits()
    {
        // LockApprover's FOR SHARE: the reset has only locked the user (LockResetOwner) so far; nothing
        // else in the redemption would wait for it.
        var user = await db.NewReaderAsync();
        var login = await db.ApprovedDeviceLoginAsync(user);

        var (waited, redeemed) = await db.WhileUserHeldAsync(user, null,
            () => _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));

        Assert.True(waited);
        Assert.True(redeemed);
    }

    [Fact]
    public async Task RedeemAsync_ApprovedButPastItsDeadline_False()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        Assert.False(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), login.ExpiresAt, Ct));
    }

    [Fact]
    public async Task RedeemAsync_Pending_False()
    {
        var login = await CreatedAsync();

        Assert.False(await _repo.RedeemAsync(login.Id, NewHash(), DateTimeOffset.UtcNow.AddDays(7), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task DeleteExpiredAsync_Cutoff_DeletesOnlyLoginsExpiredBeforeIt()
    {
        var (old, fresh) = (NewDeviceLogin(), NewDeviceLogin());
        old.ExpiresAt = new DateTimeOffset(2005, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.CreateAsync(old, Ct);
        await _repo.CreateAsync(fresh, Ct);

        Assert.Equal(1, await _repo.DeleteExpiredAsync(new DateTimeOffset(2005, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Null(await _repo.GetByDeviceCodeAsync(old.DeviceCodeHash, Ct));
        Assert.NotNull(await _repo.GetByDeviceCodeAsync(fresh.DeviceCodeHash, Ct));
    }
}
