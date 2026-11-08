using System.Collections.Concurrent;
using Dapper;
using Npgsql;
using Testcontainers.PostgreSql;

namespace TextStack.Persistence.Tests;

/// <summary>
/// One fixture container's databases: the migrate commands (legacy by <c>database/migrate.sh up</c>, V2
/// by <c>database/v2/run.sh up</c>, ICU), and throwaway databases for tests that need a whole one of
/// their own (the ETL's), each a <c>CREATE DATABASE … TEMPLATE</c> copy of a template migrated once.
/// The legacy template also carries <c>database/scripts/etl-reader.sql</c>'s grants (the role is
/// cluster-wide, PUBLIC's CONNECT lets it into every copy). Test SQL only: names are the tests' own.
/// </summary>
public sealed class ScratchDatabases(PostgreSqlContainer container)
{
    private const string LegacyTemplate = "scratch_tpl_legacy";
    private const string V2Template = "scratch_tpl_v2";

    /// <summary>etl_reader's password in the test containers.</summary>
    public const string EtlReaderPassword = "etl-r3ader-pw";

    private readonly ConcurrentDictionary<string, Lazy<Task>> _templates = new();

    public Task MigrateLegacyAsync(string database) => ShellAsync($"PGUSER=postgres PGDATABASE={database} sh /database/migrate.sh up");

    /// <summary>Creates <paramref name="database"/> when missing (ICU, template0), then migrates it, as migrator-v2 does.</summary>
    public Task MigrateV2Async(string database) => ShellAsync($"PGUSER=postgres PGDATABASE={database} sh /database/v2/run.sh up");

    /// <summary>Runs etl-reader.sql on <paramref name="database"/> with <paramref name="env"/> in front (e.g. the password); its output.</summary>
    public Task<string> ProvisionEtlReaderAsync(string database, string env = $"ETL_READER_PASSWORD={EtlReaderPassword}") =>
        ShellAsync($"env -u ETL_READER_PASSWORD {env} psql -v ON_ERROR_STOP=1 -U postgres -d '{database}' -f /database/scripts/etl-reader.sql 2>&1");

    /// <summary>A copy of the migrated legacy template: (superuser, etl_reader) connection strings.</summary>
    public async Task<(string Admin, string Reader)> NewLegacyAsync(string name)
    {
        var admin = await CopyAsync(LegacyTemplate, name);
        return (admin, new NpgsqlConnectionStringBuilder(admin) { Username = "etl_reader", Password = EtlReaderPassword }.ConnectionString);
    }

    public Task<string> NewV2Async(string name) => CopyAsync(V2Template, name);

    /// <summary>The container's superuser connection string, on <paramref name="database"/>.</summary>
    public string ConnectionString(string database) =>
        new NpgsqlConnectionStringBuilder(container.GetConnectionString()) { Database = database }.ConnectionString;

    /// <summary>The superuser connection string for <paramref name="connectionString"/>'s database, if it is in this container.</summary>
    public string? AdminFor(string connectionString)
    {
        var builder = new NpgsqlConnectionStringBuilder(connectionString);
        return builder.Port == container.GetMappedPublicPort(PostgreSqlBuilder.PostgreSqlPort) ? ConnectionString(builder.Database!) : null;
    }

    /// <summary>Drops every database whose name starts with <paramref name="prefix"/> (case-insensitive), sessions and all.</summary>
    public async Task DropAsync(string prefix)
    {
        await using var conn = new NpgsqlConnection(ConnectionString("postgres"));
        var names = await conn.QueryAsync<string>("SELECT datname FROM pg_database WHERE datname ILIKE @prefix || '%'", new { prefix });
        foreach (var name in names)
            await conn.ExecuteAsync($"DROP DATABASE \"{name}\" WITH (FORCE)");
    }

    /// <summary>Runs <paramref name="command"/> in the container (sh -c); its stdout, or a failure with its output.</summary>
    public async Task<string> ShellAsync(string command)
    {
        var run = await container.ExecAsync(["sh", "-c", command]);
        if (run.ExitCode != 0)
            throw new InvalidOperationException($"`{command}` failed:\n{run.Stdout}\n{run.Stderr}");
        return run.Stdout;
    }

    private async Task<string> CopyAsync(string template, string name)
    {
        await _templates.GetOrAdd(template, t => new Lazy<Task>(() => BuildAsync(t))).Value;
        await using var conn = new NpgsqlConnection(ConnectionString("postgres"));
        await conn.ExecuteAsync($"CREATE DATABASE \"{name}\" TEMPLATE {template}");
        return ConnectionString(name);
    }

    private async Task BuildAsync(string template)
    {
        if (template == V2Template)
        {
            await MigrateV2Async(template);
            return;
        }
        await using (var conn = new NpgsqlConnection(ConnectionString("postgres")))
            await conn.ExecuteAsync($"CREATE DATABASE {template}");
        await MigrateLegacyAsync(template);
        await ProvisionEtlReaderAsync(template);
    }
}
