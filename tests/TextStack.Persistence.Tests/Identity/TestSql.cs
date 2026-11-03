using Dapper;
using Npgsql;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// A test's own SQL (setup and read-back, never input), each statement on its own connection in
/// autocommit. Over a connection opener, so the legacy <see cref="NpgsqlDataSource"/> and the
/// <c>V2DataSource</c> share it: both fixtures forward here.
/// </summary>
public static class TestSql
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static async Task ExecAsync(Func<CancellationToken, ValueTask<NpgsqlConnection>> open, string sql, object args)
    {
        await using var conn = await open(Ct);
        await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: Ct));
    }

    public static async Task<T> ScalarAsync<T>(Func<CancellationToken, ValueTask<NpgsqlConnection>> open, string sql, object args)
    {
        await using var conn = await open(Ct);
        return (await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, args, cancellationToken: Ct)))!;
    }

    /// <summary>The user's rows in <paramref name="table"/> (a constant, never input), only those of <paramref name="bookId"/> when given.</summary>
    public static Task<long> CountAsync(Func<CancellationToken, ValueTask<NpgsqlConnection>> open, string table, Guid userId, Guid? bookId = null) =>
        ScalarAsync<long>(open, $"SELECT count(*) FROM {table} WHERE user_id = @userId" + (bookId is null ? "" : " AND book_id = @bookId"), new { userId, bookId });
}
