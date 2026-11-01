using Dapper;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Identity;

public class SessionTokenRepositoryTests(V2PostgresFixture db)
{
    private readonly SessionTokenRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static DateTimeOffset Now => DateTimeOffset.UtcNow;
    private static DateTimeOffset NextWeek => DateTimeOffset.UtcNow.AddDays(7);
    private static string NewHash() => V2PostgresFixture.PayloadSha256(Guid.NewGuid().ToString());

    [Fact]
    public async Task IssueAsync_NewSession_IsTheUsersAndLiveUntilItExpires()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();

        var issued = await _repo.IssueAsync(user, hash, NextWeek, Ct);

        Assert.Equal((user, hash, (string?)null), (issued.UserId, issued.TokenHash, issued.PreviousTokenHash));
        Assert.Equal(issued.Id, (await _repo.GetLiveAsync(hash, Now, Ct))?.Id);
        Assert.Null(await _repo.GetLiveAsync(hash, NextWeek.AddDays(1), Ct));
    }

    [Fact]
    public async Task RotateAsync_LiveSession_ReplacesItWithASuccessorThatRemembersIt()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, Ct);

        var successor = (await _repo.RotateAsync(user, old, next, NextWeek, Now, Ct))!;

        Assert.Equal((user, next, old), (successor.UserId, successor.TokenHash, successor.PreviousTokenHash));
        Assert.Null(await _repo.GetLiveAsync(old, Now, Ct));
    }

    [Fact]
    public async Task RotateAsync_AlreadyRotated_ReturnsNullAndIssuesNothing()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, Ct);
        await _repo.RotateAsync(user, old, NewHash(), NextWeek, Now, Ct);

        Assert.Null(await _repo.RotateAsync(user, old, NewHash(), NextWeek, Now, Ct));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RotateAsync_AnotherUsersSession_ReturnsNullAndKeepsIt()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var hers = NewHash();
        await _repo.IssueAsync(alice, hers, NextWeek, Ct);

        Assert.Null(await _repo.RotateAsync(bob, hers, NewHash(), NextWeek, Now, Ct));
        Assert.NotNull(await _repo.GetLiveAsync(hers, Now, Ct));
    }

    [Fact]
    public async Task RotateAsync_ExpiredSession_ReturnsNullAndIssuesNothing()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, Now.AddSeconds(-1), Ct);

        Assert.Null(await _repo.RotateAsync(user, old, NewHash(), NextWeek, Now, Ct));
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task RotateAsync_UserRowHeldByAReset_WaitsForTheReset()
    {
        var user = await db.NewReaderAsync();
        var old = NewHash();
        await _repo.IssueAsync(user, old, NextWeek, Ct);
        // A password reset that has locked the user and not yet reached the sessions: a rotation that
        // went ahead now would commit a successor the reset's snapshot cannot see.
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE", new { user }, tx, cancellationToken: Ct));

        var rotation = _repo.RotateAsync(user, old, NewHash(), NextWeek, Now, Ct);
        await db.WaitUntilBlockedByAsync(reset, rotation);
        var waited = !rotation.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.NotNull(await rotation);
    }

    [Fact]
    public async Task RevokeSuccessorsOfAsync_ReusedRotatedToken_RevokesItsSuccessor()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, Ct);
        await _repo.RotateAsync(user, old, next, NextWeek, Now, Ct);

        // The spent token comes back past the grace: two parties hold the chain.
        Assert.Equal(user, await _repo.RevokeSuccessorsOfAsync(old, TimeSpan.Zero, Ct));

        Assert.Null(await _repo.GetLiveAsync(next, Now, Ct));
    }

    [Fact]
    public async Task RevokeSuccessorsOfAsync_SuccessorWithinTheGrace_KeepsIt()
    {
        var user = await db.NewReaderAsync();
        var (old, next) = (NewHash(), NewHash());
        await _repo.IssueAsync(user, old, NextWeek, Ct);
        await _repo.RotateAsync(user, old, next, NextWeek, Now, Ct);

        Assert.Null(await _repo.RevokeSuccessorsOfAsync(old, TimeSpan.FromSeconds(30), Ct));
        Assert.NotNull(await _repo.GetLiveAsync(next, Now, Ct));
    }

    [Fact]
    public async Task RevokeAsync_Session_SignsItOutOnce()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();
        await _repo.IssueAsync(user, hash, NextWeek, Ct);

        Assert.True(await _repo.RevokeAsync(hash, Ct));

        Assert.Null(await _repo.GetLiveAsync(hash, Now, Ct));
        Assert.False(await _repo.RevokeAsync(hash, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_LiveCode_SetsThePasswordAndSignsEveryCredentialOut()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.IssueAsync(user, NewHash(), NextWeek, Ct);
        await _repo.CreatePasswordResetAsync(user, code, Now.AddHours(1), Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(user, "laptop", NewHash(), "tsk_ab", Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(user, OAuthRepositoryTests.Grant(), Ct);

        Assert.Equal(user, await _repo.ResetPasswordAsync(code, "new-hash", Now, Ct));

        Assert.Equal("new-hash", (await new UserRepository(db.DataSource).GetAsync(user, Ct))!.PasswordHash);
        Assert.Equal(0L, await db.CountAsync("user_refresh_tokens", user));
        Assert.Equal(0, await keys.CountLiveAsync(user, Ct));
        Assert.Empty(await oauth.ListLiveAsync(user, Now, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_RotationCommitsWhileItWaits_SignsTheSuccessorOutToo()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, Now.AddHours(1), Ct);
        // A rotation in flight: the user's row locked (as RotateAsync does), its successor inserted, not yet committed.
        await using var rotator = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await rotator.BeginTransactionAsync(Ct);
        await rotator.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            INSERT INTO user_refresh_tokens (id, user_id, token_hash, expires_at, created_at)
            VALUES (gen_random_uuid(), @user, @hash, now() + interval '7 days', now());
            """, new { user, hash = NewHash() }, tx, cancellationToken: Ct));

        var reset = _repo.ResetPasswordAsync(code, "new-hash", Now, Ct);
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
        var first = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        await keys.RevokeAsync(user, key.Id, first, Ct);
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, Now.AddHours(1), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", Now, Ct);

        Assert.Equal(first, Assert.Single(await keys.ListAsync(user, Ct)).RevokedAt);
    }

    [Fact]
    public async Task ResetPasswordAsync_UsedCode_ReturnsNullAndChangesNothing()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, Now.AddHours(1), Ct);
        await _repo.ResetPasswordAsync(code, "first", Now, Ct);
        await _repo.IssueAsync(user, NewHash(), NextWeek, Ct);

        Assert.Null(await _repo.ResetPasswordAsync(code, "second", Now, Ct));

        Assert.Equal("first", (await new UserRepository(db.DataSource).GetAsync(user, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", user));
    }

    [Fact]
    public async Task ResetPasswordAsync_ExpiredCode_ReturnsNull()
    {
        var user = await db.NewReaderAsync();
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(user, code, Now.AddMinutes(-1), Ct);

        Assert.Null(await _repo.ResetPasswordAsync(code, "new-hash", Now, Ct));
    }

    [Fact]
    public async Task ResetPasswordAsync_AlicesCode_LeavesBobsCredentialsAndPassword()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var code = NewHash();
        await _repo.CreatePasswordResetAsync(alice, code, Now.AddHours(1), Ct);
        await _repo.IssueAsync(bob, NewHash(), NextWeek, Ct);
        var keys = new McpKeyRepository(db.DataSource);
        await keys.CreateAsync(bob, "laptop", NewHash(), "tsk_ab", Ct);
        var oauth = new OAuthRepository(db.DataSource);
        await oauth.ConnectAsync(bob, OAuthRepositoryTests.Grant(), Ct);

        await _repo.ResetPasswordAsync(code, "new-hash", Now, Ct);

        Assert.Null((await new UserRepository(db.DataSource).GetAsync(bob, Ct))!.PasswordHash);
        Assert.Equal(1L, await db.CountAsync("user_refresh_tokens", bob));
        Assert.Equal(1, await keys.CountLiveAsync(bob, Ct));
        Assert.Single(await oauth.ListLiveAsync(bob, Now, Ct));
    }

    [Fact]
    public async Task CreatePasswordResetAsync_Code_IsTheUsersAndUnused()
    {
        var user = await db.NewReaderAsync();

        var reset = await _repo.CreatePasswordResetAsync(user, NewHash(), Now.AddHours(1), Ct);

        Assert.Equal((user, false), (reset.UserId, reset.Used));
    }

    [Fact]
    public async Task DeleteExpiredSessionsAsync_Cutoff_DeletesOnlySessionsExpiredBeforeIt()
    {
        var user = await db.NewReaderAsync();
        // Far back, so another test's sessions are never on the wrong side of this cutoff.
        var cutoff = new DateTimeOffset(2001, 1, 2, 0, 0, 0, TimeSpan.Zero);
        await _repo.IssueAsync(user, NewHash(), cutoff.AddDays(-1), Ct);
        // Expiring at the cutoff instant itself is not "before" it.
        await _repo.IssueAsync(user, NewHash(), cutoff, Ct);

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
}
