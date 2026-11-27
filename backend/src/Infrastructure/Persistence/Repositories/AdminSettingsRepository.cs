using Application.AdminSettings;
using Dapper;

namespace Infrastructure.Persistence.Repositories;

/// <summary>Dapper implementation of <see cref="IAdminSettingsRepository"/> on <c>textstack_v2</c>.</summary>
public sealed class AdminSettingsRepository(AppDataSource dataSource) : IAdminSettingsRepository
{
    private const string SelectValue = "SELECT value FROM admin_settings WHERE key = @key";

    public async Task<string?> GetAsync(string key, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(SelectValue, new { key }, cancellationToken: ct));
    }
}
