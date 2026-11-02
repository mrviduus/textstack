using Domain.Reading;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// The merge's library and reading: step 3 (a guest book whose current file holds the same bytes as
/// a live account book's merges into it), 4 (every other book moves with its id), 5 and 6.
/// </summary>
public sealed partial class AccountMergeRepository
{
    /// <summary>A guest book merged into an account book, and the guest's current file into the account's (same sha256).</summary>
    private sealed class BookMatch
    {
        public Guid GuestBook { get; init; }
        public Guid GuestFile { get; init; }
        public Guid AccountBook { get; init; }
        public Guid AccountFile { get; init; }
    }

    // Live books on both sides, one to one: a guest book takes the account's oldest book with its
    // bytes (LibraryRepository.FindBySha256Async's rule). ponytail: a second guest book with the same
    // bytes moves as a book of its own rather than merging twice into one.
    private const string MatchBooks = """
        WITH candidate AS (
            SELECT DISTINCT ON (gb.id) gb.id AS guest_book, gf.id AS guest_file, ab.id AS account_book, af.id AS account_file, gb.created_at
            FROM books gb
            JOIN book_files gf ON gf.user_id = gb.user_id AND gf.book_id = gb.id AND gf.is_current
            JOIN book_files af ON af.user_id = @accountId AND af.is_current AND af.sha256 = gf.sha256
            JOIN books ab ON ab.user_id = af.user_id AND ab.id = af.book_id AND ab.removed_at IS NULL
            WHERE gb.user_id = @guestId AND gb.removed_at IS NULL
            ORDER BY gb.id, ab.created_at, ab.id)
        SELECT DISTINCT ON (account_book) guest_book, guest_file, account_book, account_file
        FROM candidate
        ORDER BY account_book, created_at, guest_book
        """;

    private static Task<List<BookMatch>> MatchBooksAsync(Run run) => run.QueryAsync<BookMatch>(MatchBooks);

    // A replacement of the account's book must not change its current file under the merge.
    // ponytail: locked after the match, so a replacement that commits in between is missed (the
    // merge then repoints onto a now non-current file, still valid); lock before matching if it shows.
    private const string LockAccountBooks = "SELECT id FROM books WHERE user_id = @accountId AND id = ANY(@accountBooks) ORDER BY id FOR UPDATE";

    private static async Task LockAccountBooksAsync(Run run, List<BookMatch> books)
    {
        if (books.Count > 0) await run.ExecuteAsync(LockAccountBooks, Pairs(books));
    }

    private static object Pairs(List<BookMatch> books) => new
    {
        guestBooks = books.Select(b => b.GuestBook).ToArray(),
        guestFiles = books.Select(b => b.GuestFile).ToArray(),
        accountBooks = books.Select(b => b.AccountBook).ToArray(),
        accountFiles = books.Select(b => b.AccountFile).ToArray(),
    };

    // The appends on a matched guest book change book (and maybe file) id, both hashed: listed now,
    // rehashed in step 7. The guest's own rows only, the account's keep their hashes.
    private const string SelectAppendsOnMatchedBooks = """
        SELECT 'example', id FROM vocabulary_examples WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        UNION ALL SELECT 'share', id FROM shared_chapters WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        UNION ALL SELECT 'checkpoint', id FROM discussion_checkpoints WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        """;

    private static async Task<(List<Guid> Examples, List<Guid> Shares, List<Guid> Checkpoints)> AppendsOnMatchedBooksAsync(Run run, List<BookMatch> books)
    {
        var rows = books.Count == 0 ? [] : await run.QueryAsync<(string Kind, Guid Id)>(SelectAppendsOnMatchedBooks, Pairs(books));
        List<Guid> Of(string kind) => rows.Where(r => r.Kind == kind).Select(r => r.Id).ToList();
        return (Of("example"), Of("share"), Of("checkpoint"));
    }

    private const string StateColumns =
        "book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision, reset_revision";

    // Locked: a device of the account must not advance a state this merge is about to overwrite.
    private const string LockStates = $"SELECT {StateColumns} FROM reading_state WHERE user_id = @userId AND book_id = ANY(@bookIds) FOR UPDATE";

    // A state's locators mean something only in the file they were taken in, and the two current files
    // hold the same bytes: the guest's state counts only on its current file, the account's likewise.
    // One statement for every matched book.
    private const string UpsertAccountStates = """
        INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision, reset_revision)
        SELECT @accountId, m.book_id, m.file_id, CAST(m.current_locator AS jsonb), m.book_fraction, CAST(m.frontier_locator AS jsonb),
               m.frontier_fraction, m.completed_at, m.client_recorded_at, now(), m.revision, m.reset_revision
        FROM unnest(@bookIds, @fileIds, @currentLocators, @bookFractions, @frontierLocators, @frontierFractions, @completedAts, @clientRecordedAts, @revisions, @resetRevisions)
            AS m(book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, revision, reset_revision)
        ON CONFLICT (user_id, book_id) DO UPDATE SET
            file_id = EXCLUDED.file_id, current_locator = EXCLUDED.current_locator, book_fraction = EXCLUDED.book_fraction,
            frontier_locator = EXCLUDED.frontier_locator, frontier_fraction = EXCLUDED.frontier_fraction,
            completed_at = EXCLUDED.completed_at, client_recorded_at = EXCLUDED.client_recorded_at,
            updated_at = now(), revision = EXCLUDED.revision, reset_revision = EXCLUDED.reset_revision
        """;

    // Merged or not (a state left on an old version loses), the guest's row must go before its files
    // move, or the cascade lands it on the account's key.
    private const string DeleteGuestStates = "DELETE FROM reading_state WHERE user_id = @guestId AND book_id = ANY(@guestBooks)";

    /// <summary>
    /// Step 3a: the guest's state of a matched book lands on the account's book, merged with the
    /// account's when that one is on its current file. An account state on an old version is
    /// overwritten by the guest's; with no guest state, the account's stays as it is.
    /// </summary>
    private static async Task MergeReadingStatesAsync(Run run, List<BookMatch> books)
    {
        if (books.Count == 0) return;
        var guest = (await run.QueryAsync<ReadingState>(LockStates, new { userId = run.GuestId, bookIds = books.Select(b => b.GuestBook).ToArray() }))
            .ToDictionary(s => s.BookId);
        var account = (await run.QueryAsync<ReadingState>(LockStates, new { userId = run.AccountId, bookIds = books.Select(b => b.AccountBook).ToArray() }))
            .ToDictionary(s => s.BookId);
        var merged = new List<ReadingState>();
        foreach (var book in books)
        {
            if (!guest.TryGetValue(book.GuestBook, out var theirs) || theirs.FileId != book.GuestFile) continue;
            var state = account.GetValueOrDefault(book.AccountBook) switch
            {
                null => theirs,
                { } ours when ours.FileId == book.AccountFile => MergeStates(theirs, ours),
                // A stale device of the account holds this row's revision: the overwrite passes it.
                { } stale => Overwrite(theirs, Math.Max(theirs.Revision, stale.Revision) + 1),
            };
            (state.BookId, state.FileId) = (book.AccountBook, book.AccountFile);
            merged.Add(state);
        }
        if (merged.Count > 0)
            await run.ExecuteAsync(UpsertAccountStates, new
            {
                bookIds = merged.Select(s => s.BookId).ToArray(),
                fileIds = merged.Select(s => s.FileId).ToArray(),
                currentLocators = merged.Select(s => s.CurrentLocator).ToArray(),
                bookFractions = merged.Select(s => s.BookFraction).ToArray(),
                frontierLocators = merged.Select(s => s.FrontierLocator).ToArray(),
                frontierFractions = merged.Select(s => s.FrontierFraction).ToArray(),
                // Arrays skip Dapper's UTC handler, and Npgsql writes timestamptz only from offset 0.
                completedAts = merged.Select(s => s.CompletedAt?.ToUniversalTime()).ToArray(),
                clientRecordedAts = merged.Select(s => s.ClientRecordedAt.ToUniversalTime()).ToArray(),
                revisions = merged.Select(s => s.Revision).ToArray(),
                resetRevisions = merged.Select(s => s.ResetRevision).ToArray(),
            });
        await run.ExecuteAsync(DeleteGuestStates, Pairs(books));
    }

    private static ReadingState Overwrite(ReadingState theirs, long revision)
    {
        theirs.Revision = revision;
        return theirs;
    }

    /// <summary>
    /// The PDD's reading-state rule: the newer <c>clientRecordedAt</c> wins (a tie: the account's);
    /// the frontier is the furthest of both frontiers and the winner's position, so it never trails
    /// it; <c>completed_at</c> is the winner's as it is (null too: no COALESCE); the account's reset
    /// is kept; the revision passes both.
    /// </summary>
    private static ReadingState MergeStates(ReadingState guest, ReadingState account)
    {
        var winner = guest.ClientRecordedAt > account.ClientRecordedAt ? guest : account;
        var frontier = new[]
            {
                (Locator: account.FrontierLocator, Fraction: account.FrontierFraction),
                (Locator: guest.FrontierLocator, Fraction: guest.FrontierFraction),
                (Locator: (string?)winner.CurrentLocator, Fraction: (decimal?)winner.BookFraction),
            }
            .Where(f => f.Fraction is not null).MaxBy(f => f.Fraction);
        return new ReadingState
        {
            CurrentLocator = winner.CurrentLocator,
            BookFraction = winner.BookFraction,
            FrontierLocator = frontier.Locator,
            FrontierFraction = frontier.Fraction,
            CompletedAt = winner.CompletedAt,
            ClientRecordedAt = winner.ClientRecordedAt,
            Revision = Math.Max(guest.Revision, account.Revision) + 1,
            ResetRevision = account.ResetRevision,
        };
    }

    // 3b. What points into the guest's same-bytes file now points into the account's. IN both users:
    // step 2 already moved some examples to the account, still naming the guest's book and file.
    private const string RepointToAccountFiles = """
        UPDATE annotations t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file
        FROM unnest(@guestFiles, @accountBooks, @accountFiles) AS m(guest_file, account_book, account_file)
        WHERE t.user_id IN (@guestId, @accountId) AND t.file_id = m.guest_file;
        UPDATE vocabulary_examples t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file
        FROM unnest(@guestFiles, @accountBooks, @accountFiles) AS m(guest_file, account_book, account_file)
        WHERE t.user_id IN (@guestId, @accountId) AND t.file_id = m.guest_file;
        UPDATE shared_chapters t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file
        FROM unnest(@guestFiles, @accountBooks, @accountFiles) AS m(guest_file, account_book, account_file)
        WHERE t.user_id IN (@guestId, @accountId) AND t.file_id = m.guest_file;
        UPDATE discussion_checkpoints t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file
        FROM unnest(@guestFiles, @accountBooks, @accountFiles) AS m(guest_file, account_book, account_file)
        WHERE t.user_id IN (@guestId, @accountId) AND t.file_id = m.guest_file
        """;

    // Its chapters and jobs go with it; the account's file has its own.
    private const string DeleteSameBytesFiles = "DELETE FROM book_files WHERE user_id = @guestId AND id = ANY(@guestFiles)";

    // 3c. The guest book's other versions become non-current versions of the account's book,
    // provenance for what is anchored in them; the cascade carries it. is_current is set, not assumed:
    // the account's book has its own current file.
    private const string MoveOtherVersions = """
        UPDATE book_files f SET user_id = @accountId, book_id = m.account_book, is_current = false
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE f.user_id = @guestId AND f.book_id = m.guest_book
        """;

    // 3d. What still names the guest book: rows with no file, and examples step 2 moved.
    private const string MoveLeftoversToAccountBooks = """
        UPDATE annotations t SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book;
        UPDATE vocabulary_examples t SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book;
        UPDATE shared_chapters t SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book;
        UPDATE discussion_checkpoints t SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book;
        UPDATE reading_sessions t SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book
        """;

    /// <summary>Steps 3b–3d.</summary>
    private static async Task MoveOntoAccountBooksAsync(Run run, List<BookMatch> books)
    {
        if (books.Count == 0) return;
        var pairs = Pairs(books);
        await run.ExecuteAsync(RepointToAccountFiles, pairs);
        await run.ExecuteAsync(DeleteSameBytesFiles, pairs);
        await run.ExecuteAsync(MoveOtherVersions, pairs);
        await run.ExecuteAsync(MoveLeftoversToAccountBooks, pairs);
    }

    // 3f. Emptied by now (insights moved in 3e), so the cascade deletes nothing.
    private const string DeleteMatchedGuestBooks = "DELETE FROM books WHERE user_id = @guestId AND id = ANY(@guestBooks)";
    private const string TouchAccountBooks = "UPDATE books SET updated_at = now() WHERE user_id = @accountId AND id = ANY(@accountBooks)";

    // 4. Ids kept (decision 12); files, state, annotations, sessions, appends, insights, chapters and jobs follow.
    private const string MoveUnmatchedBooks = "UPDATE books SET user_id = @accountId, updated_at = now() WHERE user_id = @guestId RETURNING id";

    // 5. A session of a deleted book has no (user_id, book_id) for the cascade to follow.
    private const string MoveBooklessSessions = "UPDATE reading_sessions SET user_id = @accountId WHERE user_id = @guestId AND book_id IS NULL";

    // 6. The cascade does not touch updated_at, and the account's other devices pull by it. Bumps the
    // account's own rows of a matched book too: extra feed entries, nothing wrong.
    private const string BumpFeeds = """
        UPDATE reading_state SET updated_at = now() WHERE user_id = @accountId AND book_id = ANY(@bookIds);
        UPDATE annotations SET updated_at = now() WHERE user_id = @accountId AND book_id = ANY(@bookIds)
        """;

    /// <summary>Steps 3f, 4, 5, 6.</summary>
    private static async Task MoveBooksAsync(Run run, List<BookMatch> books)
    {
        var pairs = Pairs(books);
        await run.ExecuteAsync(DeleteMatchedGuestBooks, pairs);
        await run.ExecuteAsync(TouchAccountBooks, pairs);
        var moved = await run.QueryAsync<Guid>(MoveUnmatchedBooks);
        await run.ExecuteAsync(MoveBooklessSessions);
        await run.ExecuteAsync(BumpFeeds, new { bookIds = moved.Concat(books.Select(b => b.AccountBook)).ToArray() });
    }
}
