using Application.Common;
using Application.Identity;
using Dapper;
using Domain.Identity;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IAccountMergeRepository"/> on <c>textstack_v2</c>
/// (v2-sync-protocol.md "Guest → account merge"; the order is the M2.5 plan's §2, steps 0–9). Rows
/// move by <c>UPDATE … SET user_id</c> on the roots and the <c>ON UPDATE CASCADE</c> of every
/// composite FK carries their children (ADR-031, amended 2026-11-01); the three edges that cascade
/// cannot handle are this class's: words before books, book-less sessions by hand, and every unique
/// key the account already holds, checked before anything moves (owner decision 12). Every statement
/// names the guest or the account.
/// <para>One class in four files, one per aggregate (Identity here, Vocabulary, Library, Discussion):
/// the merge is one transaction across all of them, so its order reads in one method, at the price of
/// bending data-access.md rule 13's ~250 lines per repository.</para>
/// </summary>
public sealed partial class AccountMergeRepository(V2DataSource dataSource) : IAccountMergeRepository
{
    // FOR UPDATE, not FOR NO KEY UPDATE: it conflicts with the FOR KEY SHARE every FK insert takes, so
    // neither user gains a root row (book, word, session, token) until the merge commits, and a
    // second merge of the guest waits here. Id order: two merges of crossed users cannot deadlock.
    private const string LockUsers = "SELECT id, is_guest FROM users WHERE id IN (@guestId, @accountId) ORDER BY id FOR UPDATE";

    public async Task<AccountMerge> MergeAsync(Guid guestId, Guid accountId, NpgsqlTransaction? tx, CancellationToken ct)
    {
        if (guestId == accountId) return AccountMerge.Refused;
        await using var unit = await dataSource.JoinOrBeginAsync(tx, ct);
        var run = new Run(unit, guestId, accountId, ct);

        // 0. Lock and check.
        var users = await run.QueryAsync<(Guid Id, bool IsGuest)>(LockUsers);
        if (!users.Exists(u => u.Id == guestId)) return AccountMerge.NoGuest;
        if (!users.Exists(u => u.Id == guestId && u.IsGuest) || !users.Exists(u => u.Id == accountId && !u.IsGuest))
            return AccountMerge.Refused;

        // 1. Guest copies of what the account already holds.
        var (dropped, anomalies, unlinkedCheckpoints) = await DropGuestCopiesAsync(run);
        // Read before anything moves: which books match, and which of their appends change hash.
        var books = await MatchBooksAsync(run);
        var appends = await AppendsOnMatchedBooksAsync(run, books);
        // 2. Words, first: an example's word FK is immediate, its book FKs deferred.
        var (words, reviews) = await MergeWordsAsync(run);
        // 3. Matched books: state, file references, insights, then the emptied guest book.
        await MergeReadingStatesAsync(run, books);
        await MoveOntoAccountBooksAsync(run, books);
        var unscheduledQuestions = await MergeInsightsAsync(run, books);
        // 4–6. Unmatched books with their ids, book-less sessions, feed timestamps.
        await MoveBooksAsync(run, books);
        // 7. Hashes whose hashed ids changed.
        await RehashExamplesAsync(run, appends.Examples);
        await RehashReviewsAsync(run, reviews);
        await RehashSharesAsync(run, appends.Shares);
        await RehashCheckpointsAsync(run, [.. appends.Checkpoints, .. unlinkedCheckpoints]);
        // 8–9. What no cascade reaches, then the guest itself.
        await run.ExecuteAsync(MoveAccountLevelRows);
        await run.ExecuteAsync(FoldGuestIntoAccount);
        await run.ExecuteAsync(DeleteGuest);
        await unit.CommitAsync(ct);
        return new(AccountMergeOutcome.Merged,
            books.ToDictionary(b => b.GuestBook, b => b.AccountBook), books.ToDictionary(b => b.GuestFile, b => b.AccountFile),
            words, dropped, anomalies, unscheduledQuestions);
    }

    // Checkpoints whose share step 1 drops: the FK's SET NULL unlinks them, and the share id is hashed.
    private const string SelectCheckpointsOfDroppedShares = """
        SELECT c.id FROM discussion_checkpoints c
        JOIN shared_chapters g ON g.user_id = c.user_id AND g.book_id = c.book_id AND g.id = c.shared_chapter_id
        JOIN shared_chapters a ON a.user_id = @accountId AND a.operation_id = g.operation_id
        WHERE c.user_id = @guestId
        """;

    // One device pushed the same outbox entry under both identities: the account's row stays. Each
    // returns whether the payloads differ, an anomaly logged, not an error (PDD). Checkpoints go
    // before shares, so a dropped checkpoint is not first unlinked by its dropped share.
    private const string DropCheckpointCopies = """
        DELETE FROM discussion_checkpoints g USING discussion_checkpoints a
        WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.operation_id = g.operation_id
        RETURNING g.payload_sha256 <> a.payload_sha256
        """;
    private const string DropShareCopies = """
        DELETE FROM shared_chapters g USING shared_chapters a
        WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.operation_id = g.operation_id
        RETURNING g.payload_sha256 <> a.payload_sha256
        """;
    private const string DropExampleCopies = """
        DELETE FROM vocabulary_examples g USING vocabulary_examples a
        WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.operation_id = g.operation_id
        RETURNING g.payload_sha256 <> a.payload_sha256
        """;
    private const string DropReviewCopies = """
        DELETE FROM vocabulary_reviews g USING vocabulary_reviews a
        WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.operation_id = g.operation_id
        RETURNING g.payload_sha256 <> a.payload_sha256
        """;
    // A session has no payload hash: its client_session_id is the whole identity.
    private const string DropSessionCopies = """
        DELETE FROM reading_sessions g USING reading_sessions a
        WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.client_session_id = g.client_session_id
        RETURNING false
        """;

    private static async Task<(int Dropped, int Anomalies, List<Guid> UnlinkedCheckpoints)> DropGuestCopiesAsync(Run run)
    {
        var unlinked = await run.QueryAsync<Guid>(SelectCheckpointsOfDroppedShares);
        var (dropped, anomalies) = (0, 0);
        foreach (var drop in (string[])[DropCheckpointCopies, DropShareCopies, DropExampleCopies, DropReviewCopies, DropSessionCopies])
        {
            var differs = await run.QueryAsync<bool>(drop);
            (dropped, anomalies) = (dropped + differs.Count, anomalies + differs.Count(d => d));
        }
        return (dropped, anomalies, unlinked);
    }

    // No cascade reaches these (they point only at users). Runs, OAuth grants and connect keys move:
    // the signer-in proved the account. Sessions, reset codes, device logins and OAuth requests die
    // with the guest row (DeleteGuest); llm_traces have no FK and keep the guest's id (ADR-031).
    private const string MoveAccountLevelRows = """
        UPDATE agent_run SET user_id = @accountId WHERE user_id = @guestId;
        UPDATE oauth_grants SET user_id = @accountId WHERE user_id = @guestId;
        UPDATE mcp_access_keys SET user_id = @accountId WHERE user_id = @guestId
        """;

    // The guest's native language only when the account has none (legacy MergeGuestAsync's rule);
    // tier, role and limits are the account's grants. ponytail: storage_used_bytes is not added: no V2
    // bytes exist before M2.6, which decides whether quota is a counter or a SUM (plan §9 q9).
    private const string FoldGuestIntoAccount = """
        UPDATE users a SET
            native_language = coalesce(nullif(a.native_language, ''), g.native_language),
            last_active_at = greatest(a.last_active_at, g.last_active_at)
        FROM users g
        WHERE a.id = @accountId AND g.id = @guestId
        """;

    // It owns nothing but what dies with it by now, so the cascade meets no NO ACTION FK (#1089).
    private const string DeleteGuest = "DELETE FROM users WHERE id = @guestId";

    /// <summary>One merge's transaction and its two users: every statement gets both ids as <c>@guestId</c> and <c>@accountId</c>.</summary>
    private sealed class Run(V2Transaction unit, Guid guestId, Guid accountId, CancellationToken ct)
    {
        public Guid GuestId => guestId;
        public Guid AccountId => accountId;

        public Task<int> ExecuteAsync(string sql, object? args = null) => unit.Connection.ExecuteAsync(Command(sql, args));

        public async Task<List<T>> QueryAsync<T>(string sql, object? args = null) => (await unit.Connection.QueryAsync<T>(Command(sql, args))).AsList();

        public async Task<List<TResult>> QueryAsync<T1, T2, TResult>(string sql, Func<T1, T2, TResult> map, string splitOn, object? args = null) =>
            (await unit.Connection.QueryAsync(Command(sql, args), map, splitOn)).AsList();

        private CommandDefinition Command(string sql, object? args)
        {
            var parameters = new DynamicParameters(new { guestId, accountId });
            if (args is not null) parameters.AddDynamicParams(args);
            return new CommandDefinition(sql, parameters, unit.Transaction, cancellationToken: ct);
        }
    }
}
