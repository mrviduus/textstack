using Domain;
using Infrastructure.Persistence;
using Npgsql;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(TextStack.Persistence.Tests.PostgresFixture))]

namespace TextStack.Persistence.Tests;

/// <summary>
/// One throwaway Postgres for the whole assembly (each test makes its own users, so tests don't see
/// each other's rows), its schema built the way production's is: by
/// <c>database/migrate.sh up</c> (ADR-026), run inside the container — the image ships psql.
/// Same image as production and CI (pgvector on pg16). Needs Docker.
/// </summary>
public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
        .WithImage("pgvector/pgvector:pg16")
        .WithResourceMapping(new DirectoryInfo(Path.Combine(RepoRoot(), "database")), "/database")
        .Build();

    public NpgsqlDataSource DataSource { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        await _container.StartAsync();
        var migrate = await _container.ExecAsync(
            ["sh", "-c", "PGUSER=postgres PGDATABASE=postgres sh /database/migrate.sh up"]);
        if (migrate.ExitCode != 0)
            throw new InvalidOperationException($"migrate.sh up failed:\n{migrate.Stdout}\n{migrate.Stderr}");
        DataSource = Infrastructure.Persistence.DataSource.Create(_container.GetConnectionString());
    }

    public async ValueTask DisposeAsync()
    {
        await DataSource.DisposeAsync();
        await _container.DisposeAsync();
    }

    /// <summary>An EF context on the same data source, for the transaction a repository joins.</summary>
    public AppDbContext NewDbContext()
    {
        var options = new Microsoft.EntityFrameworkCore.DbContextOptionsBuilder<AppDbContext>();
        options.UseTextStackNpgsql(DataSource);
        return new AppDbContext(options.Options, new CurrentSite(SiteConstants.DefaultSiteId));
    }

    /// <summary>A fresh user with one uploaded book: (userId, userBookId).</summary>
    public async Task<(Guid UserId, Guid UserBookId)> NewReaderWithBookAsync()
    {
        var (userId, bookId) = (Guid.NewGuid(), Guid.NewGuid());
        await using var batch = DataSource.CreateBatch();
        batch.BatchCommands.Add(new NpgsqlBatchCommand("INSERT INTO users (id, email, google_subject, created_at) VALUES ($1, $1::text || '@test', $1::text, now())")
        { Parameters = { new() { Value = userId } } });
        batch.BatchCommands.Add(new NpgsqlBatchCommand("""
            INSERT INTO user_books (id, user_id, title, slug, language, status, created_at, updated_at)
            VALUES ($1, $2, 'A book', 'a-book', 'en', 0, now(), now())
            """) { Parameters = { new() { Value = bookId }, new() { Value = userId } } });
        await batch.ExecuteNonQueryAsync();
        return (userId, bookId);
    }

    /// <summary>A catalog edition the baseline seeds.</summary>
    public async Task<Guid> AnyEditionAsync()
    {
        await using var cmd = DataSource.CreateCommand("SELECT id FROM editions ORDER BY id LIMIT 1");
        return (Guid)(await cmd.ExecuteScalarAsync())!;
    }

    internal static string RepoRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "database", "migrate.sh")))
                return dir.FullName;
        throw new InvalidOperationException("database/migrate.sh not found above " + AppContext.BaseDirectory);
    }
}
