using Infrastructure.Persistence;
using Npgsql;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(TextStack.Persistence.Tests.V2PostgresFixture))]

namespace TextStack.Persistence.Tests;

/// <summary>
/// One throwaway Postgres holding <c>textstack_v2</c> for the whole assembly (each test makes its own
/// users), built the way production's is: <c>database/v2/run.sh up</c> creates the database from the
/// maintenance database, then migrates it (ADR-030). Same image as <see cref="PostgresFixture"/>; its
/// own container, so the V2 schema never meets the legacy one. Needs Docker.
/// </summary>
public sealed class V2PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("pgvector/pgvector:pg16")
        .WithResourceMapping(new DirectoryInfo(Path.Combine(PostgresFixture.RepoRoot(), "database")), "/database")
        .Build();

    public V2DataSource DataSource { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        await _container.StartAsync();
        var migrate = await _container.ExecAsync(
            ["sh", "-c", "PGUSER=postgres PGDATABASE=textstack_v2 sh /database/v2/run.sh up"]);
        if (migrate.ExitCode != 0)
            throw new InvalidOperationException($"run.sh up failed:\n{migrate.Stdout}\n{migrate.Stderr}");
        var connectionString = new NpgsqlConnectionStringBuilder(_container.GetConnectionString()) { Database = "textstack_v2" };
        DataSource = new V2DataSource(connectionString.ConnectionString);
    }

    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        await _container.DisposeAsync();
    }

    /// <summary>A fresh V2 user; its email is unique, as <c>ix_users_email</c> requires.</summary>
    public async Task<Guid> NewReaderAsync()
    {
        var userId = Guid.NewGuid();
        await using var conn = await DataSource.OpenConnectionAsync(TestContext.Current.CancellationToken);
        await using var cmd = new NpgsqlCommand(
            "INSERT INTO users (id, email, created_at) VALUES ($1, $1::text || '@test', now())", conn)
        { Parameters = { new() { Value = userId } } };
        await cmd.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
        return userId;
    }
}
