using Application.Common;
using Application.Discussion;
using Application.Identity;
using Application.Vocabulary;
using Dapper;
using Domain.Discussion;
using Domain.Identity;
using Domain.Reading;
using Domain.Vocabulary;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <inheritdoc cref="IAccountMergeRepository"/>
/// <remarks>
/// Dapper on <c>textstack_v2</c>, in the M2.5 plan's order (§2, steps 0–9). Rows move by <c>UPDATE …
/// SET user_id</c> on the roots and the <c>ON UPDATE CASCADE</c> of every composite FK carries their
/// children (ADR-031, amended 2026-11-01); the three edges the cascade cannot handle are this class's:
/// words before books, book-less sessions by hand, and every unique key the account already holds,
/// dropped before anything moves (owner decision 12). Every statement names the guest or the account.
/// <para>Locked before any read, in one statement each and in id order: both users (no new root row,
/// and a second merge of the guest waits), every guest book and every live account book whose current
/// file holds the bytes of a guest book's current file (a child or a file replacement in flight commits
/// first and is seen; the next waits for the merge). Then six round trips and the commit: the steps
/// are batched as multi-statement commands, in order.</para>
/// <para>The reading-state rule stays in C# (<see cref="ReadingState.Merge"/>): one SQL
/// <c>INSERT … SELECT … LATERAL</c> would be shorter and much harder to read.</para>
/// <para>One class in four files, one per aggregate (Identity here, Vocabulary, Library, Discussion):
/// the merge is one transaction across all of them, so its order reads in one method, at the price of
/// bending data-access.md rule 13's ~250 lines per repository.</para>
/// </remarks>
public sealed partial class AccountMergeRepository(V2DataSource dataSource) : IAccountMergeRepository
{
    public async Task<AccountMerge> MergeAsync(Guid guestId, Guid accountId, NpgsqlTransaction? tx, CancellationToken ct)
    {
        if (guestId == accountId) return AccountMerge.Refused;
        await using var unit = await dataSource.JoinOrBeginAsync(tx, ct);
        var run = new Run(unit, guestId, accountId, ct);

        // 0. Lock, then check: nothing has changed if the merge stops here.
        List<(Guid Id, bool IsGuest)> users;
        List<(Guid Id, bool OfGuest)> lockedBooks;
        await using (var locked = await run.QueryMultipleAsync(Lock))
            (users, lockedBooks) = ((await locked.ReadAsync<(Guid, bool)>()).AsList(), (await locked.ReadAsync<(Guid, bool)>()).AsList());
        if (!users.Exists(u => u.Id == guestId)) return AccountMerge.NoGuest;
        if (!users.Exists(u => u.Id == guestId && u.IsGuest) || !users.Exists(u => u.Id == accountId)) return AccountMerge.Refused;

        // 1. The account's guest flag, guest copies of what the account holds, and which books match.
        List<(Guid Checkpoint, Guid AccountShare)> unlinked;
        var (dropped, anomalies) = (0, 0);
        List<BookMatch> books;
        await using (var first = await run.QueryMultipleAsync(DropCopiesAndMatch))
        {
            unlinked = (await first.ReadAsync<(Guid, Guid)>()).AsList();
            for (var drop = 0; drop < DropCopies.Length; drop++)
            {
                var differs = (await first.ReadAsync<bool>()).AsList();
                (dropped, anomalies) = (dropped + differs.Count, anomalies + differs.Count(d => d));
            }
            books = (await first.ReadAsync<BookMatch>()).AsList();
        }
        run.Bind(Pairs(books));

        // 2. Words, first (an example's word FK is immediate, its book FKs deferred), after listing the
        // appends of matched books (their hashed ids change) and locking both sides' reading states.
        List<(string Kind, Guid Id)> appends;
        List<(bool OfGuest, ReadingState State)> states;
        List<(Guid Guest, Guid Account)> words;
        List<VocabularyReview> reviews;
        await using (var second = await run.QueryMultipleAsync(LockStatesAndMergeWords))
        {
            appends = (await second.ReadAsync<(string, Guid)>()).AsList();
            states = second.Read<bool, ReadingState, (bool, ReadingState)>((ofGuest, state) => (ofGuest, state), splitOn: "book_id").AsList();
            words = (await second.ReadAsync<(Guid, Guid)>()).AsList();
            reviews = (await second.ReadAsync<VocabularyReview>()).AsList();
        }

        // 3a–d. Matched books: state, what points into the guest's file and book; then the insight clashes.
        List<string> released;
        List<InsightLoser> losers;
        List<(Guid InsightId, string Prompt, string Answer)> questions;
        await using (var third = await run.QueryMultipleAsync(MoveOntoAccountBooks, StateArgs(MergedStates(books, states))))
        {
            released = (await third.ReadAsync<string>()).AsList();
            (losers, questions) = ((await third.ReadAsync<InsightLoser>()).AsList(), (await third.ReadAsync<(Guid, string, string)>()).AsList());
        }

        // 3e–6. Insights, the emptied guest books, every other book, book-less sessions, feeds, share
        // links; then the rows step 7 rehashes, as they stand now.
        List<(VocabularyExample Example, VocabularyWord Card)> examples;
        List<SharedChapter> shares;
        List<DiscussionCheckpoint> checkpoints;
        var bumped = lockedBooks.Where(b => b.OfGuest).Select(b => b.Id).Except(books.Select(b => b.GuestBook)).Concat(books.Select(b => b.AccountBook));
        await using (var fourth = await run.QueryMultipleAsync(MoveBooksAndReadAppends, new
        {
            bumped = bumped.ToArray(),
            checkpoints = unlinked.Select(u => u.Checkpoint).ToArray(),
            shares = unlinked.Select(u => u.AccountShare).ToArray(),
            exampleIds = Of(appends, "example"),
            shareIds = Of(appends, "share"),
            checkpointIds = Of(appends, "checkpoint").Concat(unlinked.Select(u => u.Checkpoint)).Distinct().ToArray(),
        }, LoserArgs(losers, questions)))
        {
            examples = fourth.Read<VocabularyExample, VocabularyWord, (VocabularyExample, VocabularyWord)>((e, card) => (e, card), splitOn: "language").AsList();
            shares = (await fourth.ReadAsync<SharedChapter>()).AsList();
            checkpoints = (await fourth.ReadAsync<DiscussionCheckpoint>()).AsList();
        }

        // 7–9. Hashes, what no cascade reaches, the guest itself.
        await run.ExecuteAsync(RehashAndRetire, RehashArgs(examples, reviews, shares, checkpoints));
        await unit.CommitAsync(ct);
        return new(AccountMergeOutcome.Merged,
            books.ToDictionary(b => b.GuestBook, b => b.AccountBook), books.ToDictionary(b => b.GuestFile, b => b.AccountFile),
            words.ToDictionary(w => w.Guest, w => w.Account), dropped, anomalies, questions.Count, released);
    }

    // Users: FOR UPDATE, not FOR NO KEY UPDATE, so it conflicts with the FOR KEY SHARE every FK insert
    // takes (no new root row for either user). Books: a book's children key-share it. The subquery reads
    // current files before the guest books' locks are granted, so an account book matching only the
    // bytes of a guest replacement in flight is matched but not locked. Id order: no deadlock.
    private const string Lock = """
        SELECT id, is_guest FROM users WHERE id IN (@guestId, @accountId) ORDER BY id FOR UPDATE;
        SELECT b.id, b.user_id = @guestId FROM books b
        WHERE b.user_id = @guestId
           OR b.user_id = @accountId AND b.removed_at IS NULL AND b.id IN (
                SELECT af.book_id FROM book_files af
                JOIN book_files gf ON gf.user_id = @guestId AND gf.is_current AND gf.sha256 = af.sha256
                WHERE af.user_id = @accountId AND af.is_current)
        ORDER BY b.id FOR UPDATE
        """;

    // The caller signed the account in, so it is no guest, whatever its V2 row says (a guest promoted
    // in place whose promotion did not reach V2): the merge refuses a guest as its target otherwise.
    private const string ClearAccountGuestFlag = "UPDATE users SET is_guest = false WHERE id = @accountId AND is_guest";

    // Checkpoints whose share step 1 drops, with the account's share of the same operation: the FK's
    // SET NULL unlinks them now, RelinkToAccountShares points them at that share once all has moved.
    private const string SelectCheckpointsOfDroppedShares = """
        SELECT c.id, a.id FROM discussion_checkpoints c
        JOIN shared_chapters g ON g.user_id = c.user_id AND g.book_id = c.book_id AND g.id = c.shared_chapter_id
        JOIN shared_chapters a ON a.user_id = @accountId AND a.operation_id = g.operation_id
        WHERE c.user_id = @guestId
        """;

    // One device pushed the same outbox entry under both identities: the account's row stays. Each
    // returns whether the payloads differ, an anomaly logged, not an error (PDD). Checkpoints go before
    // shares, so a dropped checkpoint is not first unlinked by its dropped share. A session has no
    // payload hash: its client_session_id is the whole identity.
    private const string DropByOperationTail =
        "WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.operation_id = g.operation_id RETURNING g.payload_sha256 <> a.payload_sha256";
    private static readonly string[] DropCopies =
    [
        $"DELETE FROM discussion_checkpoints g USING discussion_checkpoints a {DropByOperationTail}",
        $"DELETE FROM shared_chapters g USING shared_chapters a {DropByOperationTail}",
        $"DELETE FROM vocabulary_examples g USING vocabulary_examples a {DropByOperationTail}",
        $"DELETE FROM vocabulary_reviews g USING vocabulary_reviews a {DropByOperationTail}",
        "DELETE FROM reading_sessions g USING reading_sessions a WHERE g.user_id = @guestId AND a.user_id = @accountId AND a.client_session_id = g.client_session_id RETURNING false",
    ];

    private static readonly string DropCopiesAndMatch = string.Join(";\n",
        [ClearAccountGuestFlag, SelectCheckpointsOfDroppedShares, .. DropCopies, MatchBooks]);

    // No cascade reaches the tables that point only at users. Agent runs move. Every credential dies
    // with the guest row (DeleteGuest), as legacy cascades them: sessions, reset codes, device logins,
    // OAuth requests, and OAuth grants and connect keys too, because one minted under a guest session
    // on a shared device would otherwise become a lasting credential to the account that signs in
    // there. llm_traces have no FK and keep the guest's id (ADR-031).
    private const string MoveAgentRuns = "UPDATE agent_run SET user_id = @accountId WHERE user_id = @guestId";

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

    // The round trips after the first two, each one command, its statements in step order.
    private static readonly string LockStatesAndMergeWords = string.Join(";\n",
        [SelectAppendsOnMatchedBooks, LockStates, ReviveFromGuestCards, BumpSurvivors, MoveExamplesToSurvivors, MoveReviewsToSurvivors,
         DeleteEmptiedGuestCards, MoveCards]);

    private static readonly string MoveOntoAccountBooks = string.Join(";\n",
        [UpsertAccountStates, DeleteGuestStates, RepointToAccountFiles, SelectReleasedKeys, DeleteSameBytesFiles, MoveOtherVersions, MoveLeftoversToAccountBooks,
         SelectInsightLosers, SelectQuestionsOfLosers]);

    private static readonly string MoveBooksAndReadAppends = string.Join(";\n",
        [InsertLoserCheckpoints, DeleteLosers, MoveInsightsToAccountBooks, DeleteMatchedGuestBooks, TouchAccountBooks, MoveUnmatchedBooks,
         MoveBooklessSessions, BumpFeeds, RelinkToAccountShares, SelectExamplesToRehash, SelectSharesToRehash, SelectCheckpointsToRehash]);

    private static readonly string RehashAndRetire = string.Join(";\n",
        [SetExampleHashes, SetReviewHashes, SetShareHashes, SetCheckpointHashes, MoveAgentRuns, FoldGuestIntoAccount, DeleteGuest]);

    /// <summary>Step 7: every moved append whose hashed ids changed, hashed as the API would hash it now.</summary>
    private static object RehashArgs(
        List<(VocabularyExample Example, VocabularyWord Card)> examples, List<VocabularyReview> reviews,
        List<SharedChapter> shares, List<DiscussionCheckpoint> checkpoints) => new
        {
            exampleIds = examples.Select(e => e.Example.Id).ToArray(),
            exampleHashes = examples.Select(e => VocabularyPayloads.ExampleSha256(e.Card, e.Example)).ToArray(),
            reviewIds = reviews.Select(r => r.Id).ToArray(),
            reviewHashes = reviews.Select(VocabularyPayloads.ReviewSha256).ToArray(),
            shareIds = shares.Select(s => s.Id).ToArray(),
            shareHashes = shares.Select(s => DiscussionPayloads.ShareSha256(s)).ToArray(),
            checkpointIds = checkpoints.Select(c => c.Id).ToArray(),
            checkpointHashes = checkpoints.Select(c => DiscussionPayloads.CheckpointSha256(c)).ToArray(),
        };

    /// <summary>
    /// One merge's transaction and its two users: every command gets both ids as <c>@guestId</c> and
    /// <c>@accountId</c>, the matched pairs once <see cref="Bind"/> has them, and its own arguments.
    /// </summary>
    private sealed class Run(V2Transaction unit, Guid guestId, Guid accountId, CancellationToken ct)
    {
        private readonly List<object> _bound = [new { guestId, accountId }];

        public void Bind(object args) => _bound.Add(args);

        public Task<int> ExecuteAsync(string sql, params object[] args) => unit.Connection.ExecuteAsync(Command(sql, args));

        public Task<SqlMapper.GridReader> QueryMultipleAsync(string sql, params object[] args) => unit.Connection.QueryMultipleAsync(Command(sql, args));

        private CommandDefinition Command(string sql, object[] args)
        {
            var parameters = new DynamicParameters();
            foreach (var template in _bound.Concat(args)) parameters.AddDynamicParams(template);
            return new CommandDefinition(sql, parameters, unit.Transaction, cancellationToken: ct);
        }
    }

    private const string HoldsNothingDurable = """
        SELECT NOT EXISTS (SELECT FROM books WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM annotations WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM vocabulary_words WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM reading_state WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM shared_chapters WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM discussion_checkpoints WHERE user_id = @userId)
           AND NOT EXISTS (SELECT FROM book_insight WHERE user_id = @userId)
        """;

    public async Task<bool> HoldsNothingDurableAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<bool>(new CommandDefinition(HoldsNothingDurable, new { userId }, cancellationToken: ct));
    }
}
