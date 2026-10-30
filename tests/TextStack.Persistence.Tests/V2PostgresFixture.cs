using System.Security.Cryptography;
using Dapper;
using Domain.Discussion;
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
    public async Task<Book> NewReaderWithBookAsync()
    {
        var userId = await NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), UserId = userId, Title = "A book", Tags = ["fiction"] };
        return await new LibraryRepository(DataSource).ImportAsync(book, NewFile(userId, book.Id), Ct);
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

    /// <summary>A share of chapter "ch-1" of the book's current file, under a fresh operation id.</summary>
    public static SharedChapter NewShare(Book book) => new()
    {
        Id = Guid.NewGuid(),
        UserId = book.UserId,
        BookId = book.Id,
        FileId = book.CurrentFile?.Id,
        ChapterKey = "ch-1",
        ChapterTitle = "One",
        ChapterText = "It was a dark night.",
        Language = "en",
        OperationId = Guid.NewGuid(),
        PayloadSha256 = NewPayloadSha256(),
    };

    /// <summary>A book-level checkpoint with one reader thought, under a fresh operation id.</summary>
    public static DiscussionCheckpoint NewCheckpoint(Book book) => new()
    {
        Id = Guid.NewGuid(),
        UserId = book.UserId,
        BookId = book.Id,
        Topic = "Why the night is dark",
        ReaderThoughts = """["It is a mood, not the weather."]""",
        Language = "en",
        OperationId = Guid.NewGuid(),
        PayloadSha256 = NewPayloadSha256(),
    };

    /// <summary>Any valid payload hash: the repositories store and compare it, they do not compute it.</summary>
    public static string NewPayloadSha256() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    /// <summary>A plain insight on the book (a review when <paramref name="reviewJson"/> is given).</summary>
    public static BookInsight NewInsight(Book book, string? chapterSlug, string text = "text", string? reviewJson = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = book.UserId,
        BookId = book.Id,
        ChapterSlug = chapterSlug,
        Text = text,
        Question = "q",
        ReviewJson = reviewJson,
    };

    /// <summary>
    /// Returns once some backend waits on a lock, or <paramref name="pending"/> finished, or 5 s
    /// passed: how a race test knows the other side is parked before it lets go of its own lock.
    /// </summary>
    public async Task WaitUntilBlockedOnALockAsync(Task pending)
    {
        await using var observer = await DataSource.OpenConnectionAsync(Ct);
        for (var waited = 0; waited < 5000 && !pending.IsCompleted; waited += 10)
        {
            if (await observer.ExecuteScalarAsync<bool>(new CommandDefinition(
                    "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock')",
                    cancellationToken: Ct)))
                return;
            await Task.Delay(10, Ct);
        }
    }
}
