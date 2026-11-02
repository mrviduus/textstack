using Application.Identity;
using Dapper;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// Migration 0002 across the identity repositories (#1092, #1107): what the reset stamp refuses on
/// every path that mints a credential from an access token, the OAuth consent, and the session
/// family and kind. Adopted from QA's probes of the migration.
/// </summary>
public class CredentialsResetTests(V2PostgresFixture db)
{
    private readonly SessionTokenRepository _sessions = new(db.DataSource);
    private readonly DeviceLoginRepository _devices = new(db.DataSource);
    private readonly McpKeyRepository _keys = new(db.DataSource);
    private readonly OAuthRepository _oauth = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static DateTimeOffset NextWeek => DateTimeOffset.UtcNow.AddDays(7);

    private static readonly DateTimeOffset Stamp = new(2030, 1, 1, 12, 0, 0, 500, TimeSpan.Zero);

    private Task StampAsync(Guid user, DateTimeOffset at) =>
        db.ExecAsync("UPDATE users SET credentials_reset_at = @at WHERE id = @user", new { at, user });

    /// <summary>Whether a token issued at <paramref name="iat"/> mints a session, approves a device login, creates an MCP key.</summary>
    private async Task<(bool Session, bool Approval, bool Key)> MintAllAsync(Guid user, DateTimeOffset iat)
    {
        var login = NewDeviceLogin();
        await _devices.CreateAsync(login, Ct);
        return (
            await _sessions.IssueAsync(user, NewHash(), NextWeek, null, iat, SessionKind.Reader, Ct) is not null,
            await _devices.DecideAsync(login.UserCode, user, iat, DateTimeOffset.UtcNow, Ct) == DeviceLogin.Approved,
            await _keys.CreateAsync(user, "k", NewHash(), "tsk_ab", iat, Ct) is not null);
    }

    private Task<SessionRefresh> RefreshAsync(string old, string next, SessionKind kind = SessionKind.Reader) =>
        _sessions.RefreshAsync(old, next, kind, _ => NextWeek, DateTimeOffset.UtcNow.AddSeconds(-1), Ct);

    private Task AgeAsync(Guid user) =>
        db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '1 minute' WHERE user_id = @user", new { user });

    private Task<long> CountHashAsync(string hash) =>
        db.ScalarAsync<long>("SELECT count(*) FROM user_refresh_tokens WHERE token_hash = @hash", new { hash });

    [Fact]
    public async Task EveryPath_TokenOfTheResetsOwnSecond_Refused()
    {
        var user = await db.NewReaderAsync();
        await StampAsync(user, Stamp);

        // iat has whole seconds: a token minted 12:00:00.7, after a reset at 12:00:00.5, says 12:00:00.
        Assert.Equal((false, false, false), await MintAllAsync(user, Stamp.AddMilliseconds(-500)));
    }

    [Fact]
    public async Task EveryPath_IatEqualToTheStamp_Accepted()
    {
        var user = await db.NewReaderAsync();
        await StampAsync(user, Stamp);

        Assert.Equal((true, true, true), await MintAllAsync(user, Stamp));
    }

    [Fact]
    public async Task EveryPath_NeverReset_Accepted()
    {
        var user = await db.NewReaderAsync();

        Assert.Equal((true, true, true), await MintAllAsync(user, DateTimeOffset.UnixEpoch));
    }

    [Fact]
    public async Task EveryPath_AlicesReset_LeavesBobMinting()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        await StampAsync(alice, Stamp);

        Assert.Equal((true, true, true), await MintAllAsync(bob, DateTimeOffset.UtcNow.AddMinutes(-5)));
        Assert.Equal((false, false, false), await MintAllAsync(alice, DateTimeOffset.UtcNow.AddMinutes(-5)));
    }

    [Fact]
    public async Task DecideAsync_Denial_DeniesWithoutATokenAge()
    {
        var login = NewDeviceLogin();
        await _devices.CreateAsync(login, Ct);

        Assert.Equal(DeviceLogin.Denied, await _devices.DecideAsync(login.UserCode, null, null, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RedeemAsync_UserRowHeldByAResetNotYetAtItsWrites_Waits()
    {
        // LockApprover's FOR SHARE: the reset has only locked the user (LockResetOwner) so far.
        var user = await db.NewReaderAsync();
        var login = NewDeviceLogin();
        await _devices.CreateAsync(login, Ct);
        await _devices.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition("SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var redeem = _devices.RedeemAsync(login.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(holder, redeem);
        var waited = !redeem.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.True(await redeem);
    }

    [Fact]
    public async Task RefreshAsync_FirstTokenReplayedAfterASweep_ReusedAndTheWholeFamilyDies()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _sessions.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await AgeAsync(user);
        // The spent rows, into a past no other test uses: a sweep that ignored the live family would take them.
        await db.ExecAsync("UPDATE user_refresh_tokens SET expires_at = '1998-01-01Z' WHERE user_id = @user AND token_hash <> @third", new { user, third });
        await _sessions.DeleteExpiredSessionsAsync(new DateTimeOffset(1998, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct);
        Assert.Equal(3L, await db.CountAsync("user_refresh_tokens", user));

        var replayed = await RefreshAsync(first, NewHash());

        Assert.Equal(SessionRefreshOutcome.Reused, replayed.Outcome);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_ReaderTokenReplayedAsAdmin_InvalidAndItsFamilyLives()
    {
        var user = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET role = 'admin' WHERE id = @user", new { user });
        var (first, second) = (NewHash(), NewHash());
        await _sessions.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await AgeAsync(user);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(first, NewHash(), SessionKind.Admin)).Outcome);

        Assert.Equal(1L, await CountHashAsync(second));
        Assert.False(await _sessions.RevokeAsync(second, SessionKind.Admin, Ct));
    }

    [Fact]
    public async Task RefreshAsync_AdminRotatedTwice_StaysAdminAndNeverAReader()
    {
        var admin = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET role = 'admin' WHERE id = @admin", new { admin });
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _sessions.IssueAsync(admin, first, NextWeek, null, null, SessionKind.Admin, Ct);
        await RefreshAsync(first, second, SessionKind.Admin);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(second, NewHash(), SessionKind.Reader)).Outcome);
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(second, third, SessionKind.Admin)).Outcome);
    }

    [Fact]
    public async Task ResetPasswordAsync_OAuthCodeApprovedBefore_ExpiresItAndMintsNoGrant()
    {
        // The device-login twin: an approved request whose code is not yet exchanged dies with the reset.
        var user = await db.NewReaderAsync();
        var request = NewOAuthRequest();
        await _oauth.CreateRequestAsync(request, Ct);
        await _oauth.ApproveRequestAsync(request.Id, user, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        var resetCode = NewHash();
        await _sessions.CreatePasswordResetAsync(user, resetCode, DateTimeOffset.UtcNow.AddHours(1), Ct);

        Assert.NotNull(await _sessions.ResetPasswordAsync(resetCode, "new-hash", DateTimeOffset.UtcNow, Ct));

        Assert.Equal(0L, await db.ScalarAsync<long>(
            "SELECT count(*) FROM oauth_authorization_requests WHERE id = @Id AND expires_at > now()", request));
        Assert.False(await _oauth.ConnectAsync(user, request.Id, NewGrant(), Ct));
        Assert.Equal(0L, await db.CountAsync("oauth_grants", user));
    }

    [Fact]
    public async Task ApproveRequestAsync_TokenFromBeforeTheReset_ReturnsNullAndStaysPending()
    {
        var user = await db.NewReaderAsync();
        var request = NewOAuthRequest();
        await _oauth.CreateRequestAsync(request, Ct);
        await StampAsync(user, DateTimeOffset.UtcNow);

        Assert.Null(await _oauth.ApproveRequestAsync(
            request.Id, user, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow.AddMinutes(-1), DateTimeOffset.UtcNow, Ct));
        Assert.Null((await _oauth.GetRequestAsync(request.Id, Ct))!.UserId);
    }

    [Fact]
    public async Task ConnectAsync_ResetCommitsWhileItWaits_StoresNoGrant()
    {
        // A reset holding the user has stamped it, not yet committed: the exchange of a code approved
        // before it waits, then refuses.
        var user = await db.NewReaderAsync();
        var requestId = await db.ApprovedOAuthRequestAsync(user);
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            UPDATE users SET credentials_reset_at = clock_timestamp() WHERE id = @user;
            """, new { user }, tx, cancellationToken: Ct));

        var connect = _oauth.ConnectAsync(user, requestId, NewGrant(), Ct);
        await db.WaitUntilBlockedByAsync(reset, connect);
        var waited = !connect.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.False(await connect);
        Assert.Equal(0L, await db.CountAsync("oauth_grants", user));
    }

    [Fact]
    public async Task ConnectAsync_AnotherUsersRequest_StoresNoGrant()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var alicesRequest = await db.ApprovedOAuthRequestAsync(alice);

        Assert.False(await _oauth.ConnectAsync(bob, alicesRequest, NewGrant(), Ct));
        Assert.Equal(0L, await db.CountAsync("oauth_grants", bob));
    }
}
