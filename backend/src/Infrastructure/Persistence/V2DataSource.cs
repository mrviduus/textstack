using Dapper;
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

/// <summary>One statement on a connection of its own, for repositories whose methods are one statement each.</summary>
internal static class V2DataSourceStatements
{
    /// <summary>Runs <paramref name="sql"/>; returns the rows it affected.</summary>
    public static async Task<int> ExecuteAsync(this V2DataSource dataSource, string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: ct));
    }

    /// <summary>Runs <paramref name="sql"/>; returns its one row, or default when it returned none.</summary>
    public static async Task<T?> QuerySingleOrDefaultAsync<T>(this V2DataSource dataSource, string sql, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<T>(new CommandDefinition(sql, args, cancellationToken: ct));
    }
}
