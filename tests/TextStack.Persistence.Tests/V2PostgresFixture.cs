using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Vocabulary;
using Dapper;
using Domain.Discussion;
using Domain.Identity;
using Domain.Library;
using Infrastructure.Persistence;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using TextStack.Ai.Core;
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

    /// <summary>
    /// One row of the user in every V2 table that can carry a user (two reading sessions: one of the
    /// book, one of a deleted book): the library side, and the identity and ops rows that point only at
    /// <c>users</c> (a session, a reset code, an approved OAuth request, a grant, an approved device
    /// login, a connect key, an agent run, an LLM trace). Returns the book and its share.
    /// </summary>
    public async Task<(Book Book, SharedChapter Share)> SeedEverythingAsync(Guid userId)
    {
        var book = await NewBookAsync(userId);
        var file = book.CurrentFile!;
        await new ReadingStateRepository(DataSource).AdvanceAsync(userId, book.Id,
            new() { FileId = file.Id, CurrentLocator = TestJson.Page(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, Ct);
        await new AnnotationRepository(DataSource).SaveAsync(userId,
            new() { Id = Guid.NewGuid(), UserId = userId, BookId = book.Id, FileId = file.Id, SelectedText = "quoted", Locator = TestJson.Page(1) }, null, Ct);
        var vocabulary = new VocabularyRepository(DataSource);
        var card = (await vocabulary.SaveWordAsync(userId, new() { Id = Guid.NewGuid(), UserId = userId, Language = "en", Word = "quiver", WordKey = "quiver" }, Ct)).Word!;
        await vocabulary.AddExampleAsync(userId, new()
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            WordId = card.Id,
            BookId = book.Id,
            FileId = file.Id,
            Sentence = "A quiver of arrows.",
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256("A quiver of arrows."),
        }, Ct);
        await vocabulary.RecordReviewAsync(userId, new()
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            WordId = card.Id,
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256("correct"),
            ReviewMode = "flashcard",
            IsCorrect = true,
            ClientRecordedAt = DateTimeOffset.UtcNow,
        }, c => new ReviewSchedule(c.Stage + 1, 1m, 0), Ct);
        var share = NewShare(book);
        await new SharedChapterRepository(DataSource).ShareAsync(share, Ct);
        await new CheckpointRepository(DataSource).AppendAsync(NewCheckpoint(book, share), Ct);
        var insight = await new BookInsightRepository(DataSource).SaveReviewAsync(NewInsight(book, "ch-1", reviewJson: "{}"), Ct);
        await new ReviewQuestionRepository(DataSource).ReplaceForInsightAsync(userId, insight.Id,
            [new() { Id = Guid.NewGuid(), UserId = userId, BookInsightId = insight.Id, Prompt = "Why?", Answer = "Because.", PromptHash = "h1", NextReviewAt = DateTimeOffset.UtcNow }], Ct);
        await new BookChapterRepository(DataSource).InsertForFileAsync(userId, book.Id, file.Id,
            [new() { Id = Guid.NewGuid(), ChapterKey = "ch-1", ChapterNumber = 1, Title = "One", Html = "<p>x</p>", PlainText = "x" }], Ct);
        // Sessions have no repository yet (M2.2). The job is inserted finished, not enqueued: a queued
        // one would be claimable by the ingestion tests' ClaimNextAsync, which runs across users.
        var now = DateTimeOffset.UtcNow;
        var sessions = new SessionTokenRepository(DataSource);
        await sessions.IssueAsync(userId, NewHash(), now.AddDays(1), Ct);
        await sessions.CreatePasswordResetAsync(userId, NewHash(), now.AddHours(1), Ct);
        var oauth = new OAuthRepository(DataSource);
        var request = NewOAuthRequest();
        await oauth.CreateRequestAsync(request, Ct);
        await oauth.ApproveRequestAsync(request.Id, userId, NewHash(), now.AddMinutes(5), now, Ct);
        await oauth.ConnectAsync(userId, NewGrant(), Ct);
        var devices = new DeviceLoginRepository(DataSource);
        var login = NewDeviceLogin();
        await devices.CreateAsync(login, now, Ct);
        await devices.DecideAsync(login.UserCode, userId, now, Ct);
        await new McpKeyRepository(DataSource).CreateAsync(userId, "laptop", NewHash(), "tsk_ab", Ct);
        await new V2AgentRunWriter(DataSource).WriteAsync(NewRun(userId), Ct);
        await new V2LlmTraceWriter(DataSource).WriteAsync(NewTrace(userId), Ct);
        await using var conn = await DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition("""
            INSERT INTO reading_sessions (id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent, created_at)
            VALUES (gen_random_uuid(), @userId, @bookId, gen_random_uuid(), now(), now(), 60, 100, 0, 0.1, now()),
                   (gen_random_uuid(), @userId, NULL, gen_random_uuid(), now(), now(), 60, 100, 0, 0.1, now());
            INSERT INTO ingestion_jobs (id, user_id, book_id, file_id, status, attempt_count, created_at)
            VALUES (gen_random_uuid(), @userId, @bookId, @fileId, 'succeeded', 1, now());
            """, new { userId, bookId = book.Id, fileId = file.Id }, cancellationToken: Ct));
        return (book, share);
    }

    /// <summary>The user's rows in <paramref name="table"/> (a constant, never input), only those of <paramref name="bookId"/> when given.</summary>
    public async Task<long> CountAsync(string table, Guid userId, Guid? bookId = null)
    {
        await using var conn = await DataSource.OpenConnectionAsync(Ct);
        var sql = $"SELECT count(*) FROM {table} WHERE user_id = @userId" + (bookId is null ? "" : " AND book_id = @bookId");
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: Ct));
    }

    /// <summary>A new file version of the given book; its hash is unique unless one is given.</summary>
    public static BookFile NewFile(Guid userId, Guid bookId, string? sha256 = null, string format = "epub") => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        BookId = bookId,
        Sha256 = sha256 ?? PayloadSha256(Guid.NewGuid().ToString()),
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
        PayloadSha256 = PayloadSha256(Guid.NewGuid().ToString()),
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
        PayloadSha256 = PayloadSha256(Guid.NewGuid().ToString()),
    };

    /// <summary>A checkpoint based on <paramref name="share"/>: its chapter and file version.</summary>
    public static DiscussionCheckpoint NewCheckpoint(Book book, SharedChapter share)
    {
        var checkpoint = NewCheckpoint(book);
        (checkpoint.ChapterKey, checkpoint.FileId, checkpoint.SharedChapterId) = (share.ChapterKey, share.FileId, share.Id);
        return checkpoint;
    }

    /// <summary>
    /// The lowercase hex SHA-256 of <paramref name="payload"/>: a valid hash, the same for the same
    /// text, so a test replays by reusing it (the repositories store and compare the hash, they do not
    /// compute it). A unique one: <c>PayloadSha256(Guid.NewGuid().ToString())</c>.
    /// </summary>
    public static string PayloadSha256(string payload) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));

    /// <summary>A unique token hash.</summary>
    public static string NewHash() => PayloadSha256(Guid.NewGuid().ToString());

    /// <summary>A pending device login with a unique user code, open for ten minutes.</summary>
    public static DeviceLogin NewDeviceLogin() => new()
    {
        Id = Guid.NewGuid(),
        DeviceCodeHash = NewHash(),
        UserCode = Guid.NewGuid().ToString("N")[..16],
        ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(10),
        IntervalSeconds = 5,
    };

    /// <summary>The MCP resource the OAuth factories issue for.</summary>
    public const string OAuthResource = "https://textstack.test/mcp";

    /// <summary>A pending OAuth authorization from claude.ai, open for 30 minutes.</summary>
    public static OAuthAuthorization NewOAuthRequest() => new()
    {
        Id = Guid.NewGuid(),
        ClientId = "tsc_" + Guid.NewGuid(),
        ClientName = "Claude",
        RedirectUri = "https://claude.ai/api/mcp/auth_callback",
        CodeChallenge = new string('a', 43),
        Resource = OAuthResource,
        Scope = "library",
        ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(30),
    };

    /// <summary>A fresh grant of the app "Claude" redirecting to <paramref name="redirectUri"/>; its access token lives an hour.</summary>
    public static OAuthTokenGrant NewGrant(string redirectUri = "https://claude.ai/api/mcp/auth_callback") => new()
    {
        Id = Guid.NewGuid(),
        ClientId = "tsc_" + Guid.NewGuid(),
        ClientName = "Claude",
        RedirectUri = redirectUri,
        Resource = OAuthResource,
        Scope = "library",
        AccessTokenHash = NewHash(),
        AccessTokenExpiresAt = DateTimeOffset.UtcNow.AddHours(1),
        RefreshTokenHash = NewHash(),
        RefreshTokenExpiresAt = DateTimeOffset.UtcNow.AddDays(90),
    };

    /// <summary>A trace of one LLM call made for <paramref name="userId"/>.</summary>
    public static LlmTrace NewTrace(Guid userId) => new(
        Guid.NewGuid(), "explain", "gpt-test", "hash", "system", """[{"role":"user","content":"hi"}]""", "hello",
        null, 10, 5, 0.000123m, 42, userId, null, null, DateTimeOffset.UtcNow);

    /// <summary>A completed one-step agent run for <paramref name="userId"/>, on a catalog edition V2 does not keep.</summary>
    public static AgentRunRecord NewRun(Guid userId) => new(
        Guid.NewGuid(), "tutor", userId, Guid.NewGuid(), "explain chapter 1", "completed", "done",
        [new AgentStep(0, "final", JsonSerializer.SerializeToElement(new { text = "done" }), DateTimeOffset.UtcNow)],
        new AgentUsage(1, 10, 5, 0.0001m, 42), null, DateTimeOffset.UtcNow, 0.9, 2);

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
    /// Returns once some backend waits on a lock <paramref name="holder"/> holds, or
    /// <paramref name="pending"/> finished, or 5 s passed: how a race test knows the other side is
    /// parked before it lets go. Keyed on the holder, so another test's lock wait cannot end it early.
    /// </summary>
    public async Task WaitUntilBlockedByAsync(NpgsqlConnection holder, Task pending)
    {
        await using var observer = await DataSource.OpenConnectionAsync(Ct);
        for (var waited = 0; waited < 5000 && !pending.IsCompleted; waited += 10)
        {
            if (await observer.ExecuteScalarAsync<bool>(new CommandDefinition(
                    "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE @holderPid = ANY(pg_blocking_pids(pid)))",
                    new { holderPid = holder.ProcessID }, cancellationToken: Ct)))
                return;
            await Task.Delay(10, Ct);
        }
    }
}
