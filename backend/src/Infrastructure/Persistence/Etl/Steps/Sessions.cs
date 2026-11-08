using Dapper;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// M3.3 reading sessions (ADR-031 #45): same id, <c>client_session_id</c> = legacy id, one nullable
/// <c>book_id</c>: the upload's id, or the catalog pair's book when the pair is carried. A session on
/// a deleted book, or on a session-only catalog pair (no intent row: not a pair, v2-plan §5.2), keeps
/// <c>book_id</c> NULL and still counts in stats; <c>deleted_book_sha256</c> is carried as it is.
/// </summary>
public static class EtlV2Sessions
{
    public static readonly string[] SourceTables = ["reading_sessions", "user_books", .. EtlV2Catalog.SourceTables];

    public static readonly string[] TargetTables = ["reading_sessions"];

    public static readonly EtlV2Step Step = new("sessions", RunAsync);

    private const string LegacySessions = """
        SELECT id, user_id, edition_id, user_book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at
        FROM reading_sessions ORDER BY id
        """;

    private const string UploadOwners = "SELECT id, user_id FROM user_books";

    private const string SelectSessions = """
        SELECT id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at
        FROM reading_sessions WHERE id = ANY(@ids)
        """;

    private const string InsertSession = """
        INSERT INTO reading_sessions (id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at)
        VALUES (@Id, @UserId, @BookId, @ClientSessionId, @StartedAt, @EndedAt, @DurationSeconds, @WordsRead, @StartPercent, @EndPercent,
            @DeletedBookSha256, @CreatedAt)
        """;

    private const string SecondsPerUser = "SELECT user_id, sum(duration_seconds) FROM reading_sessions GROUP BY user_id";

    private static Task RunAsync(EtlV2Context context, CancellationToken ct) => EtlV2Rows.InTargetAsync(context, async tx =>
    {
        var source = context.Source;
        var users = await EtlV2Rows.KnownUsersAsync(context, tx, ct);
        var legacy = (await source.Connection!.QueryAsync<LegacySession>(new CommandDefinition(LegacySessions, transaction: source, cancellationToken: ct))).AsList();
        var uploadOwner = (await source.Connection!.QueryAsync<(Guid Id, Guid UserId)>(new CommandDefinition(UploadOwners, transaction: source, cancellationToken: ct)))
            .ToDictionary(b => b.Id, b => b.UserId);
        var pairs = (await source.Connection!.QueryAsync<EtlV2Catalog.IntentPair>(new CommandDefinition(EtlV2Catalog.IntentPairs, transaction: source, cancellationToken: ct)))
            .Where(p => p.EditionExists).Select(p => (p.UserId, p.EditionId)).ToHashSet();

        EtlV2Rows.Orphans(context, "reading_sessions", legacy.Where(s => !users.Contains(s.UserId)).Select(s => (s.Id, $"user {s.UserId} is not in the target")));
        var mine = legacy.Where(s => users.Contains(s.UserId)).ToList();
        // A report, not a failure (catalog plan §6.2 item 10): the session stays, with no book.
        EtlV2Rows.Orphans(context, "reading_sessions", mine.Where(s => s.EditionId is { } e && !pairs.Contains((s.UserId, e)))
            .Select(s => (s.Id, "session-only catalog pair: carried with no book")));
        var unmappable = new List<(Guid, string)>();
        var planned = new List<Session>();
        foreach (var s in mine)
        {
            var reason = s.StartPercent is < 0 or > 1 || s.EndPercent is < 0 or > 1 ? "percent outside 0..1"
                : s.DurationSeconds < 0 || s.WordsRead < 0 ? "negative duration or words"
                : s.DeletedBookSha256 is { } sha && !IsSha256(sha) ? "deleted_book_sha256 is not lowercase hex"
                : s.UserBookId is { } ub && uploadOwner[ub] != s.UserId ? "its upload belongs to another user"
                : null;
            if (reason is not null)
            {
                unmappable.Add((s.Id, reason));
                continue;
            }
            planned.Add(new Session
            {
                Id = s.Id,
                UserId = s.UserId,
                BookId = s.UserBookId ?? (s.EditionId is { } e && pairs.Contains((s.UserId, e)) ? EtlV2Ids.CatalogBook(s.UserId, e) : null),
                ClientSessionId = s.Id,
                StartedAt = s.StartedAt,
                EndedAt = s.EndedAt,
                DurationSeconds = s.DurationSeconds,
                WordsRead = s.WordsRead,
                StartPercent = EtlV2Rows.Numeric(s.StartPercent),
                EndPercent = EtlV2Rows.Numeric(s.EndPercent),
                DeletedBookSha256 = s.DeletedBookSha256,
                CreatedAt = s.CreatedAt,
            });
        }
        EtlV2Rows.Unmappable(context, "reading_sessions", unmappable);

        await EtlV2Rows.ConvergeAsync(context, tx, "reading_sessions", planned, s => s.Id, SelectSessions, InsertSession, ct);
        if (context.DryRun)
            return;

        // Every legacy session of a carried user counts, so a row not carried shows here too.
        var expected = mine.GroupBy(s => s.UserId).ToDictionary(g => g.Key, g => g.Sum(s => (long)s.DurationSeconds));
        var actual = (await tx.Connection!.QueryAsync<(Guid UserId, long Seconds)>(new CommandDefinition(SecondsPerUser, transaction: tx, cancellationToken: ct)))
            .ToDictionary(r => r.UserId, r => r.Seconds);
        context.Checks.Add(new("sessions.seconds-per-user-equal",
            expected.Keys.Union(actual.Keys).Count(u => expected.GetValueOrDefault(u) != actual.GetValueOrDefault(u))));
    }, ct);

    private static bool IsSha256(string s) => s.Length == 64 && s.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f'));

    private sealed record LegacySession
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid? EditionId { get; init; }
        public Guid? UserBookId { get; init; }
        public DateTimeOffset StartedAt { get; init; }
        public DateTimeOffset EndedAt { get; init; }
        public int DurationSeconds { get; init; }
        public int WordsRead { get; init; }
        public double StartPercent { get; init; }
        public double EndPercent { get; init; }
        public string? DeletedBookSha256 { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }

    internal sealed record Session
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid? BookId { get; init; }
        public Guid ClientSessionId { get; init; }
        public DateTimeOffset StartedAt { get; init; }
        public DateTimeOffset EndedAt { get; init; }
        public int DurationSeconds { get; init; }
        public int WordsRead { get; init; }
        public decimal StartPercent { get; init; }
        public decimal EndPercent { get; init; }
        public string? DeletedBookSha256 { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }
}
