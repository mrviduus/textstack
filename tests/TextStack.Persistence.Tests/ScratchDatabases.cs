using System.Collections.Concurrent;
using Dapper;
using Npgsql;
using Testcontainers.PostgreSql;

namespace TextStack.Persistence.Tests;

/// <summary>
/// Throwaway databases in one fixture's container, for tests that need a whole database of their own
/// (the ETL's). Each is a <c>CREATE DATABASE … TEMPLATE</c> copy of a template migrated once, the way
/// production's are: legacy by <c>database/migrate.sh up</c>, V2 by <c>database/v2/run.sh up</c> (ICU,
/// which the copy inherits). Test SQL only: names are the tests' own.
/// </summary>
public sealed class ScratchDatabases(PostgreSqlContainer container)
{
    private const string LegacyTemplate = "scratch_tpl_legacy";
    private const string V2Template = "scratch_tpl_v2";

    private readonly ConcurrentDictionary<string, Lazy<Task>> _templates = new();

    public Task<string> NewLegacyAsync(string name) => CopyAsync(LegacyTemplate, name);

    public Task<string> NewV2Async(string name) => CopyAsync(V2Template, name);

    /// <summary>The container's superuser connection string, on <paramref name="database"/>.</summary>
    public string ConnectionString(string database) =>
        new NpgsqlConnectionStringBuilder(container.GetConnectionString()) { Database = database }.ConnectionString;

    /// <summary>Drops every database whose name starts with <paramref name="prefix"/> (case-insensitive), sessions and all.</summary>
    public async Task DropAsync(string prefix)
    {
        await using var conn = new NpgsqlConnection(ConnectionString("postgres"));
        var names = await conn.QueryAsync<string>("SELECT datname FROM pg_database WHERE datname ILIKE @prefix || '%'", new { prefix });
        foreach (var name in names)
            await conn.ExecuteAsync($"DROP DATABASE \"{name}\" WITH (FORCE)");
    }

    /// <summary>Runs <paramref name="command"/> in the container (sh -c); fails with its output on a non-zero exit.</summary>
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
            // run.sh creates the database itself (ICU, template0), as migrator-v2 does.
            await ShellAsync($"PGUSER=postgres PGDATABASE={template} sh /database/v2/run.sh up");
            return;
        }
        await using (var conn = new NpgsqlConnection(ConnectionString("postgres")))
            await conn.ExecuteAsync($"CREATE DATABASE {template}");
        await ShellAsync($"PGUSER=postgres PGDATABASE={template} sh /database/migrate.sh up");
    }
}
