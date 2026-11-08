using Application.Sync;
using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Reading sessions (ADR-031 row 45): same id, <c>client_session_id</c> = legacy id, one nullable <c>book_id</c>:
/// the upload's id, or the catalog pair's book when the pair is carried. A session with no book (a deleted book,
/// or a session-only catalog pair: no intent row, so not a pair, v2-plan §5.2) is carried with <c>book_id</c>
/// NULL and its seconds kept (owner 2026-11-08); <c>deleted_book_sha256</c> as stored. Conflict rule: insert
/// what V2 lacks, leave what is equal; a V2 row that differs is a failed check, never overwritten.
/// </summary>
public static class EtlV2Sessions
{
    public static readonly EtlV2Step Step = new("sessions", ["reading_sessions", "user_books", "users", "admin_users"], ["reading_sessions"], RunAsync);

    private const string SelectLegacySessions = """
        SELECT id, user_id, edition_id, user_book_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at
        FROM reading_sessions ORDER BY id
        """;

    private const string SelectV2Sessions = """
        SELECT id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at
        FROM reading_sessions
        """;

    private const string InsertSession = """
        INSERT INTO reading_sessions (id, user_id, book_id, client_session_id, started_at, ended_at, duration_seconds, words_read, start_percent, end_percent,
            deleted_book_sha256, created_at)
        VALUES (@Id, @UserId, @BookId, @ClientSessionId, @StartedAt, @EndedAt, @DurationSeconds, @WordsRead, @StartPercent, @EndPercent,
            @DeletedBookSha256, @CreatedAt)
        """;

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var uploadOwner = await EtlV2Rows.UploadOwnersAsync(context, ct);
        // The catalog step's pairs: carried → linked; refused (its check already fails the run) → neither linked nor "session-only".
        var pairs = EtlV2Rows.CatalogPairs(context);
        var legacy = await EtlV2Rows.SourceAsync<LegacySession>(context, SelectLegacySessions, null, ct);
        var admitted = EtlV2Rows.Admit(context, "reading_sessions", legacy, s => s.Id,
            // Negated, so NaN is outside too (Numeric cannot carry it).
            ("percent outside 0..1", s => !(s.StartPercent is >= 0 and <= 1) || !(s.EndPercent is >= 0 and <= 1)),
            ("negative duration or words", s => s.DurationSeconds < 0 || s.WordsRead < 0),
            ("deleted_book_sha256 is not lowercase hex", s => s.DeletedBookSha256 is { } sha && SyncValidation.Sha256(sha) is not null),
            ("its upload belongs to another user", s => s.UserBookId is { } ub && uploadOwner[ub] != s.UserId));
        // A report, not a failure (catalog plan §6.2 item 10): the session stays, with no book.
        foreach (var s in admitted.Where(s => s.EditionId is { } e && !pairs.ContainsKey((s.UserId, e))))
            context.OrphanCandidates.Add($"reading_sessions {s.Id}: session-only catalog pair; carried with no book");
        var sessions = admitted.Select(s => new SessionRow
        {
            Id = s.Id,
            UserId = s.UserId,
            BookId = s.UserBookId ?? (s.EditionId is { } e && pairs.GetValueOrDefault((s.UserId, e)) ? EtlV2Ids.CatalogBook(s.UserId, e) : null),
            ClientSessionId = s.Id,
            StartedAt = s.StartedAt,
            EndedAt = s.EndedAt,
            DurationSeconds = s.DurationSeconds,
            WordsRead = s.WordsRead,
            StartPercent = EtlV2Rows.Numeric(s.StartPercent),
            EndPercent = EtlV2Rows.Numeric(s.EndPercent),
            DeletedBookSha256 = s.DeletedBookSha256,
            CreatedAt = s.CreatedAt,
        }).ToList();

        var v2 = await EtlV2Rows.TargetAsync<SessionRow>(context, SelectV2Sessions, null, ct);
        var plan = EtlV2Rows.Plan(context, "reading_sessions", sessions, v2, s => s.Id);
        EtlV2Rows.HeldByAnother(context, "reading_sessions: (user_id, client_session_id)", sessions, v2, s => s.Id, s => (s.UserId, s.ClientSessionId));

        if (!context.MayWrite)
            return;
        await using (var tx = await context.BeginWriteAsync(ct))
        {
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertSession, plan.New, tx.Transaction, cancellationToken: ct));
            await tx.CommitAsync(ct);
        }

        var after = await EtlV2Rows.TargetAsync<SessionRow>(context, SelectV2Sessions, null, ct);
        EtlV2Rows.Verify(context, "reading_sessions: parity", sessions, after, s => s.Id);
        // Per carried user, every legacy session against every V2 one: a session not carried, or one V2 has beyond legacy's,
        // shows here. A V2-only user's sessions are report-only (the plan's cleanup lines), never this failure (owner 2026-11-08).
        var carried = await EtlV2Rows.CarriedUserIdsAsync(context, ct);
        var expected = legacy.GroupBy(s => s.UserId).ToDictionary(g => g.Key, g => g.Sum(s => (long)s.DurationSeconds));
        var actual = after.Where(s => carried.Contains(s.UserId)).GroupBy(s => s.UserId).ToDictionary(g => g.Key, g => g.Sum(s => (long)s.DurationSeconds));
        EtlV2Rows.Check(context, "reading_sessions: seconds per user differ",
            expected.Keys.Union(actual.Keys).Where(u => expected.GetValueOrDefault(u) != actual.GetValueOrDefault(u)).Select(u => u.ToString()));
    }

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

    private sealed record SessionRow
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
