using Dapper;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

public class McpKeyRepositoryTests(V2PostgresFixture db)
{
    private readonly McpKeyRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task CreateAsync_Key_IsTheUsersAndLiveByItsHash()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();

        var key = (await _repo.CreateAsync(user, "laptop", hash, "tsk_ab", DateTimeOffset.UtcNow, Ct))!;

        Assert.Equal((user, "laptop", "tsk_ab"), (key.UserId, key.Name, key.Prefix));
        Assert.Equal(key.Id, (await _repo.GetLiveByHashAsync(hash, Ct))?.Id);
    }

    [Fact]
    public async Task CreateAsync_ResetCommitsWhileItWaits_StoresNothing()
    {
        // #1092: an access token minted before the reset asks for a key; the reset holds the user and
        // has stamped it, not yet committed.
        var user = await db.NewReaderAsync();
        await using var reset = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await reset.BeginTransactionAsync(Ct);
        await reset.ExecuteAsync(new CommandDefinition("""
            SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;
            UPDATE users SET credentials_reset_at = now() WHERE id = @user;
            """, new { user }, tx, cancellationToken: Ct));

        var create = _repo.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow.AddMinutes(-1), Ct);
        await db.WaitUntilBlockedByAsync(reset, create);
        var waited = !create.IsCompleted;
        await tx.CommitAsync(Ct);

        Assert.True(waited);
        Assert.Null(await create);
        Assert.Equal(0L, await db.CountAsync("mcp_access_keys", user));
    }

    [Fact]
    public async Task CreateAsync_NoSuchUser_ReturnsNull()
    {
        Assert.Null(await _repo.CreateAsync(Guid.NewGuid(), "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task RevokeAsync_Key_StopsItsLookup()
    {
        var user = await db.NewReaderAsync();
        var hash = NewHash();
        var key = (await _repo.CreateAsync(user, "laptop", hash, "tsk_ab", DateTimeOffset.UtcNow, Ct))!;

        Assert.True(await _repo.RevokeAsync(user, key.Id, Ct));

        Assert.Null(await _repo.GetLiveByHashAsync(hash, Ct));
    }

    [Fact]
    public async Task RevokeAsync_AlreadyRevoked_KeepsTheFirstRevocationTime()
    {
        var user = await db.NewReaderAsync();
        var key = (await _repo.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct))!;
        await _repo.RevokeAsync(user, key.Id, Ct);
        var first = Assert.Single(await _repo.ListAsync(user, Ct)).RevokedAt;

        Assert.True(await _repo.RevokeAsync(user, key.Id, Ct));

        Assert.Equal(first, Assert.Single(await _repo.ListAsync(user, Ct)).RevokedAt);
    }

    [Fact]
    public async Task RevokeAsync_AnotherUsersKey_ReturnsFalseAndKeepsItLive()
    {
        var alice = await db.NewReaderAsync();
        var hash = NewHash();
        var key = (await _repo.CreateAsync(alice, "laptop", hash, "tsk_ab", DateTimeOffset.UtcNow, Ct))!;

        Assert.False(await _repo.RevokeAsync(await db.NewReaderAsync(), key.Id, Ct));
        Assert.NotNull(await _repo.GetLiveByHashAsync(hash, Ct));
    }

    [Fact]
    public async Task ListAsync_RevokedKeyToo_NewestFirst()
    {
        var user = await db.NewReaderAsync();
        var older = (await _repo.CreateAsync(user, "old", NewHash(), "tsk_aa", DateTimeOffset.UtcNow, Ct))!;
        var newer = (await _repo.CreateAsync(user, "new", NewHash(), "tsk_bb", DateTimeOffset.UtcNow, Ct))!;
        await _repo.RevokeAsync(user, older.Id, Ct);

        Assert.Equal([newer.Id, older.Id], (await _repo.ListAsync(user, Ct)).Select(k => k.Id));
    }

    [Fact]
    public async Task ListAsync_Bob_DoesNotSeeAlicesKeys()
    {
        await _repo.CreateAsync(await db.NewReaderAsync(), "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);

        Assert.Empty(await _repo.ListAsync(await db.NewReaderAsync(), Ct));
    }

    [Fact]
    public async Task CountLiveAsync_RevokedKey_IsNotCounted()
    {
        var user = await db.NewReaderAsync();
        var revoked = (await _repo.CreateAsync(user, "old", NewHash(), "tsk_aa", DateTimeOffset.UtcNow, Ct))!;
        await _repo.CreateAsync(user, "new", NewHash(), "tsk_bb", DateTimeOffset.UtcNow, Ct);
        await _repo.RevokeAsync(user, revoked.Id, Ct);

        Assert.Equal(1, await _repo.CountLiveAsync(user, Ct));
    }

    [Fact]
    public async Task CountLiveAsync_Bob_DoesNotCountAlicesKeys()
    {
        await _repo.CreateAsync(await db.NewReaderAsync(), "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);

        Assert.Equal(0, await _repo.CountLiveAsync(await db.NewReaderAsync(), Ct));
    }

    [Fact]
    public async Task TouchAsync_Key_RecordsTheUse()
    {
        var user = await db.NewReaderAsync();
        var key = (await _repo.CreateAsync(user, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct))!;

        await _repo.TouchAsync(key.Id, Ct);

        Assert.NotNull(Assert.Single(await _repo.ListAsync(user, Ct)).LastUsedAt);
    }
}
