using Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// The pool to <c>textstack_v2</c> (ADR-030 §2), a type of its own so it can never be injected where
/// the legacy <see cref="NpgsqlDataSource"/> is meant, or the other way round. Building it opens no
/// connection: nothing at startup depends on V2 being reachable
/// (docs/incidents/2026-10-30-migrator-v2-took-down-the-api.md). No pgvector: V2 has no vector column.
/// </summary>
public sealed class V2DataSource(string connectionString) : IDisposable, IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource = NpgsqlDataSource.Create(connectionString);

    public ValueTask<NpgsqlConnection> OpenConnectionAsync(CancellationToken ct) => _dataSource.OpenConnectionAsync(ct);

    public void Dispose() => _dataSource.Dispose();

    public ValueTask DisposeAsync() => _dataSource.DisposeAsync();
}
