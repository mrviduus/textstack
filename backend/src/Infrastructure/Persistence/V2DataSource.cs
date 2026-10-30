using Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// The pool to <c>textstack_v2</c> (ADR-030 §2), a type of its own so it can never be injected where
/// the legacy <see cref="NpgsqlDataSource"/> is meant, or the other way round. No pgvector: V2 has no
/// vector column.
/// </summary>
public sealed class V2DataSource(string connectionString) : IDisposable, IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource = NpgsqlDataSource.Create(connectionString);

    public ValueTask<NpgsqlConnection> OpenConnectionAsync(CancellationToken ct) => _dataSource.OpenConnectionAsync(ct);

    public void Dispose() => _dataSource.Dispose();

    public ValueTask DisposeAsync() => _dataSource.DisposeAsync();
}
