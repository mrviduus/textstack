using System.Collections.Concurrent;
using Dapper;
using Npgsql;
using Testcontainers.PostgreSql;

namespace TextStack.Persistence.Tests;

/// <summary>
/// One fixture container's databases: the migrate command (<c>database/run.sh up</c>, ICU), and throwaway
/// databases for tests that need a whole one of their own, each a <c>CREATE DATABASE … TEMPLATE</c> copy of a
/// template migrated once. Test SQL only: names are the tests' own.
/// </summary>
public sealed class ScratchDatabases(PostgreSqlContainer container)
{
    private const string TemplateDb = "scratch_tpl_v2";

    private readonly ConcurrentDictionary<string, Lazy<Task>> _templates = new();

    /// <summary>Creates <paramref name="database"/> when missing (ICU, template0), then migrates it, as the migrator does.</summary>
    public Task MigrateV2Async(string database) => ShellAsync($"PGUSER=postgres PGDATABASE={database} sh /database/run.sh up");

    public Task<string> NewV2Async(string name) => CopyAsync(TemplateDb, name);

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

    /// <summary>Runs <paramref name="command"/> in the container (sh -c); its stdout, or a failure with its output.</summary>
    public async Task<string> ShellAsync(string command)
    {
        var (exitCode, stdout, stderr) = await RunAsync("sh", "-c", command);
        if (exitCode != 0)
            throw new InvalidOperationException($"`{command}` failed:\n{stdout}\n{stderr}");
        return stdout;
    }

    /// <summary>Runs <paramref name="argv"/> in the container, no shell (nothing to quote), whatever its exit code.</summary>
    public async Task<(long ExitCode, string Stdout, string Stderr)> RunAsync(params string[] argv)
    {
        var run = await container.ExecAsync(argv);
        return (run.ExitCode ?? -1, run.Stdout, run.Stderr);
    }

    private async Task<string> CopyAsync(string template, string name)
    {
        await _templates.GetOrAdd(template, t => new Lazy<Task>(() => BuildAsync(t))).Value;
        await using var conn = new NpgsqlConnection(ConnectionString("postgres"));
        await conn.ExecuteAsync($"CREATE DATABASE \"{name}\" TEMPLATE {template}");
        return ConnectionString(name);
    }

    private Task BuildAsync(string template) => MigrateV2Async(template);
}
