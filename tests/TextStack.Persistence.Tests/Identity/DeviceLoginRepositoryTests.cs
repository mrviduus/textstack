using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The device-code login on V2: a TV shows a code, the reader decides it on the web, the TV redeems it once.</summary>
public class DeviceLoginRepositoryTests(V2PostgresFixture db) : DeviceLoginRepositoryContract(db, new DeviceLoginRepository(db.DataSource))
{
    private readonly DeviceLoginRepository _repo = new(db.DataSource);

    protected override Task SeedAsync(DeviceLogin login) => _repo.CreateAsync(login, Ct);

    private async Task<DeviceLogin> CreatedAsync()
    {
        var login = NewDeviceLogin();
        await _repo.CreateAsync(login, Ct);
        return login;
    }

    private async Task<(string Status, Guid? UserId)> StateAsync(DeviceLogin login)
    {
        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        return (read.Status, read.UserId);
    }

    private Task<bool> RedeemAsync(DeviceLogin login, string hash, DateTimeOffset now) =>
        _repo.RedeemAsync(login.Id, hash, DateTimeOffset.UtcNow.AddDays(7), now, Ct);

    private Task<long> SessionsWithHashAsync(string hash) =>
        db.ScalarAsync<long>("SELECT count(*) FROM user_refresh_tokens WHERE token_hash = @hash", new { hash });

    [Fact]
    public async Task DecideAsync_ReaderApprovesTheTv_TheTvRedeemsOneSessionOnlyOnce()
    {
        var (alice, login) = (await db.NewReaderAsync(), await CreatedAsync());
        var hash = NewHash();

        // Still pending: nothing to redeem.
        Assert.False(await RedeemAsync(login, hash, DateTimeOffset.UtcNow));

        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(login.UserCode, alice, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.Equal((DeviceLogin.Approved, (Guid?)alice), await StateAsync(login));
        // Decided once: a second decision, by anyone, changes nothing.
        Assert.Null(await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.Equal((DeviceLogin.Approved, (Guid?)alice), await StateAsync(login));

        // Collected at its deadline: too late, no session.
        Assert.False(await RedeemAsync(login, hash, login.ExpiresAt));
        Assert.Equal(0L, await SessionsWithHashAsync(hash));

        Assert.True(await RedeemAsync(login, hash, DateTimeOffset.UtcNow));
        Assert.Equal(alice, await db.ScalarAsync<Guid>("SELECT user_id FROM user_refresh_tokens WHERE token_hash = @hash AND expires_at > now()", new { hash }));

        // A replayed device code mints nothing.
        var replay = NewHash();
        Assert.False(await RedeemAsync(login, replay, DateTimeOffset.UtcNow));
        Assert.Equal(0L, await SessionsWithHashAsync(replay));
        var read = (await _repo.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!;
        Assert.Equal(DeviceLogin.Expired, read.Status);
        Assert.NotNull(read.ConsumedAt);
    }

    [Fact]
    public async Task DecideAsync_ReaderDeniesTheTv_DeniedWithoutAUserAndNothingToRedeem()
    {
        var login = await CreatedAsync();

        Assert.Equal(DeviceLogin.Denied, await _repo.DecideAsync(login.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.Equal((DeviceLogin.Denied, (Guid?)null), await StateAsync(login));

        // A later approval cannot overturn the denial.
        Assert.Null(await _repo.DecideAsync(login.UserCode, await db.NewReaderAsync(), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.Equal((DeviceLogin.Denied, (Guid?)null), await StateAsync(login));
        Assert.False(await RedeemAsync(login, NewHash(), DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData(3600, true, false)] // an hour late, approving
    [InlineData(0, true, false)]    // at the deadline instant itself
    [InlineData(0, true, true)]     // at the deadline, by an approver reset since: the deadline wins
    [InlineData(0, false, false)]   // a denial at the deadline
    public async Task DecideAsync_LoginPastItsDeadline_ExpiresWithoutAUserWhoeverAsks(int secondsPastDeadline, bool approving, bool approverReset)
    {
        var login = NewDeviceLogin();
        login.ExpiresAt = new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await _repo.CreateAsync(login, Ct);
        Guid? approver = approving ? await db.NewReaderAsync() : null;
        if (approverReset) await db.ResetCredentialsAtAsync(approver!.Value, DateTimeOffset.UtcNow);

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(
            login.UserCode, approver, DateTimeOffset.UtcNow.AddMinutes(-1), login.ExpiresAt.AddSeconds(secondsPastDeadline), Ct));

        Assert.Equal((DeviceLogin.Expired, (Guid?)null), await StateAsync(login));
    }

    [Fact]
    public async Task DecideAsync_ApproverResetAfterTheToken_StaysPendingUntilAFreshTokenApproves()
    {
        var (user, login) = (await db.NewReaderAsync(), await CreatedAsync());
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);

        Assert.Equal(DeviceLogin.Pending, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, Ct));
        Assert.Equal((DeviceLogin.Pending, (Guid?)null), await StateAsync(login));

        Assert.Equal(DeviceLogin.Approved, await _repo.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow.AddMinutes(1), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task CreateAsync_CodeShownByAPendingLogin_RefusedUntilThatLoginIsDecided()
    {
        var live = await CreatedAsync();
        var stale = NewDeviceLogin();
        stale.ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        await _repo.CreateAsync(stale, Ct);
        var (liveDup, staleDup) = (NewDeviceLogin(), NewDeviceLogin());
        (liveDup.UserCode, staleDup.UserCode) = (live.UserCode, stale.UserCode);

        Assert.False(await _repo.CreateAsync(liveDup, Ct));
        Assert.Null(await _repo.GetByDeviceCodeAsync(liveDup.DeviceCodeHash, Ct));
        // Past its deadline but still pending: the code stays taken.
        Assert.False(await _repo.CreateAsync(staleDup, Ct));

        Assert.Equal(DeviceLogin.Expired, await _repo.DecideAsync(stale.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.True(await _repo.CreateAsync(staleDup, Ct));
        Assert.Equal(DeviceLogin.Denied, await _repo.DecideAsync(live.UserCode, null, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct));
        Assert.True(await _repo.CreateAsync(liveDup, Ct));
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
        Assert.Equal((DeviceLogin.Pending, (Guid?)null), await StateAsync(login));
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
        Assert.Equal((DeviceLogin.Denied, (Guid?)null), await StateAsync(login));
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
            """, () => RedeemAsync(login, NewHash(), DateTimeOffset.UtcNow));

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

        var (waited, redeemed) = await db.WhileUserHeldAsync(user, null, () => RedeemAsync(login, NewHash(), DateTimeOffset.UtcNow));

        Assert.True(waited);
        Assert.True(redeemed);
    }
}
