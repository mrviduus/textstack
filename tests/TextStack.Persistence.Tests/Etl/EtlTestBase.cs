using Dapper;
using Infrastructure.Persistence.Etl;
using Npgsql;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// What the ETL tests share: databases of the test's own (named under one prefix, dropped at dispose),
/// a source read as <c>etl_reader</c>, and setup SQL run as the container's superuser. One collection:
/// <c>etl_reader</c> is cluster-wide, and two classes provisioning it at once race.
/// </summary>
public abstract class EtlTestBase(PostgresFixture legacy, V2PostgresFixture v2) : IAsyncDisposable
{
    private readonly string _prefix = "etl_" + Guid.NewGuid().ToString("N")[..12] + "_";
    private int _names;

    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    protected PostgresFixture Legacy => legacy;

    protected V2PostgresFixture V2 => v2;

    /// <summary>A validation check that passes: what a run needs to succeed (it fails closed without one).</summary>
    protected static readonly EtlV2Step Ok = new("ok", (context, _) =>
    {
        context.Checks.Add(new("trivial", 0));
        return Task.CompletedTask;
    });

    /// <summary>A database name under this test's prefix, so dispose drops it.</summary>
    protected string NewName() => _prefix + Interlocked.Increment(ref _names);

    /// <summary>A fresh legacy database, read as <c>etl_reader</c> (the only kind of source the audit lets through).</summary>
    protected async Task<string> NewSourceAsync(string? name = null) =>
        await legacy.ProvisionEtlReaderAsync(await legacy.Databases.NewLegacyAsync(name ?? NewName()));

    /// <summary><see cref="EtlV2.RunAsync"/> with <see cref="Ok"/> after <paramref name="steps"/>: a step that throws still fails the run first.</summary>
    protected static Task<EtlV2Report> RunAsync(EtlV2Options options, EtlV2Step[] steps, CancellationToken ct) =>
        EtlV2.RunAsync(options, [.. steps, Ok], ct);

    /// <summary>The test's own setup and read-back run as the container's superuser, whatever role the string names.</summary>
    protected static string AsAdmin(string connectionString) =>
        new NpgsqlConnectionStringBuilder(connectionString) { Username = "postgres", Password = "postgres" }.ConnectionString;

    protected static async Task ExecAsync(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(AsAdmin(connectionString));
        await conn.ExecuteAsync(new CommandDefinition(sql, cancellationToken: Ct));
    }

    protected static async Task<T> ScalarAsync<T>(string connectionString, string sql)
    {
        await using var conn = new NpgsqlConnection(AsAdmin(connectionString));
        return (await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, cancellationToken: Ct)))!;
    }

    public async ValueTask DisposeAsync()
    {
        await legacy.Databases.DropAsync(_prefix);
        await v2.Databases.DropAsync(_prefix);
        GC.SuppressFinalize(this);
    }
}
