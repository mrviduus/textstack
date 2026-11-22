using Application.Identity;
using Domain.Identity;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The legacy-shared sweeps on V2, and the session protocol, which only V2 implements on the port.</summary>
public class SessionTokenRepositoryTests(PostgresFixture db) : SessionTokenRepositoryContract(db, new SessionTokenRepository(db.DataSource))
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

    [Theory]
    // The password checked at login is still the password.
    [InlineData("old-hash", "old-hash", false, true)]
    // The password changed between the check and the insert.
    [InlineData("new-hash", "old-hash", false, false)]
    // Both proofs are checked: a matching password does not excuse a token from before the reset.
    [InlineData("same-hash", "same-hash", true, false)]
    public async Task IssueAsync_ProofOfTheSignIn_IssuesOnlyWhileItStillHolds(string password, string verified, bool tokenBeforeReset, bool issues)
    {
        var user = await ReaderWithPasswordAsync(password);
        DateTimeOffset? iat = null;
        if (tokenBeforeReset)
        {
            await db.ResetCredentialsAtAsync(user, DateTimeOffset.UtcNow);
            iat = DateTimeOffset.UtcNow.AddMinutes(-1);
        }

        var session = await _repo.IssueAsync(user, NewHash(), NextWeek, verified, iat, SessionKind.Reader, Ct);

        Assert.Equal(issues, session is not null);
        Assert.Equal(issues ? 1L : 0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Theory]
    // iat has whole seconds: a token minted 12:00:00.7, after a reset at 12:00:00.5, says 12:00:00.
    [InlineData(-500, false)]
    [InlineData(0, true)]
    public async Task EveryPath_TokenAgainstTheResetStamp_RefusedWithinItsSecondAcceptedFromIt(int iatMsFromStamp, bool accepted)
    {
        var user = await db.NewReaderAsync();
        await db.ResetCredentialsAtAsync(user, Stamp);

        Assert.Equal((accepted, accepted, accepted), await MintAllAsync(user, Stamp.AddMilliseconds(iatMsFromStamp)));
    }

    [Theory]
    // #1107: a Google, Apple, guest or test sign-in queues behind a reset too, or it could commit
    // beside the reset unseen by its sign-out.
    [InlineData(null, null, false, true)]
    // #1092: the login checked "old-hash"; the reset sets a new password, not yet committed.
    [InlineData("UPDATE users SET password_hash = 'new-hash' WHERE id = @user;", "old-hash", false, false)]
    // #1092: a sign-in from an access token minted before the reset, which has stamped the user, not yet committed.
    [InlineData("UPDATE users SET credentials_reset_at = now() WHERE id = @user;", null, true, false)]
    public async Task IssueAsync_ResetHoldsTheUser_WaitsAndIssuesOnlyIfItsProofSurvived(string? resetSql, string? verified, bool withToken, bool issues)
    {
        var user = await ReaderWithPasswordAsync("old-hash");
        DateTimeOffset? iat = withToken ? DateTimeOffset.UtcNow.AddMinutes(-1) : null;

        var (waited, session) = await db.WhileUserHeldAsync(user, resetSql,
            () => _repo.IssueAsync(user, NewHash(), NextWeek, verified, iat, SessionKind.Reader, Ct));

        Assert.True(waited);
        Assert.Equal(issues, session is not null);
        Assert.Equal(issues ? 1L : 0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_SignInRefreshedAndSignedOut_OneFamilyFromItsFirstSessionToItsLast()
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        var issued = (await _repo.IssueAsync(guest, first, NextWeek, null, null, SessionKind.Reader, Ct))!;
        Assert.Equal((guest, first, (string?)null), (issued.UserId, issued.TokenHash, issued.PreviousTokenHash));
        Assert.True(await IsLiveAsync(first));

        // The successor lives as long as its user's kind of session does: a guest's is shorter.
        var guestLifetime = DateTimeOffset.UtcNow.AddDays(3);
        var refreshed = await _repo.RefreshAsync(first, second, SessionKind.Reader,
            u => u.IsGuest ? guestLifetime : NextWeek, DateTimeOffset.UtcNow.AddSeconds(-1), Ct);

        Assert.Equal(SessionRefreshOutcome.Rotated, refreshed.Outcome);
        Assert.Equal((guest, second, first), (refreshed.Session!.UserId, refreshed.Session.TokenHash, refreshed.Session.PreviousTokenHash));
        Assert.Equal(guestLifetime, refreshed.Session.ExpiresAt, TimeSpan.FromMilliseconds(1));
        // A sign-in's family is its first session.
        Assert.Equal((issued.Id, issued.Id), (await FamilyOfAsync(first), await FamilyOfAsync(second)));
        Assert.Equal(guest, refreshed.User?.Id);
        Assert.False(await IsLiveAsync(first));

        // Past its expiry the successor refreshes nothing.
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(second, NewHash(), now: guestLifetime.AddDays(1))).Outcome);
        Assert.True(await IsLiveAsync(second));
        Assert.Equal(2L, await db.CountAsync("user_refresh_tokens", guest));

        // Signing out with the spent token is refused and keeps the family's first row, whose start
        // the next rotation reads.
        Assert.False(await _repo.RevokeAsync(first, SessionKind.Reader, Ct));
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(second, third)).Outcome);

        Assert.True(await _repo.RevokeAsync(third, SessionKind.Reader, Ct));
        Assert.False(await IsLiveAsync(third));
        Assert.False(await _repo.RevokeAsync(third, SessionKind.Reader, Ct));

        // A sign-in of nobody starts nothing.
        Assert.Null(await _repo.IssueAsync(Guid.NewGuid(), NewHash(), NextWeek, null, null, SessionKind.Reader, Ct));
    }

    [Fact]
    public async Task RefreshAsync_RotatedTokenReplayed_RefusedInTheGraceThenItsWholeFamilyRevoked()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third, otherDevice) = (NewHash(), NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await _repo.IssueAsync(user, otherDevice, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);

        // Two tabs refreshing at once: the second is refused, nobody is signed out, nothing is minted.
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(second, NewHash())).Outcome);
        Assert.True(await IsLiveAsync(third));
        Assert.Equal(2L, await LiveAsync(user));

        await db.AgeSessionsAsync(user, "1 minute");
        var replayed = await RefreshAsync(first, NewHash());

        // The grandparent, past the grace: every generation of its sign-in goes, the other sign-in stays.
        Assert.Equal((SessionRefreshOutcome.Reused, user), (replayed.Outcome, replayed.RevokedUserId));
        Assert.False(await IsLiveAsync(third));
        Assert.True(await IsLiveAsync(otherDevice));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Theory]
    [InlineData(SessionKind.Admin, SessionKind.Reader)]
    [InlineData(SessionKind.Reader, SessionKind.Admin)]
    public async Task RefreshAsync_TokenPresentedAsTheOtherKind_InvalidAndItsFamilyLives(SessionKind issuedAs, SessionKind presentedAs)
    {
        var admin = await db.NewAdminAsync();
        var (first, second) = (NewHash(), NewHash());
        await _repo.IssueAsync(admin, first, NextWeek, null, null, issuedAs, Ct);
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(first, second, issuedAs)).Outcome);

        // The live session, as the other kind, is no session.
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(second, NewHash(), presentedAs)).Outcome);

        // Past the grace, neither signing it out nor replaying its spent token as the other kind revokes anything.
        await db.AgeSessionsAsync(admin, "1 minute");
        Assert.False(await _repo.RevokeAsync(second, presentedAs, Ct));
        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(first, NewHash(), presentedAs)).Outcome);
        Assert.True(await IsLiveAsync(second));

        // The rotation kept the kind: as its own kind it rotates on.
        Assert.Equal(SessionRefreshOutcome.Rotated, (await RefreshAsync(second, NewHash(), issuedAs)).Outcome);
    }

    [Fact]
    public async Task RefreshAsync_ExpiredTooOldOrNoLongerAdmin_InvalidAndTheSessionUntouched()
    {
        var expiredUser = await db.NewReaderAsync();
        var expired = NewHash();
        await _repo.IssueAsync(expiredUser, expired, DateTimeOffset.UtcNow.AddSeconds(-1), null, null, SessionKind.Reader, Ct);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(expired, NewHash())).Outcome);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", expiredUser));

        // The absolute lifetime is the sign-in's: only the family's first row is old, two generations back.
        var longUser = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(longUser, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await db.ExecAsync("UPDATE user_refresh_tokens SET created_at = now() - interval '91 days' WHERE token_hash = @first", new { first });

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(third, NewHash())).Outcome);
        Assert.True(await IsLiveAsync(third));

        // An admin session held by a user who is not an admin.
        var demotedUser = await db.NewReaderAsync();
        var demoted = NewHash();
        await _repo.IssueAsync(demotedUser, demoted, NextWeek, null, null, SessionKind.Admin, Ct);

        Assert.Equal(SessionRefreshOutcome.Invalid, (await RefreshAsync(demoted, NewHash(), SessionKind.Admin)).Outcome);
        Assert.True(await IsLiveAsync(demoted));
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
    public async Task DeleteExpiredSessionsAsync_Families_SweptWholeOnlyOnceNoneOfThemLives()
    {
        var (liveUser, deadUser) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(liveUser, first, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(first, second);
        await RefreshAsync(second, third);
        await db.AgeSessionsAsync(liveUser, "1 minute");
        var (deadFirst, deadSecond) = (NewHash(), NewHash());
        await _repo.IssueAsync(deadUser, deadFirst, NextWeek, null, null, SessionKind.Reader, Ct);
        await RefreshAsync(deadFirst, deadSecond);
        // A day before the shared cutoff (SweepCutoff's rule): the sweep is cross-user, so only these rows are checked.
        await db.ExecAsync("UPDATE user_refresh_tokens SET expires_at = @before WHERE (user_id = @liveUser AND token_hash <> @third) OR user_id = @deadUser",
            new { before = SweepCutoff.AddDays(-1), liveUser, third, deadUser });

        await _repo.DeleteExpiredSessionsAsync(SweepCutoff, Ct);

        Assert.Equal(0L, await RowsAsync(deadFirst, deadSecond));
        Assert.Equal(3L, await RowsAsync(first, second, third));
        // The live family's spent rows were kept, so its first token replayed is still caught.
        Assert.Equal(SessionRefreshOutcome.Reused, (await RefreshAsync(first, NewHash())).Outcome);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", liveUser));
    }

    [Fact]
    public async Task ResetPasswordAsync_LiveCode_SetsThePasswordSignsEveryCredentialOutAndIsSpent()
    {
        var user = await ReaderWithPasswordAsync("old-hash");
        var keys = new McpKeyRepository(db.DataSource);
        var oauth = new OAuthRepository(db.DataSource);
        var devices = new DeviceLoginRepository(db.DataSource);
        var users = new UserRepository(db.DataSource);
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);
        var oldKey = (await keys.CreateAsync(user, "old", NewHash(), "tsk_cd", DateTimeOffset.UtcNow, Ct))!;
        await keys.RevokeAsync(user, oldKey.Id, Ct);
        var revokedAt = (await keys.ListAsync(user, Ct)).Single(k => k.Id == oldKey.Id).RevokedAt;
        Assert.NotNull(revokedAt);
        await oauth.ConnectAsync(user, await db.ApprovedOAuthRequestAsync(user), NewGrant(), Ct);
        var login = await db.ApprovedDeviceLoginAsync(user);
        var expiredCode = NewHash();
        await _repo.CreatePasswordResetAsync(user, expiredCode, DateTimeOffset.UtcNow.AddMinutes(-1), Ct);
        var code = NewHash();
        var created = await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        Assert.Equal((user, false), (created.UserId, created.Used));
        // iat comes from the api's clock; the stamp it is compared with must too, or skew is a window.
        var apiNow = DateTimeOffset.UtcNow.AddMinutes(-3).AddTicks(-7); // a skewed api clock, sub-millisecond
        var repo = new SessionTokenRepository(db.DataSource, new UnitTests.SteppedClock { Now = apiNow });

        Assert.Equal(user, await repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));

        var account = (await users.GetAsync(user, Ct))!;
        Assert.Equal("new-hash", account.PasswordHash);
        Assert.Equal(apiNow.UtcTicks / 10, account.CredentialsResetAt!.Value.UtcTicks / 10); // timestamptz keeps microseconds
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
        Assert.Equal(0, await keys.CountLiveAsync(user, Ct));
        Assert.Equal(revokedAt, (await keys.ListAsync(user, Ct)).Single(k => k.Id == oldKey.Id).RevokedAt);
        Assert.Empty(await oauth.ListLiveAsync(user, DateTimeOffset.UtcNow, Ct));
        Assert.False(await devices.RedeemAsync(login.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
        Assert.Equal("expired", (await devices.GetByDeviceCodeAsync(login.DeviceCodeHash, Ct))!.Status);

        // The code is spent: a second use changes nothing, nor signs out the session that followed.
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        Assert.Null(await repo.ResetPasswordAsync(code, "second", DateTimeOffset.UtcNow, Ct));
        Assert.Equal("new-hash", (await users.GetAsync(user, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));

        // Nor does an expired code.
        Assert.Null(await repo.ResetPasswordAsync(expiredCode, "too-late", DateTimeOffset.UtcNow, Ct));
        Assert.Equal("new-hash", (await users.GetAsync(user, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_RotationInFlight_SignsItsSuccessorOutAndRefusesTheTokenItMinted()
    {
        // A rotation holds the user (as RefreshAsync does) with its successor inserted, not yet committed,
        // and mints an access token after the reset's transaction began. #1107: the stamp is taken once
        // the lock is held, so that token still predates it.
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        var minted = DateTimeOffset.MinValue;

        var (waited, reset) = await db.WhileUserHeldAsync(user, """
            INSERT INTO user_refresh_tokens (id, user_id, token_hash, kind, family_id, expires_at, created_at)
            VALUES (gen_random_uuid(), @user, md5(random()::text), 'reader', gen_random_uuid(), now() + interval '7 days', now());
            """, () => _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct), async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(1.1), Ct); // past the reset's start, in whole seconds
            minted = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds()); // the rotation's iat
        });

        Assert.True(waited);
        Assert.Equal(user, reset);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
        Assert.Equal((false, false, false), await MintAllAsync(user, minted));
    }

    [Fact]
    public async Task ResetPasswordAsync_AlicesCode_LeavesBobsCredentialsAndPassword()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await ReaderWithPasswordAsync("bobs-hash"));
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(alice, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        await _repo.IssueAsync(bob, NewHash(), NextWeek, null, null, SessionKind.Reader, Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(bob, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(bob, await db.ApprovedOAuthRequestAsync(bob), NewGrant(), Ct);
        var bobsLogin = await db.ApprovedDeviceLoginAsync(bob);

        Assert.Equal(alice, await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));

        Assert.Equal("bobs-hash", (await new UserRepository(db.DataSource).GetAsync(bob, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", bob));
        Assert.Equal(1, await keys.CountLiveAsync(bob, Ct));
        Assert.Single(await oauth.ListLiveAsync(bob, DateTimeOffset.UtcNow, Ct));
        Assert.True(await new DeviceLoginRepository(db.DataSource).RedeemAsync(bobsLogin.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
    }

    private async Task<Guid> ReaderWithPasswordAsync(string passwordHash)
    {
        var user = await db.NewReaderAsync();
        await db.ExecAsync("UPDATE users SET password_hash = @passwordHash WHERE id = @user", new { passwordHash, user });
        return user;
    }

    private Task<long> RowsAsync(params string[] hashes) =>
        db.ScalarAsync<long>("SELECT count(*) FROM user_refresh_tokens WHERE token_hash = ANY(@hashes)", new { hashes });

    private Task<long> LiveAsync(Guid user) =>
        db.ScalarAsync<long>("SELECT count(*) FROM user_refresh_tokens WHERE user_id = @user AND expires_at > now()", new { user });
}
