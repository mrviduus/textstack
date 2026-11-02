using Application.Common;
using Npgsql;

namespace Infrastructure.Persistence;

/// <summary>
/// The pool to <c>textstack_v2</c> (ADR-030 §2), a type of its own so it can never be injected where
/// the legacy <see cref="NpgsqlDataSource"/> is meant, or the other way round. No pgvector: V2 has no
/// vector column. Built from a missing connection string too: nothing fails until the first open,
/// which names <c>ConnectionStrings:V2</c> (data-access.md rule 5).
/// </summary>
public sealed class V2DataSource(string? connectionString) : IV2UnitOfWork, IDisposable, IAsyncDisposable
{
    private readonly NpgsqlDataSource? _dataSource = string.IsNullOrWhiteSpace(connectionString) ? null : NpgsqlDataSource.Create(connectionString);

    public bool IsConfigured => _dataSource is not null;

    public ValueTask<NpgsqlConnection> OpenConnectionAsync(CancellationToken ct) =>
        (_dataSource ?? throw new InvalidOperationException("ConnectionStrings:V2 is not set")).OpenConnectionAsync(ct);

    public async Task<V2Transaction> BeginAsync(CancellationToken ct)
    {
        var conn = await OpenConnectionAsync(ct);
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

    /// <summary>A method that needs a transaction: the caller's <paramref name="tx"/> (commit and dispose stay theirs), else its own.</summary>
    internal async Task<V2Transaction> JoinOrBeginAsync(NpgsqlTransaction? tx, CancellationToken ct) =>
        tx is null ? await BeginAsync(ct) : V2Transaction.Join(tx);

    /// <summary>A single statement: on the caller's <paramref name="tx"/>'s connection, else on a pooled one returned on dispose.</summary>
    internal async ValueTask<V2Lease> JoinOrOpenAsync(NpgsqlTransaction? tx, CancellationToken ct) =>
        tx is null ? new V2Lease(await OpenConnectionAsync(ct), owned: true) : new V2Lease(tx.Connection!, owned: false);

    public void Dispose() => _dataSource?.Dispose();

    public ValueTask DisposeAsync() => _dataSource?.DisposeAsync() ?? ValueTask.CompletedTask;
}

/// <summary>A connection that is disposed with the lease only when the lease opened it.</summary>
internal readonly struct V2Lease(NpgsqlConnection connection, bool owned) : IAsyncDisposable
{
    public NpgsqlConnection Connection => connection;

    public ValueTask DisposeAsync() => owned ? connection.DisposeAsync() : ValueTask.CompletedTask;
}
