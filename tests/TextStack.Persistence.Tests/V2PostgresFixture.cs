using System.Security.Cryptography;
using Dapper;
using Domain.Library;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Repositories;
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

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

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
        await using var conn = await DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "INSERT INTO users (id, email, created_at) VALUES (@userId, @email, now())",
            new { userId, email = $"{userId}@test" }, cancellationToken: Ct));
        return userId;
    }

    /// <summary>A fresh user with one imported book, titled "A book" and tagged "fiction"; it carries its current file.</summary>
    public async Task<Book> NewReaderWithBookAsync() => await NewBookAsync(await NewReaderAsync());

    /// <summary>Another imported book, tagged "fiction", in the user's library; its file hashes to <paramref name="sha256"/> when given.</summary>
    public Task<Book> NewBookAsync(Guid userId, string title = "A book", string? sha256 = null)
    {
        var book = new Book { Id = Guid.NewGuid(), UserId = userId, Title = title, Tags = ["fiction"] };
        return new LibraryRepository(DataSource).ImportAsync(book, NewFile(userId, book.Id, sha256), Ct);
    }

    /// <summary>The user's rows in <paramref name="table"/>, only those of <paramref name="bookId"/> when given.</summary>
    public async Task<long> CountAsync(string table, Guid userId, Guid? bookId = null)
    {
        await using var conn = await DataSource.OpenConnectionAsync(Ct);
        var sql = $"SELECT count(*) FROM {table} WHERE user_id = @userId" + (bookId is null ? "" : " AND book_id = @bookId");
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: Ct));
    }

    /// <summary>A new file version of the given book; its hash is of random bytes unless one is given.</summary>
    public static BookFile NewFile(Guid userId, Guid bookId, string? sha256 = null, string format = "epub") => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        BookId = bookId,
        Sha256 = sha256 ?? Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),
        ByteSize = 1024,
        OriginalName = "book." + format,
        Format = format,
    };
}
