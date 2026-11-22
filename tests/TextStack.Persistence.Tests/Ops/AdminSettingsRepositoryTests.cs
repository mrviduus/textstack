using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Ops;

// Not user-owned: each test works under its own setting key.
public class AdminSettingsRepositoryTests(PostgresFixture db)
{
    private readonly AdminSettingsRepository _settings = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task GetAsync_UnsetKey_ReturnsNull() =>
        Assert.Null(await _settings.GetAsync("k-" + Guid.NewGuid(), Ct));

    [Fact]
    public async Task SetAsync_ExistingKey_ReplacesTheValue()
    {
        var key = "k-" + Guid.NewGuid();
        await _settings.SetAsync(key, "15", Ct);

        await _settings.SetAsync(key, "30", Ct);

        Assert.Equal("30", await _settings.GetAsync(key, Ct));
    }
}
