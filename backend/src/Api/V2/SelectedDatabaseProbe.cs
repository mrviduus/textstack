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

    /// <summary>
    /// v2 mode: the legacy database the public catalog still reads until M6, so readiness needs it too;
    /// null in legacy mode (it is the selected one).
    /// </summary>
    public NpgsqlDataSource? CatalogLegacy => mode.IsV2 ? legacy : null;
}
