using Application.Identity;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// What <see cref="IUserRepository"/> does on legacy too (the profile edits and the activity stamp),
/// run against V2 (<see cref="UserRepositoryTests"/>) and the legacy EF adapter
/// (<see cref="EfUserRepositoryTests"/>) (#1100). Read back with SQL: the column names are the same on both.
/// </summary>
public abstract class UserRepositoryContract(IIdentityFixture db, IUserRepository repo)
{
    private readonly IUserRepository _repo = repo;
    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    private Task<string?> ColumnAsync(Guid userId, string column) =>
        db.ScalarAsync<string?>($"SELECT {column} FROM users WHERE id = @userId", new { userId });

    [Fact]
    public async Task UpdateNameAndLanguageAsync_Account_SetsBothAndReturnsIt()
    {
        var user = await db.NewReaderAsync();

        var updated = await _repo.UpdateNameAndLanguageAsync(user, "Ann", "uk", Ct);

        Assert.Equal((user, "Ann", "uk"), (updated!.Id, updated.Name, updated.NativeLanguage));
        Assert.Equal("uk", await ColumnAsync(user, "native_language"));
    }

    [Fact]
    public async Task UpdateNameAndLanguageAsync_NullLanguage_ClearsIt()
    {
        var user = await db.NewReaderAsync();
        await _repo.UpdateNameAndLanguageAsync(user, "Ann", "uk", Ct);

        Assert.Null((await _repo.UpdateNameAndLanguageAsync(user, "Ann", null, Ct))!.NativeLanguage);
        Assert.Null(await ColumnAsync(user, "native_language"));
    }

    [Fact]
    public async Task UpdateNameAndLanguageAsync_NoSuchAccount_ReturnsNull()
    {
        Assert.Null(await _repo.UpdateNameAndLanguageAsync(Guid.NewGuid(), "Ann", "uk", Ct));
    }

    [Fact]
    public async Task UpdateNameAndLanguageAsync_Alice_LeavesBobAsHeWas()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());

        await _repo.UpdateNameAndLanguageAsync(alice, "Alice", "uk", Ct);

        Assert.Null(await ColumnAsync(bob, "name"));
        Assert.Null(await ColumnAsync(bob, "native_language"));
    }

    [Fact]
    public async Task SetPictureAsync_Account_SetsItAndReturnsIt()
    {
        var user = await db.NewReaderAsync();

        Assert.Equal("users/av/avatar.jpg", (await _repo.SetPictureAsync(user, "users/av/avatar.jpg", Ct))!.Picture);
        Assert.Equal("users/av/avatar.jpg", await ColumnAsync(user, "picture"));
    }

    [Fact]
    public async Task SetPictureAsync_Null_ClearsIt()
    {
        var user = await db.NewReaderAsync();
        await _repo.SetPictureAsync(user, "users/av/avatar.jpg", Ct);

        await _repo.SetPictureAsync(user, null, Ct);

        Assert.Null(await ColumnAsync(user, "picture"));
    }

    [Fact]
    public async Task SetPictureAsync_NoSuchAccount_ReturnsNull()
    {
        Assert.Null(await _repo.SetPictureAsync(Guid.NewGuid(), "users/av/avatar.jpg", Ct));
    }

    [Fact]
    public async Task SetPictureAsync_Alice_LeavesBobAsHeWas()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());

        await _repo.SetPictureAsync(alice, "users/av/avatar.jpg", Ct);

        Assert.Null(await ColumnAsync(bob, "picture"));
    }

    [Fact]
    public async Task TouchActiveAsync_Guest_StampsLastActive()
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        var now = new DateTimeOffset(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);

        Assert.True(await _repo.TouchActiveAsync(guest, now, Ct));

        Assert.Equal(now, await db.ScalarAsync<DateTimeOffset>("SELECT last_active_at FROM users WHERE id = @guest", new { guest }));
    }

    [Fact]
    public async Task TouchActiveAsync_NoSuchAccount_ReturnsFalse()
    {
        Assert.False(await _repo.TouchActiveAsync(Guid.NewGuid(), DateTimeOffset.UtcNow, Ct));
    }

    [Fact]
    public async Task TouchActiveAsync_Alice_LeavesBobAsHeWas()
    {
        var (alice, bob) = (await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync(isGuest: true));

        await _repo.TouchActiveAsync(alice, DateTimeOffset.UtcNow, Ct);

        Assert.Null(await db.ScalarAsync<DateTimeOffset?>("SELECT last_active_at FROM users WHERE id = @bob", new { bob }));
    }
}
