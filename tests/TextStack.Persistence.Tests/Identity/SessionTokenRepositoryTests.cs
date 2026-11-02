using Dapper;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

public class SessionTokenRepositoryTests(V2PostgresFixture db)
{
    private readonly SessionTokenRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTimeOffset NextWeek => DateTimeOffset.UtcNow.AddDays(7);

    /// <summary>A family cutoff no test's chain is older than.</summary>
    private static DateTimeOffset LongAgo => DateTimeOffset.UtcNow.AddDays(-90);

    [Fact]
    public async Task IssueAsync_NewSession_IsTheUsersAndLiveUntilItExpires()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();

        var issued = (await _repo.IssueAsync(user, hash, NextWeek, null, Ct))!;

        Assert.Equal((user, hash, (string?)null), (issued.UserId, issued.TokenHash, issued.PreviousTokenHash));
        Assert.Equal(issued.Id, (await _repo.GetLiveAsync(hash, DateTimeOffset.UtcNow, Ct))?.Id);
        Assert.Null(await _repo.GetLiveAsync(hash, NextWeek.AddDays(1), Ct));
    }

    [Fact]
    public async Task IssueAsync_VerifiedHashIsStillThePassword_Issues()
    {
        var user = await ReaderWithPasswordAsync("old-hash");

        Assert.NotNull(await _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", Ct));
    }

    [Fact]
    public async Task IssueAsync_PasswordChangedSinceVerify_ReturnsNullAndStoresNothing()
    {
        var user = await ReaderWithPasswordAsync("new-hash");

        Assert.Null(await _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", Ct));
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task IssueAsync_NoPasswordChecked_DoesNotWaitForAnUpdateOfTheUser()
    {
        // A provider, guest or refresh issue must not queue behind the user row (a reset, a profile write).
        var user = await db.NewReaderAsync();
        await using var holder = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var issue = _repo.IssueAsync(user, NewHash(), NextWeek, null, Ct);
        await db.WaitUntilBlockedByAsync(holder, issue);
        var blocked = !issue.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.False(blocked);
        Assert.NotNull(await issue);
    }

    [Fact]
    public async Task IssueAsync_NoSuchUser_ReturnsNull()
    {
        Assert.Null(await _repo.IssueAsync(Guid.NewGuid(), NewHash(), NextWeek, null, Ct));
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

        var login = _repo.IssueAsync(user, NewHash(), NextWeek, "old-hash", Ct);
        await db.WaitUntilBlockedByAsync(reset, login);
        var waited = !login.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Null(await login);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RotateAsync_LiveSession_ReplacesItWithASuccessorThatRemembersIt()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);

        var successor = (await _repo.RotateAsync(user, old, next, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct))!;

        Assert.Equal((user, next, old), (successor.UserId, successor.TokenHash, successor.PreviousTokenHash));
        Assert.Null(await _repo.GetLiveAsync(old, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RotateAsync_AlreadyRotated_ReturnsNullAndIssuesNothing()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        await _repo.RotateAsync(user, old, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);

        Assert.Null(await _repo.RotateAsync(user, old, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct));
        Assert.Equal(1L, await LiveAsync(user));
    }

    [Fact]
    public async Task RotateAsync_ChainBeganBeforeTheCutoff_ReturnsNullAndKeepsTheSession()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        await _repo.RotateAsync(user, old, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);
        var next = NewHash();
        await _repo.RotateAsync(user, (await LiveHashAsync(user)), next, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);

        // The chain's first session, two generations back, is what the cutoff reads.
        Assert.Null(await _repo.RotateAsync(user, next, NewHash(), NextWeek, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(1), Ct));
        Assert.NotNull(await _repo.GetLiveAsync(next, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeFamilyAsync_GrandparentReplayed_RevokesEveryGenerationBelowIt()
    {
        var user = await db.NewReaderAsync();
        var (first, second, third) = (NewHash(), NewHash(), NewHash());
        await _repo.IssueAsync(user, first, NextWeek, null, Ct);
        await _repo.RotateAsync(user, first, second, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);
        await _repo.RotateAsync(user, second, third, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);

        Assert.Equal(user, await _repo.RevokeFamilyAsync(first, TimeSpan.Zero, Ct));

        Assert.Null(await _repo.GetLiveAsync(third, DateTimeOffset.UtcNow, Ct));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user)); // the replayed row itself, dead
    }

    [Fact]
    public async Task DeleteExpiredSessionsAsync_RotatedAwayRow_RemovedOnceItsCutoffPasses()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        var rotatedAt = DateTimeOffset.UtcNow;
        await _repo.RotateAsync(user, old, next, NextWeek, rotatedAt, LongAgo, Ct);

        await _repo.DeleteExpiredSessionsAsync(rotatedAt.AddSeconds(1), Ct);

        Assert.Equal(next, await LiveHashAsync(user));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RotateAsync_AnotherUsersSession_ReturnsNullAndKeepsIt()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var hers = NewHash();
        await _repo.IssueAsync(alice, hers, NextWeek, null, Ct);

        Assert.Null(await _repo.RotateAsync(bob, hers, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct));
        Assert.NotNull(await _repo.GetLiveAsync(hers, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RotateAsync_ExpiredSession_ReturnsNullAndIssuesNothing()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, DateTimeOffset.UtcNow.AddSeconds(-1), null, Ct);

        Assert.Null(await _repo.RotateAsync(user, old, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RotateAsync_UserRowHeldByAReset_WaitsForTheReset()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        // A password reset that has locked the user and not yet reached the sessions: a rotation that
        // went ahead now would commit a successor the reset's snapshot cannot see.
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var rotation = _repo.RotateAsync(user, old, NewHash(), NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);
        await db.WaitUntilBlockedByAsync(reset, rotation);
        var waited = !rotation.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.NotNull(await rotation);
    }

    [Fact]
    public async Task RevokeFamilyAsync_ReusedRotatedToken_RevokesItsSuccessor()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        await _repo.RotateAsync(user, old, next, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);

        // The spent token comes back past the grace: two parties hold the chain.
        Assert.Equal(user, await _repo.RevokeFamilyAsync(old, TimeSpan.Zero, Ct));

        Assert.Null(await _repo.GetLiveAsync(next, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeFamilyAsync_SuccessorWithinTheGrace_KeepsIt()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, null, Ct);
        await _repo.RotateAsync(user, old, next, NextWeek, DateTimeOffset.UtcNow, LongAgo, Ct);

        Assert.Null(await _repo.RevokeFamilyAsync(old, TimeSpan.FromSeconds(30), Ct));
        Assert.NotNull(await _repo.GetLiveAsync(next, DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeAsync_Session_SignsItOutOnce()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();
        await _repo.IssueAsync(user, hash, NextWeek, null, Ct);

        Assert.True(await _repo.RevokeAsync(hash, Ct));

        Assert.Null(await _repo.GetLiveAsync(hash, DateTimeOffset.UtcNow, Ct));
        Assert.False(await _repo.RevokeAsync(hash, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_LiveCode_SetsThePasswordAndSignsEveryCredentialOut()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, Ct);
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(user, NewGrant(), Ct);

        Assert.Equal(user, await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct));

        Assert.Equal("new-hash", (await new UserRepository(db.DataSource).GetAsync(user, Ct))!.PasswordHash);
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
        await devices.CreateAsync(login, DateTimeOffset.UtcNow, Ct);
        await devices.DecideAsync(login.UserCode, user, DateTimeOffset.UtcNow, Ct);
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, DateTimeOffset.UtcNow.AddHours(1), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.Null(await devices.RedeemAsync(login.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
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
            INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (gen_random_uuid(), @user, @hash, now() + interval '7 days', now());
            """, new { user, hash = NewHash() }, tx, cancellationToken: Ct));

        var reset = _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);
        await db.WaitUntilBlockedByAsync(rotator, reset);
        await tx.CommitAsync(Ct);

        Assert.Equal(user, await reset);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_KeyRevokedEarlier_KeepsItsFirstRevocationTime()
    {
        var user = await db.NewReaderAsync();
        var keys = new McpKeyRepository(db.DataSource);
        var key = await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", Ct);
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
        await _repo.IssueAsync(user, NewHash(), NextWeek, null, Ct);

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
        await _repo.IssueAsync(bob, NewHash(), NextWeek, null, Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(bob, "laptop", NewHash(), "tsk_ab", Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(bob, NewGrant(), Ct);
        var devices = new DeviceLoginRepository(db.DataSource);
        var bobsLogin = NewDeviceLogin();
        await devices.CreateAsync(bobsLogin, DateTimeOffset.UtcNow, Ct);
        await devices.DecideAsync(bobsLogin.UserCode, bob, DateTimeOffset.UtcNow, Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", DateTimeOffset.UtcNow, Ct);

        Assert.Null((await new UserRepository(db.DataSource).GetAsync(bob, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", bob));
        Assert.Equal(1, await keys.CountLiveAsync(bob, Ct));
        Assert.Single(await oauth.ListLiveAsync(bob, DateTimeOffset.UtcNow, Ct));
        Assert.Equal(bob, await devices.RedeemAsync(bobsLogin.Id, NewHash(), NextWeek, DateTimeOffset.UtcNow, Ct));
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
        await _repo.IssueAsync(user, NewHash(), cutoff.AddDays(-1), null, Ct);
        // Expiring at the cutoff instant itself is not "before" it.
        await _repo.IssueAsync(user, NewHash(), cutoff, null, Ct);

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

    private Task<string> LiveHashAsync(Guid user) =>
        db.ScalarAsync<string>("SELECT token_hash FROM user_refresh_tokens WHERE user_id = @user AND expires_at > now()", new { user });
}
