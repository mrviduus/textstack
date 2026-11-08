using Infrastructure.Persistence.Etl;
using Npgsql;
using TextStack.Persistence.Tests.Identity;

namespace TextStack.Persistence.Tests.Etl;

/// <summary>
/// What the ETL tests share: databases of the test's own (named under one prefix, dropped at dispose),
/// a source read as <c>etl_reader</c>, steps that pass or fail, and setup SQL run as the superuser of
/// whichever container the connection string points at.
/// </summary>
public abstract class EtlTestBase(PostgresFixture legacy, V2PostgresFixture v2) : IAsyncDisposable
{
    private readonly string _prefix = "etl_" + Guid.NewGuid().ToString("N")[..12] + "_";
    private int _names;

    protected static CancellationToken Ct => TestContext.Current.CancellationToken;

    protected PostgresFixture Legacy => legacy;

    protected V2PostgresFixture V2 => v2;

    /// <summary>A validation check that passes: what a real run needs to succeed (it fails closed without one). Counts <c>users</c> on both sides.</summary>
    protected static readonly EtlV2Step Ok = new("ok", ["users"], ["users"], (context, _) =>
    {
        context.Checks.Add(new("trivial", 0));
        return Task.CompletedTask;
    });

    /// <summary>A step with no check that declares <c>users</c> on both sides: counts without validation.</summary>
    protected static readonly EtlV2Step CountUsers = new("count-users", ["users"], ["users"], (_, _) => Task.CompletedTask);

    /// <summary>A step that throws.</summary>
    protected static readonly EtlV2Step Fail = new("fail", (_, _) => throw new InvalidDataException("boom"));

    /// <summary>A database name under this test's prefix, so dispose drops it.</summary>
    protected string NewName() => _prefix + Interlocked.Increment(ref _names);

    /// <summary>A fresh legacy database, as <c>etl_reader</c> (the only kind of source the audit lets through).</summary>
    protected async Task<string> NewSourceAsync(string? name = null) => (await legacy.Databases.NewLegacyAsync(name ?? NewName())).Reader;

    /// <summary><see cref="EtlV2.RunAsync"/> with <see cref="Ok"/> after <paramref name="steps"/>: a step that throws still fails the run first.</summary>
    protected static Task<EtlV2Report> RunAsync(EtlV2Options options, EtlV2Step[] steps, CancellationToken ct) =>
        EtlV2.RunAsync(options, [.. steps, Ok], ct);

    /// <summary>A run of every step (<see cref="EtlV2.Steps"/>) that must fail: its exception.</summary>
    protected static Task<EtlV2Exception> FailsAsync(EtlV2Options options) => Assert.ThrowsAsync<EtlV2Exception>(() => EtlV2.RunAsync(options, ct: Ct));

    /// <summary>The failing ids of the one check named <paramref name="check"/>.</summary>
    protected static IReadOnlyList<string>? Failed(EtlV2Exception error, string check) => Assert.Single(error.Checks, c => c.Name == check).Ids;

    /// <summary>A new login with a random name and password on <paramref name="connectionString"/>'s database: CONNECT plus <paramref name="grants"/> ({r}: the role); its connection string.</summary>
    protected async Task<(string Role, string ConnectionString)> NewProbeRoleAsync(string connectionString, string grants)
    {
        var role = "etl_probe_" + Guid.NewGuid().ToString("N")[..12];
        var password = "p'a;s\"s w=rd" + Guid.NewGuid().ToString("N")[..6];
        var db = new NpgsqlConnectionStringBuilder(connectionString).Database;
        await ExecAsync(connectionString, $"""
            CREATE ROLE {role} LOGIN PASSWORD '{password.Replace("'", "''")}' NOINHERIT;
            GRANT CONNECT ON DATABASE "{db}" TO {role};
            {grants.Replace("{r}", role)};
            """);
        return (role, new NpgsqlConnectionStringBuilder(connectionString) { Username = role, Password = password }.ConnectionString);
    }

    /// <summary>The test's own SQL, as the superuser of the container <paramref name="connectionString"/> points at.</summary>
    protected Task ExecAsync(string connectionString, string sql, object? args = null) =>
        TestSql.ExecAsync(AsAdmin(connectionString), sql, args ?? new { });

    protected Task<T> ScalarAsync<T>(string connectionString, string sql, object? args = null) =>
        TestSql.ScalarAsync<T>(AsAdmin(connectionString), sql, args ?? new { });

    private Func<CancellationToken, ValueTask<NpgsqlConnection>> AsAdmin(string connectionString)
    {
        var admin = legacy.Databases.AdminFor(connectionString) ?? v2.Databases.AdminFor(connectionString)
            ?? throw new InvalidOperationException("not a fixture container");
        return async ct =>
        {
            var conn = new NpgsqlConnection(admin);
            await conn.OpenAsync(ct);
            return conn;
        };
    }

    public async ValueTask DisposeAsync()
    {
        await Task.WhenAll(legacy.Databases.DropAsync(_prefix), v2.Databases.DropAsync(_prefix));
        GC.SuppressFinalize(this);
    }
}
