using Application.Common;
using Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// The pool to <c>textstack_v2</c> (ADR-030 §2), a type of its own so it can never be injected where
/// the legacy <see cref="NpgsqlDataSource"/> is meant, or the other way round. No pgvector: V2 has no
/// vector column.
/// </summary>
public sealed class V2DataSource(string connectionString) : IV2UnitOfWork, IDisposable, IAsyncDisposable
{
    private readonly NpgsqlDataSource _dataSource = NpgsqlDataSource.Create(connectionString);

    public ValueTask<NpgsqlConnection> OpenConnectionAsync(CancellationToken ct) => _dataSource.OpenConnectionAsync(ct);

    public async Task<V2Transaction> BeginAsync(CancellationToken ct)
    {
        var conn = await _dataSource.OpenConnectionAsync(ct);
        try
        {
            return new V2Transaction(conn, await conn.BeginTransactionAsync(ct));
        }
        catch
        {
            await conn.DisposeAsync();
            throw;
        }
    }

    /// <summary>
    /// The transaction a composable repository method runs in: the caller's <paramref name="tx"/>
    /// (commit and dispose stay theirs), else one of its own.
    /// </summary>
    internal async Task<V2Transaction> JoinOrBeginAsync(NpgsqlTransaction? tx, CancellationToken ct) =>
        tx is null ? await BeginAsync(ct) : V2Transaction.Join(tx);

    public void Dispose() => _dataSource.Dispose();

    public ValueTask DisposeAsync() => _dataSource.DisposeAsync();
}
