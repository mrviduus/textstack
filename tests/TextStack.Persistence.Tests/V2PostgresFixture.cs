using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Application.Library;
using Application.Vocabulary;
using Dapper;
using Domain.Discussion;
using Domain.Identity;
using Domain.Library;
using Domain.Vocabulary;
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
public sealed class V2PostgresFixture : IAsyncLifetime, Identity.IIdentityFixture
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

    /// <summary>A fresh V2 user (a guest when <paramref name="isGuest"/>); its email is unique, as <c>ix_users_email</c> requires.</summary>
    public async Task<Guid> NewReaderAsync(bool isGuest = false)
    {
        var userId = Guid.NewGuid();
        await ExecAsync("INSERT INTO users (id, email, is_guest, created_at) VALUES (@userId, @email, @isGuest, now())",
            new { userId, email = $"{userId}@test", isGuest });
        return userId;
    }

    /// <summary>Runs <paramref name="sql"/> (a test's own setup, never input) in its own autocommit.</summary>
    public Task ExecAsync(string sql, object args) => Identity.TestSql.ExecAsync(DataSource.OpenConnectionAsync, sql, args);

    public Task<T> ScalarAsync<T>(string sql, object args) => Identity.TestSql.ScalarAsync<T>(DataSource.OpenConnectionAsync, sql, args);

    private const string UserTables = "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY 1";

    // The two roots and every table whose ownership is in a composite key (ADR-031 rule 2): what a
    // reparenting of the roots carries. Tables that point only at users are reached by no cascade.
    private const string CascadedTables = """
        SELECT conrelid::regclass::text FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confrelid <> 'public.users'::regclass
        UNION SELECT 'books' UNION SELECT 'vocabulary_words'
        ORDER BY 1
        """;

    /// <summary>
    /// The tables that hold a user's rows, from the catalog, so a table added later is asserted on
    /// without anyone listing it: every one with a <c>user_id</c>, or only those the roots' cascade reaches.
    /// </summary>
    public async Task<List<string>> UserTablesAsync(bool reachedByCascade = false)
    {
        await using var conn = await DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<string>(new CommandDefinition(reachedByCascade ? CascadedTables : UserTables, cancellationToken: Ct))).AsList();
    }

    /// <summary>How many rows <see cref="SeedEverythingAsync"/> gives its user in <paramref name="table"/>: two sessions (one of a deleted book), one of everything else.</summary>
    public static long Seeded(string table) => table == "reading_sessions" ? 2 : 1;

    /// <summary>A fresh user with one imported book, titled "A book" and tagged "fiction"; it carries its current file.</summary>
    public async Task<Book> NewReaderWithBookAsync() => await NewBookAsync(await NewReaderAsync());

    /// <summary>Another imported book, tagged "fiction", in the user's library; its file hashes to <paramref name="sha256"/> when given.</summary>
    public async Task<Book> NewBookAsync(Guid userId, string title = "A book", string? sha256 = null)
    {
        var book = new Book { Id = Guid.NewGuid(), Title = title, Tags = ["fiction"] };
        return (await new LibraryRepository(DataSource).ImportAsync(userId, book, NewFile(userId, book.Id, sha256), Ct)).Book!;
    }

    /// <summary>A new current file for the book, as a client that saw its current one replaces it.</summary>
    public Task<FileReplacement> ReplaceFileAsync(Book book) =>
        new LibraryRepository(DataSource).ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), book.CurrentFile?.Id, null, Ct);

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
            new() { FileId = file.Id, CurrentLocator = TestJson.Cfi(1), BookFraction = 0.1m, ClientRecordedAt = DateTimeOffset.UtcNow }, null, default, Ct);
        await new AnnotationRepository(DataSource).SaveAsync(userId,
            new() { Id = Guid.NewGuid(), UserId = userId, BookId = book.Id, FileId = file.Id, SelectedText = "quoted", Locator = TestJson.Cfi(1) }, null, Ct);
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
        }, c => new ReviewSchedule(c.Stage + 1, 1m, 0, Retire: false), Ct);
        var share = NewShare(book);
        await new SharedChapterRepository(DataSource).ShareAsync(share, Ct);
        await new CheckpointRepository(DataSource).AppendAsync(NewCheckpoint(book, share), Ct);
        var insight = await new BookInsightRepository(DataSource).SaveReviewAsync(NewInsight(book, "ch-1", reviewJson: "{}"), Ct);
        await new ReviewQuestionRepository(DataSource).ReplaceForInsightAsync(userId, insight.Id,
            [new() { Id = Guid.NewGuid(), UserId = userId, BookInsightId = insight.Id, Prompt = "Why?", Answer = "Because.", PromptHash = "h1", NextReviewAt = DateTimeOffset.UtcNow }], Ct);
        await new BookChapterRepository(DataSource).ReplaceForFileAsync(userId, book.Id, file.Id,
            [new() { Id = Guid.NewGuid(), ChapterKey = "ch-1", ChapterNumber = 1, Title = "One", Html = "<p>x</p>", PlainText = "x" }], Ct);
        // The job is inserted finished, not enqueued: a queued one would be claimable by the ingestion
        // tests' ClaimNextAsync, which runs across users.
        var now = DateTimeOffset.UtcNow;
        var sessions = new SessionTokenRepository(DataSource);
        await sessions.IssueAsync(userId, NewHash(), now.AddDays(1), null, null, Application.Identity.SessionKind.Reader, Ct);
        await sessions.CreatePasswordResetAsync(userId, NewHash(), now.AddHours(1), Ct);
        await new OAuthRepository(DataSource).ConnectAsync(userId, await ApprovedOAuthRequestAsync(userId), NewGrant(), Ct);
        await ApprovedDeviceLoginAsync(userId);
        await new McpKeyRepository(DataSource).CreateAsync(userId, "laptop", NewHash(), "tsk_ab", DateTimeOffset.UtcNow, Ct);
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

    /// <summary>An OAuth request the user approved just now (what a grant is connected for); its id.</summary>
    public async Task<Guid> ApprovedOAuthRequestAsync(Guid userId)
    {
        var oauth = new OAuthRepository(DataSource);
        var request = NewOAuthRequest();
        await oauth.CreateRequestAsync(request, Ct);
        await oauth.ApproveRequestAsync(request.Id, userId, NewHash(), DateTimeOffset.UtcNow.AddMinutes(5), DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        return request.Id;
    }

    /// <summary>The user's rows in <paramref name="table"/> (a constant, never input), only those of <paramref name="bookId"/> when given.</summary>
    public Task<long> CountAsync(string table, Guid userId, Guid? bookId = null) => Identity.TestSql.CountAsync(DataSource.OpenConnectionAsync, table, userId, bookId);

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

    /// <summary>A card for <paramref name="userId"/>: English, its key the word itself.</summary>
    public static VocabularyWord NewWord(Guid userId, string key = "quiver", string? translation = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        Language = "en",
        Word = key,
        WordKey = key,
        Translation = translation,
    };

    /// <summary>An example for <paramref name="card"/>; its hash is of the sentence, so the same sentence replays.</summary>
    public static VocabularyExample NewExample(VocabularyWord card, string sentence, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = card.UserId,
        WordId = card.Id,
        Sentence = sentence,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = PayloadSha256(sentence),
    };

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
    /// <summary>
    /// A transaction that holds <paramref name="user"/>'s row <c>FOR NO KEY UPDATE</c> (as a reset or a
    /// rotation does) and runs <paramref name="alsoSql"/> (<c>@user</c>; a test's own SQL) while
    /// <paramref name="pending"/> starts; once that blocks on the holder, <paramref name="beforeCommit"/>
    /// runs, then the holder commits. Whether it waited, and its result.
    /// </summary>
    public async Task<(bool Waited, T Result)> WhileUserHeldAsync<T>(
        Guid user, string? alsoSql, Func<Task<T>> pending, Func<Task>? beforeCommit = null)
    {
        await using var holder = await DataSource.OpenConnectionAsync(Ct);
        await using var tx = await holder.BeginTransactionAsync(Ct);
        await holder.ExecuteAsync(new CommandDefinition(
            "SELECT FROM users WHERE id = @user FOR NO KEY UPDATE;" + alsoSql, new { user }, tx, cancellationToken: Ct));
        var task = pending();
        await WaitUntilBlockedByAsync(holder, task);
        var waited = !task.IsCompleted;
        if (beforeCommit is not null) await beforeCommit();
        await tx.CommitAsync(Ct);
        return (waited, await task);
    }

    /// <summary>Moves every session of the user <paramref name="interval"/> (SQL, a constant) into the past: past the reuse grace, or the absolute lifetime.</summary>
    public Task AgeSessionsAsync(Guid user, string interval) =>
        ExecAsync($"UPDATE user_refresh_tokens SET created_at = now() - interval '{interval}' WHERE user_id = @user", new { user });

    /// <summary>Stamps the user's password reset at <paramref name="at"/>, as a reset would.</summary>
    public Task ResetCredentialsAtAsync(Guid user, DateTimeOffset at) =>
        ExecAsync("UPDATE users SET credentials_reset_at = @at WHERE id = @user", new { at, user });

    /// <summary>A new account with the admin role.</summary>
    public async Task<Guid> NewAdminAsync()
    {
        var admin = await NewReaderAsync();
        await ExecAsync("UPDATE users SET role = 'admin' WHERE id = @admin", new { admin });
        return admin;
    }

    /// <summary>A device login the user approved just now.</summary>
    public async Task<DeviceLogin> ApprovedDeviceLoginAsync(Guid userId)
    {
        var devices = new DeviceLoginRepository(DataSource);
        var login = NewDeviceLogin();
        await devices.CreateAsync(login, Ct);
        await devices.DecideAsync(login.UserCode, userId, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, Ct);
        return login;
    }

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
