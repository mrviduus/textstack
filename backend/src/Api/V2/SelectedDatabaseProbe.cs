using Api.Extensions;
using Infrastructure.Persistence;
using Npgsql;

namespace Api.V2;

/// <summary>Readiness checks the selected database; it never falls back to the other pool.</summary>
public sealed class SelectedDatabaseProbe(DatabaseMode mode, NpgsqlDataSource legacy, V2DataSource v2)
{
    public ValueTask<NpgsqlConnection> OpenAsync(CancellationToken ct) =>
        mode.IsV2 ? v2.OpenConnectionAsync(ct) : legacy.OpenConnectionAsync(ct);

    public IReadOnlyList<string> KnownMigrations => mode.IsV2 ? SchemaVersion.V2Known : SchemaVersion.Known;
}
