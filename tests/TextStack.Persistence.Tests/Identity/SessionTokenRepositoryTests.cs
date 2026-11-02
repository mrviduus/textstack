using Application.Identity;
using Dapper;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

public class SessionTokenRepositoryTests(V2PostgresFixture db)
{
    private readonly SessionTokenRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTimeOffset NextWeek => DateTimeOffset.UtcNow.AddDays(7);

    private Task<SessionRefresh> RefreshAsync(string old, string next, SessionKind kind = SessionKind.Reader, DateTimeOffset? now = null) =>
        _repo.RefreshAsync(old, next, kind, _ => NextWeek, now ?? DateTimeOffset.UtcNow, Ct);

    /// <summary>Moves every session of the user <paramref name="interval"/> (SQL, a constant) into the past: past the reuse grace.</summary>
    private Task AgeAsync(Guid user, string interval) =>
        db.ExecAsync($"UPDATE user_refresh_tokens SET created_at = now() - interval '{interval}' WHERE user_id = @user", new { user });

    private Task<bool> IsLiveAsync(string hash) =>
        db.ScalarAsync<bool>("SELECT EXISTS (SELECT FROM user_refresh_tokens WHERE token_hash = @hash AND expires_at > now())", new { hash });

    [Fact]
    public async Task IssueAsync_NewSession_IsTheUsersAndLiveUntilItExpires()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();

        var issued = (await _repo.IssueAsync(user, hash, NextWeek, null, null, SessionKind.Reader, Ct))!;

        Assert.Equal((user, hash, (string?)null), (issued.UserId, issued.TokenHash, issued.PreviousTokenHash));
        Assert.True(await IsLiveAsync(hash));
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(hash, NewHash(), now: NextWeek.AddDays(1))).Outcome);
    }

    [Fact]
    public async Task IssueAsync_VerifiedHashIsStillThePassword_Issues()
    {
        var user = await ReaderWithPasswordAsync("old-hash");

        Assert.NotNull(await _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", null, SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task IssueAsync_PasswordChangedSinceVerify_ReturnsNullAndStoresNothing()
    {
        var user = await ReaderWithPasswordAsync("new-hash");

        Assert.Null(await _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", null, SessionKind.Reader, Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_NoProof_WaitsForTheUserRowAndThenIssues()
    {
        // #1107: a Google, Apple, guest or test sign-in queues behind a reset too, or it could commit
        // beside the reset unseen by its sign-out.
        var user = await db.NewReaderAsync();
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var issue = _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        await db.WaitUntilBlockedByAsync(holder, issue);
        var blocked = !issue.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(blocked);
        Assert.NotNull(await issue);
    }

    [Fact]
    public async Task IssueAsync_NoSuchUser_ReturnsNull()
    {
        Assert.Null(await _repo.IssueAsync(Guid.NewGuid(), NewHash(), NextWeek, null, null, SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task IssueAsync_ResetCommitsWhileTheLoginWaits_IssuesNothing()
    {
        // #1092: the login checked "old-hash"; a reset has locked the user (as ResetPasswordAsync does)
        // and set a new password, not yet committed.
        var user = await ReaderWithPasswordAsync("old-hash");
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            UPDATE users SET password_hash = 'new-hash' WHERE id = @user;
            """, new { user }, tx, cancellationToken: Ct));

        var login = _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", null, SessionKind.Reader, Ct);
        await db.WaitUntilBlockedByAsync(reset, login);
        var waited = !login.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Null(await login);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_ResetCommitsWhileATokenSignInWaits_IssuesNothing()
    {
        // #1092: a sign-in from an access token minted before the reset; the reset holds the user and
        // has stamped it, not yet committed.
        var user = await db.NewReaderAsync();
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            UPDATE users SET credentials_reset_at = now() WHERE id = @user;
            """, new { user }, tx, cancellationToken: Ct));

        var signIn = _repo.IssueAsync(user, NewHash(), NextWeek, null, DateTimeOffset.UtcNow.AddMinutes(-1), SessionKind.Reader, Ct);
        await db.WaitUntilBlockedByAsync(reset, signIn);
        var waited = !signIn.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Null(await signIn);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_PasswordAndTokenBothGiven_RefusedByTheReset()
    {
        // Both proofs are checked: a matching password does not excuse a token from before the reset.
        var user = await ReaderWithPasswordAsync("same-hash");
        await db.ExecAsync("UPDATE users SET credentials_reset_at = now() WHERE id = @user", new { user });

        Assert.Null(await _repo.IssueAsync(user, NewHash(), NextWeek, "same-hash", DateTimeOffset.UtcNow.AddMinutes(-1), SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task IssueAsync_TokenIssuedAfterTheReset_Issues()
    {
        var user = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET credentials_reset_at = now() - interval '1 minute' WHERE id = @user", new { user });

        Assert.NotNull(await _repo.IssueAsync(user, NewHash(), NextWeek, null, DateTimeOffset.UtcNow, SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task RefreshAsync_LiveSession_RotatedToASuccessorThatRemembersIt()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        var issued = (await _repo.IssueAsync(user, old, NextWeek, null, null, SessionKind.Reader, Ct))!;

        var refreshed = await RefreshAsync(old, next);

        Assert.Equal(SessionRefreshOutcome.Rotated, refreshed.Outcome);
        Assert.Equal((user, next, old), (refreshed.Session!.UserId, refreshed.Session.TokenHash, refreshed.Session.PreviousTokenHash));
        // A sign-in's family is its first session, started when it was.
        Assert.Equal((issued.Id, issued.CreatedAt), (issued.FamilyId, issued.FamilyStartedAt));
        Assert.Equal((issued.FamilyId, issued.FamilyStartedAt), (refreshed.Session.FamilyId, refreshed.Session.FamilyStartedAt));
        Assert.Equal(user, refreshed.User?.Id);
        Assert.False(await IsLiveAsync(old));
    }

    [Fact]
    public async Task RefreshAsync_LifetimeOfItsUser_IsTheSuccessorsExpiry()
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(guest, old, NextWeek, null, null, SessionKind.Reader, Ct);
        var expiresAt = DateTimeOffset.UtcNow.AddDays(3);

        var refreshed = await _repo.RefreshAsync(old, next, SessionKind.Reader, u => u.IsGuest ? expiresAt : NextWeek, DateTimeOffset.UtcNow, Ct);

        Assert.Equal(expiresAt, refreshed.Session!.ExpiresAt, TimeSpan.FromMilliseconds(1));
    }

    [Fact]
    public async Task RefreshAsync_RotatedAwayWithinTheGrace_InvalidAndTheSuccessorLives()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(old, next);

        // Two tabs refreshing at once: the second is refused, nobody is signed out.
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(old, NewHash())).Outcome);
        Assert.True(await IsLiveAsync(next));
        Assert.Equal(1L, await LiveAsync(user));
    }

    [Fact]
    public async Task RefreshAsync_GrandparentReplayedAfterTheGrace_ReusedAndEveryGenerationRevoked()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await AgeAsync(user, "1 minute");

        var replayed = await RefreshAsync(first, NewHash());

        Assert.Equal((SessionRefreshOutcome.Reused, user), (replayed.Outcome, replayed.RevokedUserId));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_GrandparentReplayedAfterTheGrace_OtherSignInsOfTheUserLive()
    {
        var user = await db.NewReaderAsync();
        var (first, second, otherDevice) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await _repo.IssueAsync(user, otherDevice, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await AgeAsync(user, "1 minute");

        Assert.Equal(SessionRefreshOutcome.Reused, (await RefreshAsync(first, NewHash())).Outcome);

        Assert.True(await IsLiveAsync(otherDevice));
    }

    [Fact]
    public async Task RefreshAsync_ReplayedAfterTheSweepDeletedIt_ReusedAndTheFamilyDies()
    {
        // #1107: the sweep may delete the spent row at any cutoff; the live successor still names the family.
        var user = await db.NewReaderAsync();
        var (first, second) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        var rotatedAt = DateTimeOffset.UtcNow;
        await RefreshAsync(first, second, now: rotatedAt);
        await _repo.DeleteExpiredSessionsAsync(rotatedAt.AddSeconds(1), Ct);
        await AgeAsync(user, "1 minute");

        Assert.Equal(SessionRefreshOutcome.Reused, (await RefreshAsync(first, NewHash())).Outcome);

        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_AdminTokenReplayedAsAReader_InvalidAndItsFamilyLives()
    {
        var admin = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET role = 'admin' WHERE id = @admin", new { admin });
        var (first, second) = (NewHash(), NewHash());
        await _repo.IssueAsync(admin, first, NextWeek, null, null, SessionKind.Admin, Ct);
        await RefreshAsync(first, second, SessionKind.Admin);
        await AgeAsync(admin, "1 minute");

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(first, NewHash(), SessionKind.Reader)).Outcome);

        Assert.True(await IsLiveAsync(second));
    }

    [Fact]
    public async Task RefreshAsync_SignInPastTheAbsoluteLifetime_InvalidAndKeepsTheSession()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        // The rows themselves are young; only the sign-in they carry is old.
        await db.ExecAsync("UPDATE user_refresh_tokens SET family_started_at = now() - interval '91 days' WHERE user_id = @user", new { user });

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(third, NewHash())).Outcome);
        Assert.True(await IsLiveAsync(third));
    }

    [Fact]
    public async Task RefreshAsync_ExpiredSession_InvalidAndIssuesNothing()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, DateTimeOffset.UtcNow.AddSeconds(-1), null, null, SessionKind.Reader, Ct);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(old, NewHash())).Outcome);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_OtherKindOrAdminSessionOfANonAdmin_Invalid()
    {
        var (reader, admin) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        await db.ExecAsync("UPDATE users SET role = 'admin' WHERE id = @admin", new { admin });
        var (readerToken, adminToken, demoted) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(admin, readerToken, NextWeek, null, null, SessionKind.Reader, Ct);
        await _repo.IssueAsync(admin, adminToken, NextWeek, null, null, SessionKind.Admin, Ct);
        await _repo.IssueAsync(reader, demoted, NextWeek, null, null, SessionKind.Admin, Ct);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(readerToken, NewHash(), SessionKind.Admin)).Outcome);
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(adminToken, NewHash(), SessionKind.Reader)).Outcome);
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(demoted, NewHash(), SessionKind.Admin)).Outcome);
        Assert.False(await _repo.RevokeAsync(adminToken, SessionKind.Reader, Ct));
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(adminToken, NewHash(), SessionKind.Admin)).Outcome);
    }

    [Fact]
    public async Task DeleteExpiredSessionsAsync_RotatedAwayRow_RemovedOnceItsCutoffPasses()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, null, SessionKind.Reader, Ct);
        var rotatedAt = DateTimeOffset.UtcNow;
        await RefreshAsync(old, next, now: rotatedAt);

        await _repo.DeleteExpiredSessionsAsync(rotatedAt.AddSeconds(1), Ct);

        Assert.True(await IsLiveAsync(next));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_UserRowHeldByAReset_WaitsForTheReset()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, null, null, SessionKind.Reader, Ct);
        // A password reset that has locked the user and not yet reached the sessions: a rotation that
        // went ahead now would commit a successor the reset's snapshot cannot see.
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var rotation = RefreshAsync(old, NewHash());
        await db.WaitUntilBlockedByAsync(reset, rotation);
        var waited = !rotation.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Equal(SessionRefreshOutcome.Rotated, (await rotation).Outcome);
    }

    [Fact]
    public async Task RevokeAsync_Session_SignsItOutOnce()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();
        await _repo.IssueAsync(user, hash, NextWeek, null, null, SessionKind.Reader, Ct);

        Assert.True(await _repo.RevokeAsync(hash, SessionKind.Reader, Ct));

        Assert.False(await IsLiveAsync(hash));
        Assert.False(await _repo.RevokeAsync(hash, SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_LiveCode_SetsThePasswordAndSignsEveryCredentialOut()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(user, NewGrant(), Ct);

        Assert.Equal(user, await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));

        var account = (await new UserRepository(db.DataSource).GetAsync(user, Ct))!;
        Assert.Equal("new-hash", account.PasswordHash);
        Assert.NotNull(account.CredentialsResetAt);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
        Assert.Equal(0, await keys.CountLiveAsync(user, Ct));
        Assert.Empty(await oauth.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_ApprovedDeviceLogin_CannotBeRedeemedAfter()
    {
        var user = await db.NewReaderAsync();
        var devices = new DeviceLoginRepository(db.DataSource);
        var login = NewDeviceLogin();
        await devices.CreateAsync(login, Ct);
        await devices.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.False(await devices.RedeemAsync(login.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
        Assert.Equal("expired", (await devices.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);
    }

    [Fact]
    public async Task ResetPasswordAsync_RotationCommitsWhileItWaits_SignsTheSuccessorOutToo()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        // A rotation in flight: the user's row locked (as RotateAsync does), its successor inserted, not yet committed.
        await using var rotator = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await rotator.BeginTransactionAsync(Ct);
        await rotator.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            INSERT INTO user_refresh_tokens (id, user_id, token_hash, kind, family_id, family_started_at, expires_at, created_at)
            VALUES (gen_random_uuid(), @user, @hash, 'reader', gen_random_uuid(), now(), now() + interval '7 days', now());
            """, new { user, hash = NewHash() }, tx, cancellationToken: Ct));

        var reset = _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(rotator, reset);
        await tx.CommitAsync(Ct);

        Assert.Equal(user, await reset);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_WaitedForARotation_StampRefusesTheTokenItMinted()
    {
        // #1107: the reset queues behind a rotation, which mints an access token after the reset's
        // transaction began; the stamp is taken once the lock is held, so that token still predates it.
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        await using var rotator = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await rotator.BeginTransactionAsync(Ct);
        await rotator.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var reset = _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(rotator, reset);
        await Task.Delay(TimeSpan.FromSeconds(1.1), Ct); // past the reset's start, in whole seconds
        var minted = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()); // the rotation's iat
        await tx.CommitAsync(Ct);
        await reset;

        var devices = new DeviceLoginRepository(db.DataSource);
        var login = NewDeviceLogin();
        await devices.CreateAsync(login, Ct);
        Assert.Null(await _repo.IssueAsync(user, NewHash(), NextWeek, null, minted, SessionKind.Reader, Ct));
        Assert.Equal("pending", await devices.DecideAsync(login.UserCode, user, minted, DateTimeOffset.UtcNow, Ct));
        Assert.Null(await new McpKeyRepository(db.DataSource).CreateAsync(user, "laptop", NewHash(), "tsk_ab", minted, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_KeyRevokedEarlier_KeepsItsFirstRevocationTime()
    {
        var user = await db.NewReaderAsync();
        var keys = new McpKeyRepository(db.DataSource);
        var key = (await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct))!;
        await keys.RevokeAsync(user, key.Id, Ct);
        var first = Assert.Single(await keys.ListAsync(user, Ct)).RevokedAt;
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.Equal(first, Assert.Single(await keys.ListAsync(user, Ct)).RevokedAt);
    }

    [Fact]
    public async Task ResetPasswordAsync_UsedCode_ReturnsNullAndChangesNothing()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        await _repo.ResetPasswordAsync(code, "first", DateTimeOffset.UtcNow, Ct);
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);

        Assert.Null(await _repo.ResetPasswordAsync(code, "second", DateTimeOffset.UtcNow, Ct));

        Assert.Equal("first", (await new UserRepository(db.DataSource).GetAsync(user, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_ExpiredCode_ReturnsNull()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddMinutes(-1), Ct);

        Assert.Null(await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_AlicesCode_LeavesBobsCredentialsAndPassword()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(alice, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        await _repo.IssueAsync(bob, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(bob, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(bob, NewGrant(), Ct);
        var devices = new DeviceLoginRepository(db.DataSource);
        var bobsLogin = NewDeviceLogin();
        await devices.CreateAsync(bobsLogin, Ct);
        await devices.DecideAsync(bobsLogin.UserCode, bob, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.Null((await new UserRepository(db.DataSource).GetAsync(bob, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", bob));
        Assert.Equal(1, await keys.CountLiveAsync(bob, Ct));
        Assert.Single(await oauth.ListLiveAsync(bob, DateTimeOffset.UtcNow, Ct));
        Assert.True(await devices.RedeemAsync(bobsLogin.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task CreatePasswordResetAsync_Code_IsTheUsersAndUnused()
    {
        var user = await db.NewReaderAsync();

        var reset = await _repo.CreatePasswordResetAsync(user, NewHash(), DateTimeOffset.UtcNow.AddHours(1), Ct);

        Assert.Equal((user, false), (reset.UserId, reset.Used));
    }

    [Fact]
    public async Task DeleteExpiredSessionsAsync_Cutoff_DeletesOnlySessionsExpiredBeforeIt()
    {
        var user = await db.NewReaderAsync();
        // Far back, so another test's sessions are never on the wrong side of this cutoff.
        var cutoff = new DateTimeOffset(2001, 1, 2, 0, 0, 0, TimeSpan.Zero);
        await _repo.IssueAsync(user, NewHash(), cutoff.AddDays(-1), null, null, SessionKind.Reader, Ct);
        // Expiring at the cutoff instant itself is not "before" it.
        await _repo.IssueAsync(user, NewHash(), cutoff, null, null, SessionKind.Reader, Ct);

        Assert.Equal(1, await _repo.DeleteExpiredSessionsAsync(cutoff, Ct));

        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task DeleteExpiredPasswordResetsAsync_Cutoff_DeletesOnlyCodesExpiredBeforeIt()
    {
        var user = await db.NewReaderAsync();
        await _repo.CreatePasswordResetAsync(user, NewHash(), new DateTimeOffset(2002, 1, 1, 0, 0, 0, TimeSpan.Zero), Ct);
        await _repo.CreatePasswordResetAsync(user, NewHash(), new DateTimeOffset(2002, 1, 3, 0, 0, 0, TimeSpan.Zero), Ct);

        Assert.Equal(1, await _repo.DeleteExpiredPasswordResetsAsync(new DateTimeOffset(2002, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(1L, await db.CountAsync("password_reset_tokens", user));
    }

    private async Task<Guid> ReaderWithPasswordAsync(string passwordHash)
    {
        var user = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET password_hash = @passwordHash WHERE id = @user", new { passwordHash, user });
        return user;
    }

    private Task<long> LiveAsync(Guid user) =>
        db.ScalarAsync<long>("SELECT count(*) FROM user_refresh_tokens WHERE user_id = @user AND expires_at > now()", new { user });
}
