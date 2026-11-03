using Application.Identity;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The legacy-shared sweeps on V2, and the session protocol, which only V2 implements on the port.</summary>
public class SessionTokenRepositoryTests(V2PostgresFixture db) : SessionTokenRepositoryContract(db, new SessionTokenRepository(db.DataSource))
{
    private readonly SessionTokenRepository _repo = new(db.DataSource);

    protected override Task SeedSessionAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt) =>
        _repo.IssueAsync(userId, tokenHash, expiresAt, null, null, SessionKind.Reader, Ct);

    protected override Task SeedPasswordResetAsync(Guid userId, string tokenHash, DateTimeOffset expiresAt) =>
        _repo.CreatePasswordResetAsync(userId, tokenHash, expiresAt, Ct);

    private static DateTimeOffset NextWeek => DateTimeOffset.UtcNow.AddDays(7);

    private static readonly DateTimeOffset Stamp = new(2030, 1, 1, 12, 0, 0, 500, TimeSpan.Zero);

    // A second back by default: the spent row's expires_at is this clock, IsLiveAsync compares it with
    // the database's now(), and the two may differ by a few milliseconds.
    private Task<SessionRefresh> RefreshAsync(string old, string next, SessionKind kind = SessionKind.Reader, DateTimeOffset? now = null) =>
        _repo.RefreshAsync(old, next, kind, _ => NextWeek, now ?? DateTimeOffset.UtcNow.AddSeconds(-1), Ct);

    private Task<bool> IsLiveAsync(string hash) =>
        db.ScalarAsync<bool>("SELECT EXISTS (SELECT FROM user_refresh_tokens WHERE token_hash = @hash AND expires_at > now())", new { hash });

    private Task<Guid> FamilyOfAsync(string hash) =>
        db.ScalarAsync<Guid>("SELECT family_id FROM user_refresh_tokens WHERE token_hash = @hash", new { hash });

    /// <summary>Whether a token issued at <paramref name="iat"/> mints a session, approves a device login, creates an MCP key.</summary>
    private async Task<(bool Session, bool Approval, bool Key)> MintAllAsync(Guid user, DateTimeOffset iat)
    {
        var devices = new DeviceLoginRepository(db.DataSource);
        var login = NewDeviceLogin();
        await devices.CreateAsync(login, Ct);
        return (
            await _repo.IssueAsync(user, NewHash(), NextWeek, null, iat, SessionKind.Reader, Ct) is not null,
            await devices.DecideAsync(login.UserCode, user, iat, DateTimeOffset.UtcNow, Ct) == DeviceLogin.Approved,
            await new McpKeyRepository(db.DataSource).CreateAsync(user, "k", NewHash(), "tsk_ab", iat, Ct) is not null);
    }

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

        var (waited, issued) = await db.WhileUserHeldAsync(user, null,
            () => _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct));

        Assert.True(waited);
        Assert.NotNull(issued);
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

        var (waited, login) = await db.WhileUserHeldAsync(user, "UPDATE users SET password_hash = 'new-hash' WHERE id = @user;",
            () => _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", null, SessionKind.Reader, Ct));

        Assert.True(waited);
        Assert.Null(login);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_ResetCommitsWhileATokenSignInWaits_IssuesNothing()
    {
        // #1092: a sign-in from an access token minted before the reset; the reset holds the user and
        // has stamped it, not yet committed.
        var user = await db.NewReaderAsync();

        var (waited, signIn) = await db.WhileUserHeldAsync(user, "UPDATE users SET credentials_reset_at = now() WHERE id = @user;",
            () => _repo.IssueAsync(user, NewHash(), NextWeek, null, DateTimeOffset.UtcNow.AddMinutes(-1), SessionKind.Reader, Ct));

        Assert.True(waited);
        Assert.Null(signIn);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_PasswordAndTokenBothGiven_RefusedByTheReset()
    {
        // Both proofs are checked: a matching password does not excuse a token from before the reset.
        var user = await ReaderWithPasswordAsync("same-hash");
        await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);

        Assert.Null(await _repo.IssueAsync(user, NewHash(), NextWeek, "same-hash", DateTimeOffset.UtcNow.AddMinutes(-1), SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task EveryPath_TokenOfTheResetsOwnSecond_Refused()
    {
        var user = await db.NewReaderAsync();
        await db.ResetCredentialsAtAsync(user, Stamp);

        // iat has whole seconds: a token minted 12:00:00.7, after a reset at 12:00:00.5, says 12:00:00.
        Assert.Equal((false, false, false), await MintAllAsync(user, Stamp.AddMilliseconds(-500)));
    }

    [Fact]
    public async Task EveryPath_IatEqualToTheStamp_Accepted()
    {
        var user = await db.NewReaderAsync();
        await db.ResetCredentialsAtAsync(user, Stamp);

        Assert.Equal((true, true, true), await MintAllAsync(user, Stamp));
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
        // A sign-in's family is its first session.
        Assert.Equal((issued.Id, issued.Id), (await FamilyOfAsync(old), await FamilyOfAsync(next)));
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
        await db.AgeSessionsAsync(user, "1 minute");

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
        await db.AgeSessionsAsync(user, "1 minute");

        Assert.Equal(SessionRefreshOutcome.Reused, (await RefreshAsync(first, NewHash())).Outcome);

        Assert.True(await IsLiveAsync(otherDevice));
    }

    [Theory]
    [InlineData(SessionKind.Admin, SessionKind.Reader)]
    [InlineData(SessionKind.Reader, SessionKind.Admin)]
    public async Task RefreshAsync_RotatedTokenReplayedAsTheOtherKind_InvalidAndItsFamilyLives(SessionKind issuedAs, SessionKind replayedAs)
    {
        var admin = await db.NewAdminAsync();
        var (first, second) = (NewHash(), NewHash());
        await _repo.IssueAsync(admin, first, NextWeek, null, null, issuedAs, Ct);
        await RefreshAsync(first, second, issuedAs);
        await db.AgeSessionsAsync(admin, "1 minute");

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(first, NewHash(), replayedAs)).Outcome);

        Assert.True(await IsLiveAsync(second));
        Assert.False(await _repo.RevokeAsync(second, replayedAs, Ct));
    }

    [Fact]
    public async Task RefreshAsync_AdminRotatedTwice_StaysAdminAndNeverAReader()
    {
        var admin = await db.NewAdminAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(admin, first, NextWeek, null, null, SessionKind.Admin, Ct);
        await RefreshAsync(first, second, SessionKind.Admin);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(second, NewHash(), SessionKind.Reader)).Outcome);
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(second, third, SessionKind.Admin)).Outcome);
    }

    [Fact]
    public async Task RefreshAsync_SignInPastTheAbsoluteLifetime_InvalidAndKeepsTheSession()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        // Only the family's first row is old: the cap reads it, two generations back.
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '91 days' WHERE token_hash = @first", new { first });

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
        var (reader, admin) = (await db.NewReaderAsync(), await db.NewAdminAsync());
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
    public async Task DeleteExpiredSessionsAsync_SpentRowsOfALiveFamily_KeptSoTheFirstTokenReplayedIsCaught()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await db.AgeSessionsAsync(user, "1 minute");
        // The spent rows, into a past no other test uses: the sweep is cross-user.
        await db.ExecAsync("UPDATE user_refresh_tokens SET expires_at = '1997-01-01Z' WHERE user_id = @user AND token_hash <> @third", new { user, third });

        Assert.Equal(0, await _repo.DeleteExpiredSessionsAsync(new DateTimeOffset(1997, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(SessionRefreshOutcome.Reused, (await RefreshAsync(first, NewHash())).Outcome);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task DeleteExpiredSessionsAsync_FamilyWithNoLiveSession_SweptWhole()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await db.ExecAsync("UPDATE user_refresh_tokens SET expires_at = '1996-01-01Z' WHERE user_id = @user", new { user });

        Assert.Equal(3, await _repo.DeleteExpiredSessionsAsync(new DateTimeOffset(1996, 1, 2, 0, 0, 0, TimeSpan.Zero), Ct));

        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RefreshAsync_UserRowHeldByAReset_WaitsForTheReset()
    {
        // A password reset that has locked the user and not yet reached the sessions: a rotation that
        // went ahead now would commit a successor the reset's snapshot cannot see.
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, null, null, SessionKind.Reader, Ct);

        var (waited, rotation) = await db.WhileUserHeldAsync(user, null, () => RefreshAsync(old, NewHash()));

        Assert.True(waited);
        Assert.Equal(SessionRefreshOutcome.Rotated, rotation.Outcome);
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
    public async Task RevokeAsync_SpentToken_FalseAndTheFamilyKeepsItsFirstRow()
    {
        // The first row carries the sign-in's start: signing out with a spent token must not delete it.
        var user = await db.NewReaderAsync();
        var (first, second) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);

        Assert.False(await _repo.RevokeAsync(first, SessionKind.Reader, Ct));

        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(second, NewHash())).Outcome);
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
        await oauth.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), NewGrant(), Ct);

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
        var login = await db.ApprovedDeviceLoginAsync(user);
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.False(await devices.RedeemAsync(login.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
        Assert.Equal("expired", (await devices.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);
    }

    [Fact]
    public async Task ResetPasswordAsync_RotationCommitsWhileItWaits_SignsTheSuccessorOutToo()
    {
        // A rotation in flight: the user's row locked (as RefreshAsync does), its successor inserted, not yet committed.
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);

        var (_, reset) = await db.WhileUserHeldAsync(user, """
            INSERT INTO user_refresh_tokens (id, user_id, token_hash, kind, family_id, expires_at, created_at)
            VALUES (gen_random_uuid(), @user, md5(random()::text), 'reader', gen_random_uuid(), now() + interval '7 days', now());
            """, () => _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));

        Assert.Equal(user, reset);
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
        var minted = DateTimeOffset.MinValue;

        await db.WhileUserHeldAsync(user, null, () => _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct), async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(1.1), Ct); // past the reset's start, in whole seconds
            minted = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()); // the rotation's iat
        });

        Assert.Equal((false, false, false), await MintAllAsync(user, minted));
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
        await oauth.ConnectAsync(bob, await db.ApprovedOAuthRequestAsync(bob), NewGrant(), Ct);
        var bobsLogin = await db.ApprovedDeviceLoginAsync(bob);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.Null((await new UserRepository(db.DataSource).GetAsync(bob, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", bob));
        Assert.Equal(1, await keys.CountLiveAsync(bob, Ct));
        Assert.Single(await oauth.ListLiveAsync(bob, DateTimeOffset.UtcNow, Ct));
        Assert.True(await new DeviceLoginRepository(db.DataSource).RedeemAsync(bobsLogin.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task CreatePasswordResetAsync_Code_IsTheUsersAndUnused()
    {
        var user = await db.NewReaderAsync();

        var reset = await _repo.CreatePasswordResetAsync(user, NewHash(), DateTimeOffset.UtcNow.AddHours(1), Ct);

        Assert.Equal((user, false), (reset.UserId, reset.Used));
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
