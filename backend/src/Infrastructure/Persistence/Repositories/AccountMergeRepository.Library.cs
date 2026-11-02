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

    /// <summary>The matches as the four parallel arrays every later step's <c>unnest</c> reads.</summary>
    private static object Pairs(List<BookMatch> books) => new
    {
        guestBooks = books.Select(b => b.GuestBook).ToArray(),
        guestFiles = books.Select(b => b.GuestFile).ToArray(),
        accountBooks = books.Select(b => b.AccountBook).ToArray(),
        accountFiles = books.Select(b => b.AccountFile).ToArray(),
    };

    // The appends on a matched guest book change book (and maybe file) id, both hashed: listed before
    // anything moves, rehashed in step 7. The guest's own rows only, the account's keep their hashes.
    private const string SelectAppendsOnMatchedBooks = """
        SELECT 'example', id FROM vocabulary_examples WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        UNION ALL SELECT 'share', id FROM shared_chapters WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        UNION ALL SELECT 'checkpoint', id FROM discussion_checkpoints WHERE user_id = @guestId AND book_id = ANY(@guestBooks)
        """;

    private static Guid[] Of(List<(string Kind, Guid Id)> appends, string kind) => appends.Where(a => a.Kind == kind).Select(a => a.Id).ToArray();

    // Locked: a device of either user must not advance a state this merge is about to overwrite.
    private const string LockStates = $"""
        SELECT user_id = @guestId, {ReadingStateRepository.Columns} FROM reading_state
        WHERE (user_id = @guestId AND book_id = ANY(@guestBooks)) OR (user_id = @accountId AND book_id = ANY(@accountBooks))
        FOR UPDATE
        """;

    /// <summary>
    /// Step 3a: the guest's state of a matched book lands on the account's book. A state counts only on
    /// its book's current file (its locators mean nothing in another): the guest's on another is
    /// dropped, the account's on another is overwritten with a revision past it (a stale device holds
    /// that one). With no guest state the account's stays as it is.
    /// </summary>
    private static List<ReadingState> MergedStates(List<BookMatch> books, List<(bool OfGuest, ReadingState State)> states)
    {
        var guest = states.Where(s => s.OfGuest).ToDictionary(s => s.State.BookId, s => s.State);
        var account = states.Where(s => !s.OfGuest).ToDictionary(s => s.State.BookId, s => s.State);
        var merged = new List<ReadingState>();
        foreach (var book in books)
        {
            if (!guest.TryGetValue(book.GuestBook, out var theirs) || theirs.FileId != book.GuestFile) continue;
            var state = account.GetValueOrDefault(book.AccountBook) switch
            {
                null => theirs,
                { } ours when ours.FileId == book.AccountFile => ReadingState.Merge(theirs, ours),
                { } stale => Overwrite(theirs, Math.Max(theirs.Revision, stale.Revision) + 1),
            };
            (state.BookId, state.FileId) = (book.AccountBook, book.AccountFile);
            merged.Add(state);
        }
        return merged;
    }

    private static ReadingState Overwrite(ReadingState theirs, long revision)
    {
        theirs.Revision = revision;
        return theirs;
    }

    private static object StateArgs(List<ReadingState> merged) => new
    {
        stateBooks = merged.Select(s => s.BookId).ToArray(),
        stateFiles = merged.Select(s => s.FileId).ToArray(),
        currentLocators = merged.Select(s => s.CurrentLocator).ToArray(),
        bookFractions = merged.Select(s => s.BookFraction).ToArray(),
        frontierLocators = merged.Select(s => s.FrontierLocator).ToArray(),
        frontierFractions = merged.Select(s => s.FrontierFraction).ToArray(),
        // Arrays skip Dapper's UTC handler, and Npgsql writes timestamptz only from offset 0.
        completedAts = merged.Select(s => s.CompletedAt?.ToUniversalTime()).ToArray(),
        clientRecordedAts = merged.Select(s => s.ClientRecordedAt.ToUniversalTime()).ToArray(),
        revisions = merged.Select(s => s.Revision).ToArray(),
        resetRevisions = merged.Select(s => s.ResetRevision).ToArray(),
    };

    private const string UpsertAccountStates = """
        INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, updated_at, revision, reset_revision)
        SELECT @accountId, m.book_id, m.file_id, CAST(m.current_locator AS jsonb), m.book_fraction, CAST(m.frontier_locator AS jsonb),
               m.frontier_fraction, m.completed_at, m.client_recorded_at, clock_timestamp(), m.revision, m.reset_revision
        FROM unnest(@stateBooks, @stateFiles, @currentLocators, @bookFractions, @frontierLocators, @frontierFractions, @completedAts, @clientRecordedAts, @revisions, @resetRevisions)
            AS m(book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction, completed_at, client_recorded_at, revision, reset_revision)
        ON CONFLICT (user_id, book_id) DO UPDATE SET
            file_id = EXCLUDED.file_id, current_locator = EXCLUDED.current_locator, book_fraction = EXCLUDED.book_fraction,
            frontier_locator = EXCLUDED.frontier_locator, frontier_fraction = EXCLUDED.frontier_fraction,
            completed_at = EXCLUDED.completed_at, client_recorded_at = EXCLUDED.client_recorded_at,
            updated_at = clock_timestamp(), revision = EXCLUDED.revision, reset_revision = EXCLUDED.reset_revision
        """;

    // Merged or not, the guest's row must go before its files move, or the cascade lands it on the account's key.
    private const string DeleteGuestStates = "DELETE FROM reading_state WHERE user_id = @guestId AND book_id = ANY(@guestBooks)";

    // 3b. What points into the guest's same-bytes file now points into the account's. Both users: step
    // 2 already moved some examples to the account, still naming the guest's book and file. Checkpoints
    // before shares: a share's move cascades into its checkpoints' book, which this filter keys on.
    private const string RepointTail = """
        FROM unnest(@guestBooks, @guestFiles, @accountBooks, @accountFiles) AS m(guest_book, guest_file, account_book, account_file)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book AND t.file_id = m.guest_file
        """;
    private const string RepointToAccountFiles = $"""
        UPDATE annotations t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file {RepointTail};
        UPDATE vocabulary_examples t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file {RepointTail};
        UPDATE discussion_checkpoints t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file {RepointTail};
        UPDATE shared_chapters t SET user_id = @accountId, book_id = m.account_book, file_id = m.account_file {RepointTail}
        """;

    // The matched guest books' files all stop being anyone's stored current file: the same-bytes one is
    // deleted below, the others become superseded versions. Their bytes are released as a replacement
    // releases them, for the caller to delete after the commit.
    private const string SelectReleasedKeys = """
        SELECT server_storage_key FROM book_files
        WHERE user_id = @guestId AND book_id = ANY(@guestBooks) AND server_storage_key IS NOT NULL
        """;

    // Its chapters and jobs go with it; the account's file has its own.
    private const string DeleteSameBytesFiles = "DELETE FROM book_files WHERE user_id = @guestId AND id = ANY(@guestFiles)";

    // 3c. The guest book's other versions become non-current versions of the account's book,
    // provenance for what is anchored in them; the cascade carries it. is_current is set, not assumed:
    // the account's book has its own current file.
    private const string MoveOtherVersions = """
        UPDATE book_files f SET user_id = @accountId, book_id = m.account_book, is_current = false, server_storage_key = NULL
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE f.user_id = @guestId AND f.book_id = m.guest_book
        """;

    // 3d. What still names the guest book: rows with no file, and examples step 2 moved. Insights too, in 3e.
    private const string LeftoverTail = """
        SET user_id = @accountId, book_id = m.account_book
        FROM unnest(@guestBooks, @accountBooks) AS m(guest_book, account_book)
        WHERE t.user_id IN (@guestId, @accountId) AND t.book_id = m.guest_book
        """;
    private const string MoveLeftoversToAccountBooks = $"""
        UPDATE annotations t {LeftoverTail};
        UPDATE vocabulary_examples t {LeftoverTail};
        UPDATE shared_chapters t {LeftoverTail};
        UPDATE discussion_checkpoints t {LeftoverTail};
        UPDATE reading_sessions t {LeftoverTail}
        """;

    // 3f. Emptied by now, so the cascade deletes nothing.
    private const string DeleteMatchedGuestBooks = "DELETE FROM books WHERE user_id = @guestId AND id = ANY(@guestBooks)";

    // 6, and the moved books of 4. The cascade does not touch updated_at, and the account's other
    // devices pull by it. clock_timestamp(), not now() (the transaction's start): a row stamped when it
    // moved cannot fall behind a cursor that passed an account write committed during the merge.
    // Bumps the account's own rows of a matched book too: extra feed entries, nothing wrong.
    private const string TouchAccountBooks = "UPDATE books SET updated_at = clock_timestamp() WHERE user_id = @accountId AND id = ANY(@accountBooks)";

    // 4. Ids kept (decision 12); files, state, annotations, sessions, appends, insights, chapters and jobs follow.
    private const string MoveUnmatchedBooks = "UPDATE books SET user_id = @accountId, updated_at = clock_timestamp() WHERE user_id = @guestId";

    // 5. A session of a deleted book has no (user_id, book_id) for the cascade to follow.
    private const string MoveBooklessSessions = "UPDATE reading_sessions SET user_id = @accountId WHERE user_id = @guestId AND book_id IS NULL";

    private const string BumpFeeds = """
        UPDATE reading_state SET updated_at = clock_timestamp() WHERE user_id = @accountId AND book_id = ANY(@bumped);
        UPDATE annotations SET updated_at = clock_timestamp() WHERE user_id = @accountId AND book_id = ANY(@bumped)
        """;
}
