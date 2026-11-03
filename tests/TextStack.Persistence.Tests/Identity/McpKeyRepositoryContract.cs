using Application.Identity;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// <see cref="IMcpKeyRepository"/>'s contract, run against V2 (<see cref="McpKeyRepositoryTests"/>) and
/// the legacy EF adapter (<see cref="EfMcpKeyRepositoryTests"/>) (#1100).
/// </summary>
public abstract class McpKeyRepositoryContract(IIdentityFixture db, IMcpKeyRepository repo)
{
    private readonly IMcpKeyRepository _repo = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

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
    public async Task CreateAsync_NoSuchUser_ReturnsNull()
    {
        Assert.Null(await _repo.CreateAsync(Guid.NewGuid(), "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task CreateAsync_Guest_ReturnsNullAndStoresNothing()
    {
        var guest = await db.NewReaderAsync(isGuest: true);

        Assert.Null(await _repo.CreateAsync(guest, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct));
        Assert.Equal(0, await _repo.CountLiveAsync(guest, Ct));
    }

    // A key a guest minted before #1120 stops authenticating; it stays listed (and revocable).
    [Fact]
    public async Task GetLiveByHashAsync_GuestsKey_IsNull()
    {
        // Minted while the guest check did not exist: as an account's key, then the row made a guest.
        var guest = await db.NewReaderAsync();
        var hash = NewHash();
        await _repo.CreateAsync(guest, "old", hash, "tsk_ab", DateTimeOffset.UtcNow, Ct);
        await db.ExecAsync("UPDATE users SET is_guest = true WHERE id = @guest", new { guest });

        Assert.Null(await _repo.GetLiveByHashAsync(hash, Ct));
        Assert.Single(await _repo.ListAsync(guest, Ct));
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
