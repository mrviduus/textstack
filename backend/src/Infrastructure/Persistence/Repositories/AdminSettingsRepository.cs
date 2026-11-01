using Application.Ops;
using Dapper;

namespace Infrastructure.Persistence.Repositories;

/// <summary>Dapper implementation of <see cref="IAdminSettingsRepository"/> on <c>textstack_v2</c>.</summary>
public sealed class AdminSettingsRepository(V2DataSource dataSource) : IAdminSettingsRepository
{
    private const string SelectValue = "SELECT value FROM admin_settings WHERE key = @key";

    public async Task<string?> GetAsync(string key, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(SelectValue, new { key }, cancellationToken: ct));
    }

    private const string UpsertValue = """
        INSERT INTO admin_settings (key, value, updated_at) VALUES (@key, @value, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        """;

    public async Task SetAsync(string key, string value, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(UpsertValue, new { key, value }, cancellationToken: ct));
    }
}
