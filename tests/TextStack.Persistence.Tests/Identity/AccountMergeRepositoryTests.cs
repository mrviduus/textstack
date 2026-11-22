using System.Text.Json;
using Application.Discussion;
using Application.Vocabulary;
using Dapper;
using Domain.Discussion;
using Domain.Identity;
using Domain.Library;
using Domain.Reading;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// The guest→account merge (v2-sync-protocol.md "Guest → account merge", M2.5 plan §2). Each test runs
/// the merge in its own transaction and ends it with <c>SET CONSTRAINTS ALL IMMEDIATE</c> before the
/// commit (ADR-031 rule 9), so a deferred provenance FK the merge left dangling fails the test. The
/// everything story, the same-entry theory and the library story seed every table; the rest seed the
/// aggregate they are about. Feed cutoffs come from the database's clock, which stamps the rows.
/// </summary>
public class AccountMergeRepositoryTests(PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly AccountMergeRepository _repo = new(db.DataSource);

    /// <summary>The tables that die with the guest row: every credential (owner's security review, 2026-11-02).</summary>
    private static readonly string[] Dying =
        ["user_refresh_tokens", "password_reset_tokens", "device_authorizations", "oauth_authorization_requests", "oauth_grants", "mcp_access_keys"];

    private async Task<AccountMerge> MergeAsync(Guid guest, Guid account)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var tx = await conn.BeginTransactionAsync(Ct);
        var merged = await _repo.MergeAsync(guest, account, tx, Ct);
        await conn.ExecuteAsync(new CommandDefinition("SET CONSTRAINTS ALL IMMEDIATE", transaction: tx, cancellationToken: Ct));
        await tx.CommitAsync(Ct);
        return merged;
    }

    private async Task<(Guid Guest, Guid Account)> PairAsync() => (await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync());

    /// <summary>A guest and an account, each with one live book whose current file holds the same bytes.</summary>
    private async Task<(Guid Guest, Guid Account, Book Theirs, Book Ours)> SameBytesAsync()
    {
        var (guest, account) = await PairAsync();
        var theirs = await db.NewBookAsync(guest);
        return (guest, account, theirs, await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256));
    }

    private Task<T> ScalarAsync<T>(string sql, object args) => db.ScalarAsync<T>(sql, args);

    private async Task<List<T>> RowsAsync<T>(string sql, object args)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<T>(new CommandDefinition(sql, args, cancellationToken: Ct))).AsList();
    }

    private Task<List<DiscussionCheckpoint>> CheckpointsAsync(Guid userId) => RowsAsync<DiscussionCheckpoint>("""
        SELECT id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256
        FROM discussion_checkpoints WHERE user_id = @userId
        """, new { userId });


    private Task<List<(Guid Id, bool IsCurrent)>> FilesAsync(Guid userId, Guid bookId) =>
        RowsAsync<(Guid, bool)>("SELECT id, is_current FROM book_files WHERE user_id = @userId AND book_id = @bookId", new { userId, bookId });

    /// <summary>A cutoff a minute back on the database's clock (the host's may drift from a Docker VM's).</summary>
    private Task<DateTimeOffset> SinceAsync() => ScalarAsync<DateTimeOffset>("SELECT now() - interval '1 minute'", new { });

    private Task<long> TouchedSinceAsync(string table, Guid userId, DateTimeOffset since) =>
        ScalarAsync<long>($"SELECT count(*) FROM {table} WHERE user_id = @userId AND updated_at > @since", new { userId, since });

    // ===== Who is merged =====

    /// <summary>Who signs in as whom: the guest's side, then the target.</summary>
    public enum Target { Account, AccountStillFlaggedAGuest, TheGuestItself, Missing }

    public static TheoryData<bool, bool, Target, AccountMergeOutcome, long, long, long, bool?> WhoCases => new()
    {
        // guest exists, is a guest, target → outcome, guest's books, account's books, guest rows left, account's is_guest after
        // No guest row at all: "is a guest" has nothing to describe.
        { false, false, Target.Account, AccountMergeOutcome.NoGuest, 0, 0, 0, false },
        { true, false, Target.Account, AccountMergeOutcome.Refused, 1, 0, 1, false },
        { true, true, Target.TheGuestItself, AccountMergeOutcome.Refused, 1, 1, 1, true },
        { true, true, Target.Missing, AccountMergeOutcome.Refused, 1, 0, 1, null },
        // A guest promoted in place whose promotion did not reach V2: the caller signed it in as an account.
        { true, true, Target.AccountStillFlaggedAGuest, AccountMergeOutcome.Merged, 0, 1, 0, false },
    };

    [Theory, MemberData(nameof(WhoCases))]
    public async Task MergeAsync_WhoSignsInAsWhom_OnlyAGuestMergesIntoAnotherUserAndARefusalMovesNothing(
        bool guestExists, bool isGuest, Target target, AccountMergeOutcome outcome, long guestBooks, long accountBooks, long guestRows, bool? accountIsGuest)
    {
        var guest = guestExists ? await db.NewReaderAsync(isGuest) : Guid.NewGuid();
        if (guestExists) await db.NewBookAsync(guest);
        var account = target switch
        {
            Target.TheGuestItself => guest,
            Target.Missing => Guid.NewGuid(),
            Target.AccountStillFlaggedAGuest => await db.NewReaderAsync(isGuest: true),
            _ => await db.NewReaderAsync(),
        };

        Assert.Equal(outcome, (await MergeAsync(guest, account)).Outcome);
        Assert.Equal((guestBooks, accountBooks, guestRows, accountIsGuest), (
            await db.CountAsync("books", guest), await db.CountAsync("books", account),
            await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest }),
            await ScalarAsync<bool?>("SELECT is_guest FROM users WHERE id = @account", new { account })));
    }

    [Fact]
    public async Task MergeAsync_TwoAtOnce_OneMergesTheOtherFindsNoGuest()
    {
        var (guest, account) = await PairAsync();
        await db.NewBookAsync(guest);

        // Own transactions: the commit checks the deferred FKs.
        var outcomes = await Task.WhenAll(_repo.MergeAsync(guest, account, null, Ct), _repo.MergeAsync(guest, account, null, Ct));

        Assert.Equal([AccountMergeOutcome.Merged, AccountMergeOutcome.NoGuest], outcomes.Select(o => o.Outcome).Order());
        Assert.Equal(1L, await db.CountAsync("books", account));
    }

    // ===== Everything moves =====

    [Fact]
    public async Task MergeAsync_GuestHoldingEverythingTheAccountHasNot_EveryRowMovesOnceWithItsIdCredentialsDieAndTheGuestIsGone()
    {
        var (guest, account) = await PairAsync();
        var carol = await db.NewReaderAsync();
        var (book, _) = await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(carol);
        string[] fed = ["books", "reading_state", "annotations", "vocabulary_words"];
        // The seed's connect key is refused to a guest (#1120); one minted before that must die with it too.
        await db.ExecAsync("""
            INSERT INTO mcp_access_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (gen_random_uuid(), @guest, 'older', @hash, 'tsk_gu', now());
            UPDATE vocabulary_words SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE books SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE reading_state SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE annotations SET updated_at = now() - interval '1 day' WHERE user_id = @guest
            """, new { guest, hash = NewHash() });
        var since = await SinceAsync();
        var tables = await db.UserTablesAsync();
        const string Users = "SELECT u::text FROM users u WHERE id IN (@guest, @account) ORDER BY id";
        var users = await RowsAsync<string>(Users, new { guest, account });
        Assert.Equal(2, users.Count);

        // A merge its caller rolls back leaves both users as they were: the guest's row, the account's flags.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
        await using (var tx = await conn.BeginTransactionAsync(Ct))
        {
            Assert.Equal(AccountMergeOutcome.Merged, (await _repo.MergeAsync(guest, account, tx, Ct)).Outcome);
            await tx.RollbackAsync(Ct);
        }
        Assert.Equal(users, await RowsAsync<string>(Users, new { guest, account }));
        Assert.Equal((true, false), (await ScalarAsync<bool>("SELECT is_guest FROM users WHERE id = @guest", new { guest }),
            await ScalarAsync<bool>("SELECT is_guest FROM users WHERE id = @account", new { account })));
        foreach (var table in tables)
            Assert.Equal((table, Seeded(table), 0L), (table, await db.CountAsync(table, guest), await db.CountAsync(table, account)));
        foreach (var table in fed)
            Assert.Equal((table, 0L), (table, await TouchedSinceAsync(table, guest, since)));

        var merged = await MergeAsync(guest, account);

        Assert.Equal((AccountMergeOutcome.Merged, 0, 0, 0), (merged.Outcome, merged.Books.Count, merged.Words.Count, merged.DroppedDuplicates));
        foreach (var table in tables)
        {
            // The trace keeps the guest's id: no FK by design (ADR-031). Carol's rows are not touched.
            var (guestLeft, moved) = table == "llm_traces" ? (1L, 0L) : (0L, Dying.Contains(table) ? 0L : Seeded(table));
            Assert.Equal((table, guestLeft, moved, Seeded(table)),
                (table, await db.CountAsync(table, guest), await db.CountAsync(table, account), await db.CountAsync(table, carol)));
        }
        Assert.Equal(0L, await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest }));
        Assert.Equal(book.Id, await ScalarAsync<Guid>("SELECT id FROM books WHERE user_id = @account", new { account }));
        // The account's other devices pull by updated_at: every moved root is stamped now.
        foreach (var table in fed)
            Assert.Equal((table, 1L), (table, await TouchedSinceAsync(table, account, since)));
        // Run again (a retried sign-in): the guest is gone, nothing more happens.
        Assert.Equal(AccountMergeOutcome.NoGuest, (await MergeAsync(guest, account)).Outcome);
    }

    public static TheoryData<string, string, string, int> DuplicateCases => new()
    {
        // table, the key both sides hold, which of the user's rows, payload anomalies counted
        { "vocabulary_examples", "operation_id", "", 0 },
        { "vocabulary_reviews", "operation_id", "", 0 },
        { "shared_chapters", "operation_id", "", 1 },
        { "discussion_checkpoints", "operation_id", "", 1 },
        // A session has no payload hash: its client_session_id is the whole identity.
        { "reading_sessions", "client_session_id", "AND book_id IS NULL", 0 },
    };

    [Theory, MemberData(nameof(DuplicateCases))]
    public async Task MergeAsync_OneDevicePushedTheSameEntryAsBoth_AccountCopyKeptGuestCopyDroppedAnomalyCounted(string table, string key, string scope, int anomalies)
    {
        var (guest, account) = await PairAsync();
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        var kept = await ScalarAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account {scope}", new { account });
        await db.ExecAsync($"UPDATE {table} SET {key} = (SELECT {key} FROM {table} WHERE user_id = @account {scope}) WHERE user_id = @guest {scope}", new { guest, account });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((1, anomalies), (merged.DroppedDuplicates, merged.HashAnomalies));
        Assert.Equal(2 * Seeded(table) - 1, await db.CountAsync(table, account));
        Assert.Contains(kept, await RowsAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account {scope}", new { account }));
    }

    // ===== Library =====

    [Fact]
    public async Task MergeAsync_GuestBookTheAccountAlreadyHas_MergesIntoItsOldestCopyWithEverythingOnItAndTheBytesReleased()
    {
        var (guest, account) = await PairAsync();
        var (theirs, share) = await db.SeedEverythingAsync(guest);
        var oldVersion = theirs.CurrentFile!.Id;
        // The seed's annotation, example and share stay anchored in the old version; the guest reads on in the new one.
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        // Bytes on both guest versions (an old one as a pre-M2.6 row could hold), and an unmatched book's that must stay.
        var unmatched = await db.NewBookAsync(guest);
        await db.ExecAsync("UPDATE book_files SET server_storage_key = 'k-' || id WHERE user_id = @guest", new { guest });
        var ours = await db.NewBookAsync(account, sha256: current.Sha256);
        // Import refuses a second live book with the same bytes; a replacement can make one.
        var younger = await db.NewBookAsync(account);
        await db.ExecAsync("""
            UPDATE book_files SET sha256 = @sha WHERE user_id = @account AND book_id = @younger;
            UPDATE books SET updated_at = now() - interval '1 day' WHERE user_id IN (@guest, @account);
            UPDATE annotations SET updated_at = now() - interval '1 day' WHERE user_id = @guest
            """, new { sha = current.Sha256, account, younger = younger.Id, guest });
        var since = await SinceAsync();

        var merged = await MergeAsync(guest, account);

        Assert.Equal(KeyValuePair.Create(theirs.Id, ours.Id), Assert.Single(merged.Books));
        Assert.Equal(ours.CurrentFile!.Id, merged.Files[current.Id]);
        Assert.Equal(new[] { ours.Id, younger.Id, unmatched.Id }.Order(), (await RowsAsync<Guid>("SELECT id FROM books WHERE user_id = @account", new { account })).Order());
        foreach (var table in (string[])["annotations", "vocabulary_examples", "shared_chapters", "discussion_checkpoints", "book_insight", "reading_sessions"])
            Assert.Equal((table, 1L), (table, await db.CountAsync(table, account, ours.Id)));
        Assert.Equal([(ours.CurrentFile.Id, true), (oldVersion, false)], (await FilesAsync(account, ours.Id)).OrderByDescending(f => f.IsCurrent));
        // The feeds: the merged-into book, the moved one and the moved annotation are stamped now; the younger copy is not.
        Assert.Equal(new[] { ours.Id, unmatched.Id }.Order(),
            (await RowsAsync<Guid>("SELECT id FROM books WHERE user_id = @account AND updated_at > @since", new { account, since })).Order());
        Assert.Equal((ours.Id, oldVersion, true), Assert.Single(await RowsAsync<(Guid, Guid, bool)>(
            "SELECT book_id, file_id, updated_at > @since FROM annotations WHERE user_id = @account", new { account, since })));
        // Book ids are hashed: the moved appends carry the hash of what the seed wrote, under the account's book.
        var example = new VocabularyExample { Sentence = "A quiver of arrows.", BookId = ours.Id, FileId = oldVersion };
        Assert.Equal(VocabularyPayloads.ExampleSha256(NewWord(account), example),
            await ScalarAsync<string>("SELECT payload_sha256 FROM vocabulary_examples WHERE user_id = @account", new { account }));
        (share.BookId, share.FileId) = (ours.Id, oldVersion);
        Assert.Equal(DiscussionPayloads.ShareSha256(share),
            await ScalarAsync<string>("SELECT payload_sha256 FROM shared_chapters WHERE user_id = @account", new { account }));
        var checkpoint = Assert.Single(await CheckpointsAsync(account));
        Assert.Equal((share.Id, DiscussionPayloads.CheckpointSha256(checkpoint)), (checkpoint.SharedChapterId, checkpoint.PayloadSha256));
        // Both matched versions' bytes are released for the caller to delete; the unmatched book keeps its own.
        Assert.Equal(new[] { $"k-{oldVersion}", $"k-{current.Id}" }.Order(), merged.ReleasedKeys.Order());
        Assert.Null(await ScalarAsync<string?>("SELECT server_storage_key FROM book_files WHERE id = @oldVersion", new { oldVersion }));
        Assert.Equal($"k-{unmatched.CurrentFile!.Id}", await ScalarAsync<string>("SELECT server_storage_key FROM book_files WHERE id = @id", new { id = unmatched.CurrentFile.Id }));
    }

    /// <summary>What became of one side's copy of the same bytes before the merge.</summary>
    public enum NearMiss { GuestRemoved, AccountRemoved, GuestReplaced, AccountReplaced }

    [Theory]
    [InlineData(NearMiss.GuestRemoved)]
    [InlineData(NearMiss.AccountRemoved)]
    [InlineData(NearMiss.GuestReplaced)]
    [InlineData(NearMiss.AccountReplaced)]
    public async Task MergeAsync_SameBytesOnlyInARemovedBookOrAnOldVersion_NotMatchedBothBooksKept(NearMiss miss)
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var library = new LibraryRepository(db.DataSource);
        await (miss switch
        {
            NearMiss.GuestRemoved => (Task)library.RemoveAsync(guest, theirs.Id, Ct),
            NearMiss.AccountRemoved => library.RemoveAsync(account, ours.Id, Ct),
            NearMiss.GuestReplaced => db.ReplaceFileAsync(theirs),
            _ => db.ReplaceFileAsync(ours),
        });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_GuestAnnotationInFlightOnAMatchedBook_LandsOnTheAccountBook()
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var annotation = Guid.NewGuid();
        await using var writer = await db.DataSource.OpenConnectionAsync(Ct);
        await using var write = await writer.BeginTransactionAsync(Ct);
        await writer.ExecuteAsync(new CommandDefinition(
            "INSERT INTO annotations (id, user_id, book_id, selected_text) VALUES (@annotation, @guest, @book, 'racing')",
            new { annotation, guest, book = theirs.Id }, write, cancellationToken: Ct));

        var merge = MergeAsync(guest, account);
        await db.WaitUntilBlockedByAsync(writer, merge);
        await write.CommitAsync(Ct);

        Assert.Equal(AccountMergeOutcome.Merged, (await merge).Outcome);
        Assert.Equal(ours.Id, await ScalarAsync<Guid>("SELECT book_id FROM annotations WHERE user_id = @account AND id = @annotation", new { account, annotation }));
    }

    [Fact]
    public async Task MergeAsync_ReplacementInFlightOnAMatchedGuestBook_WaitsAndMovesTheBookWithoutACollision()
    {
        var (guest, account, theirs, _) = await SameBytesAsync();
        await using var writer = await db.DataSource.OpenConnectionAsync(Ct);
        await using var write = await writer.BeginTransactionAsync(Ct);
        var replaced = await new LibraryRepository(db.DataSource).ReplaceFileAsync(guest, theirs.Id, NewFile(guest, theirs.Id), theirs.CurrentFile!.Id, write, Ct);

        var merge = MergeAsync(guest, account);
        await db.WaitUntilBlockedByAsync(writer, merge);
        await write.CommitAsync(Ct);

        // The merge saw the replacement: the guest book's bytes changed, so it no longer matches and
        // moves with both its versions, the new one current.
        Assert.Empty((await merge).Books);
        Assert.Equal([(replaced.Current!.Id, true), (theirs.CurrentFile.Id, false)], (await FilesAsync(account, theirs.Id)).OrderByDescending(f => f.IsCurrent));
    }

    // ===== Vocabulary =====

    /// <summary>The user's card "quiver" (English) with one example and one answer; returns the card.</summary>
    private async Task<VocabularyWord> CardWithHistoryAsync(Guid userId)
    {
        var vocabulary = new VocabularyRepository(db.DataSource);
        var card = (await vocabulary.SaveWordAsync(userId, NewWord(userId, translation: "guest's"), Ct)).Word!;
        await vocabulary.AddExampleAsync(userId, NewExample(card, "A quiver of arrows."), Ct);
        await vocabulary.RecordReviewAsync(userId, new()
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            WordId = card.Id,
            OperationId = Guid.NewGuid(),
            PayloadSha256 = NewHash(),
            ReviewMode = "flashcard",
            IsCorrect = true,
            ClientRecordedAt = DateTimeOffset.UtcNow,
        }, c => new Application.Vocabulary.ReviewSchedule(c.Stage + 1, 1m, 0, Retire: false), Ct);
        return card;
    }

    [Theory]
    [InlineData(false, false, "account's", false)]
    [InlineData(true, false, "guest's", false)]
    [InlineData(false, true, "account's", false)]
    [InlineData(true, true, "account's", true)]
    public async Task MergeAsync_BothHoldTheWord_AccountCardSurvivesWithBothHistoriesRevisionPastBoth(
        bool accountTombstone, bool guestTombstone, string translation, bool deleted)
    {
        var (guest, account) = await PairAsync();
        var theirs = await CardWithHistoryAsync(guest);
        var vocabulary = new VocabularyRepository(db.DataSource);
        var ours = (await vocabulary.SaveWordAsync(account, NewWord(account, translation: "account's"), Ct)).Word!;
        // The same key in another language is another word.
        var german = NewWord(account);
        german.Language = "de";
        await vocabulary.SaveWordAsync(account, german, Ct);
        await db.ExecAsync("""
            UPDATE vocabulary_words SET revision = 5, deleted_at = CASE WHEN @guestTombstone THEN now() END WHERE user_id = @guest;
            UPDATE vocabulary_words SET revision = 2, deleted_at = CASE WHEN @accountTombstone THEN now() END WHERE user_id = @account AND id = @id
            """, new { guest, account, id = ours.Id, guestTombstone, accountTombstone });

        var merged = await MergeAsync(guest, account);

        Assert.Equal(KeyValuePair.Create(theirs.Id, ours.Id), Assert.Single(merged.Words));
        // Revived from the guest's live card, or the account's card as it was; a revision past both either way.
        Assert.Equal((6L, deleted, translation), Assert.Single(await RowsAsync<(long, bool, string?)>(
            "SELECT revision, deleted_at IS NOT NULL, translation FROM vocabulary_words WHERE user_id = @account AND id = @id", new { account, id = ours.Id })));
        Assert.Equal((2L, 1L, 1L), (await db.CountAsync("vocabulary_words", account), await db.CountAsync("vocabulary_examples", account), await db.CountAsync("vocabulary_reviews", account)));
        // A review hashes its card's id: rehashed under the survivor's.
        var review = Assert.Single(await RowsAsync<VocabularyReview>(
            "SELECT word_id, review_mode, is_correct, response_time_ms, client_recorded_at, payload_sha256 FROM vocabulary_reviews WHERE user_id = @account", new { account }));
        Assert.Equal((ours.Id, VocabularyPayloads.ReviewSha256(review)), (review.WordId, review.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_AccountReplaysAGuestOperationIdDuringTheMerge_FirstRunCollidesSecondMerges()
    {
        var (guest, account) = await PairAsync();
        await CardWithHistoryAsync(guest);
        var card = (await new VocabularyRepository(db.DataSource).SaveWordAsync(account, NewWord(account, "other"), Ct)).Word!;
        var op = await ScalarAsync<Guid>("SELECT operation_id FROM vocabulary_examples WHERE user_id = @guest", new { guest });
        await using var writer = await db.DataSource.OpenConnectionAsync(Ct);
        await using var write = await writer.BeginTransactionAsync(Ct);
        await writer.ExecuteAsync(new CommandDefinition("""
            INSERT INTO vocabulary_examples (id, user_id, word_id, sentence, operation_id, payload_sha256, created_at)
            VALUES (gen_random_uuid(), @account, @word, 'replayed', @op, @hash, now())
            """, new { account, word = card.Id, op, hash = NewHash() }, write, cancellationToken: Ct));

        var first = MergeAsync(guest, account);
        await db.WaitUntilBlockedByAsync(writer, first);
        await write.CommitAsync(Ct);

        // The snapshot collision a caller retries once.
        Assert.Equal("23505", (await Assert.ThrowsAsync<PostgresException>(() => first)).SqlState);
        var second = await MergeAsync(guest, account);
        Assert.Equal((AccountMergeOutcome.Merged, 1), (second.Outcome, second.DroppedDuplicates));
        Assert.Equal("replayed", await ScalarAsync<string>("SELECT sentence FROM vocabulary_examples WHERE user_id = @account AND operation_id = @op", new { account, op }));
    }

    // ===== Reading position =====

    private static ReadingState State(Guid fileId, decimal fraction, DateTimeOffset at) =>
        new() { FileId = fileId, CurrentLocator = TestJson.Cfi((int)(fraction * 100)), BookFraction = fraction, ClientRecordedAt = at };

    private Task<ReadingState?> StateAsync(Guid userId, Guid bookId) => new ReadingStateRepository(db.DataSource).GetAsync(userId, bookId, Ct);

    public static TheoryData<bool, bool, decimal, bool, decimal, decimal, long, long?> BothReadCases => new()
    {
        // guest newer, account reset, account went back to, guest completed → position, frontier, revision, reset revision
        { true, false, 0.2m, false, 0.3m, 0.8m, 3, null },
        // The reset cleared the account's frontier; the guest's 0.3 is the furthest left.
        { false, true, 0.2m, false, 0.2m, 0.3m, 4, 3 },
        // The frontier never falls below the winner's position.
        { false, true, 0.5m, false, 0.5m, 0.5m, 4, 3 },
        // Completion follows the winner, not the older side.
        { false, false, 0.2m, true, 0.2m, 0.8m, 3, null },
    };

    /// <summary>Matched books, each read: the guest's at 0.3, the account's at 0.8 then back to <c>accountBack</c>, maybe reset.</summary>
    [Theory, MemberData(nameof(BothReadCases))]
    public async Task MergeAsync_BothReadTheBook_NewerPositionWinsFrontierIsTheFurthestRevisionPastBoth(
        bool guestNewer, bool resetAccount, decimal accountBack, bool guestCompleted, decimal position, decimal frontier, long revision, long? resetRevision)
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var states = new ReadingStateRepository(db.DataSource);
        var now = DateTimeOffset.UtcNow.AddMinutes(-10);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile!.Id, 0.3m, guestNewer ? DateTimeOffset.UtcNow : DateTimeOffset.UtcNow.AddHours(-1)), null, default, Ct);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.8m, now), null, default, Ct);
        var back = await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile.Id, accountBack, now.AddMinutes(1)), 1, default, Ct);
        if (resetAccount) await states.ResetAsync(account, ours.Id, back.Current!.Revision, Ct);
        if (guestCompleted)
        {
            await db.ExecAsync("UPDATE reading_state SET completed_at = now() WHERE user_id = @guest", new { guest });
            Assert.NotNull((await StateAsync(guest, theirs.Id))!.CompletedAt);
        }

        await MergeAsync(guest, account);

        var state = (await StateAsync(account, ours.Id))!;
        Assert.Equal((position, frontier, revision, resetRevision, (DateTimeOffset?)null),
            (state.BookFraction, state.FrontierFraction, state.Revision, state.ResetRevision, state.CompletedAt));
    }

    [Fact]
    public async Task MergeAsync_PositionsAcrossFileVersions_OnlyAPositionInTheCurrentFileCounts()
    {
        var (guest, account) = await PairAsync();
        var states = new ReadingStateRepository(db.DataSource);

        // Only the guest read it: the position moves as it is, onto the account's file.
        var onlyGuest = await db.NewBookAsync(guest);
        var onlyGuestOurs = await db.NewBookAsync(account, sha256: onlyGuest.CurrentFile!.Sha256);
        await states.AdvanceAsync(guest, onlyGuest.Id, State(onlyGuest.CurrentFile.Id, 0.4m, DateTimeOffset.UtcNow), null, default, Ct);

        // The guest's position is in a version it replaced: its locators mean nothing in the account's file.
        var superseded = await db.NewBookAsync(guest);
        var old = superseded.CurrentFile!.Id;
        var current = (await db.ReplaceFileAsync(superseded)).Current!;
        await db.ExecAsync("""
            INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, client_recorded_at)
            VALUES (@guest, @book, @old, CAST(@loc AS jsonb), 0.3, now())
            """, new { guest, book = superseded.Id, old, loc = TestJson.Cfi(3) });
        Assert.NotNull(await StateAsync(guest, superseded.Id));
        var supersededOurs = await db.NewBookAsync(account, sha256: current.Sha256);

        // The account's position is on an old version (a stale device holds it): the guest's takes its place, a revision past it.
        var stale = await db.NewBookAsync(account);
        await states.AdvanceAsync(account, stale.Id, State(stale.CurrentFile!.Id, 0.9m, DateTimeOffset.UtcNow), null, default, Ct);
        await db.ExecAsync("UPDATE reading_state SET revision = 4 WHERE user_id = @account AND book_id = @book", new { account, book = stale.Id });
        // A replacement by the use case would delete the state; here it stays on the old version.
        var staleCurrent = (await db.ReplaceFileAsync(stale)).Current!;
        var staleTheirs = await db.NewBookAsync(guest, sha256: staleCurrent.Sha256);
        await states.AdvanceAsync(guest, staleTheirs.Id, State(staleTheirs.CurrentFile!.Id, 0.2m, DateTimeOffset.UtcNow.AddHours(-1)), null, default, Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal(3, merged.Books.Count);
        var moved = (await StateAsync(account, onlyGuestOurs.Id))!;
        Assert.Equal((onlyGuestOurs.CurrentFile!.Id, 0.4m, 1L), (moved.FileId, moved.BookFraction, moved.Revision));
        Assert.Null(await StateAsync(account, supersededOurs.Id));
        var replaced = (await StateAsync(account, stale.Id))!;
        Assert.Equal((staleCurrent.Id, 0.2m, 5L), (replaced.FileId, replaced.BookFraction, replaced.Revision));
        Assert.Equal(2L, await db.CountAsync("reading_state", account));
    }

    // ===== Discussion =====

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MergeAsync_InsightClashWithThreeQuestions_LoserKeptInFullAsACheckpoint(bool guestLoses)
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var insights = new BookInsightRepository(db.DataSource);
        var questions = new ReviewQuestionRepository(db.DataSource);
        var g = await insights.SaveReviewAsync(NewInsight(theirs, "ch-2", "guest text", reviewJson: """{"b":1,"a":[2]}"""), Ct);
        var a = await insights.SaveReviewAsync(NewInsight(ours, "ch-2", "account text", reviewJson: """{"z":true}"""), Ct);
        await db.ExecAsync("UPDATE book_insight SET updated_at = now() - interval '1 hour' WHERE id = @id", new { id = guestLoses ? g.Id : a.Id });
        var (loser, winner) = guestLoses ? (g, a) : (a, g);
        await questions.ReplaceForInsightAsync(loser.UserId, loser.Id,
            [.. Enumerable.Range(1, 3).Select(i => new ReviewQuestion { Id = Guid.NewGuid(), UserId = loser.UserId, BookInsightId = loser.Id, BlockIndex = i, Prompt = $"P{i}?", Answer = $"A{i}.", PromptHash = $"h{i}", NextReviewAt = DateTimeOffset.UtcNow })], Ct);
        await questions.ReplaceForInsightAsync(winner.UserId, winner.Id,
            [new ReviewQuestion { Id = Guid.NewGuid(), UserId = winner.UserId, BookInsightId = winner.Id, BlockIndex = 1, Prompt = "W?", Answer = "W.", PromptHash = "w1", NextReviewAt = DateTimeOffset.UtcNow }], Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((3, 1L), (merged.UnscheduledReviewQuestions, await db.CountAsync("review_question", account)));
        Assert.Equal(winner.Id, await ScalarAsync<Guid>("SELECT id FROM book_insight WHERE user_id = @account", new { account }));
        var kept = (await CheckpointsAsync(account)).Single(c => c.Id == loser.Id);
        string Items(string json) => string.Join(" | ", JsonSerializer.Deserialize<string?[]>(json)!);
        // The structured review as canonical JSON: members sorted, no whitespace.
        var canonicalReview = guestLoses ? """{"a":[2],"b":1}""" : """{"z":true}""";
        Assert.Equal(("q", canonicalReview, loser.Text, "P1? — A1. | P2? — A2. | P3? — A3."),
            (Items(kept.ReaderThoughts), Items(kept.AssistantSuggestions), Items(kept.Conclusions), Items(kept.OpenQuestions)));
        Assert.Equal(("q", "und", "ch-2", ours.Id, loser.Id, DiscussionPayloads.CheckpointSha256(kept)),
            (kept.Topic, kept.Language, kept.ChapterKey, kept.BookId, kept.OperationId, kept.PayloadSha256));
    }

    /// <summary>A share on <paramref name="book"/> and a checkpoint on it; the share's operation id is <paramref name="operationId"/> when given.</summary>
    private async Task<(SharedChapter Share, Guid Checkpoint)> SharedAsync(Book book, Guid? operationId = null)
    {
        var share = NewShare(book);
        share.OperationId = operationId ?? share.OperationId;
        await new SharedChapterRepository(db.DataSource).ShareAsync(share, Ct);
        var checkpoint = NewCheckpoint(book, share);
        await new CheckpointRepository(db.DataSource).AppendAsync(checkpoint, Ct);
        return (share, checkpoint.Id);
    }

    [Fact]
    public async Task MergeAsync_GuestShareTheAccountAlsoPushed_GuestCheckpointFollowsTheAccountsShareOnlyOnTheSameBook()
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var sameBook = NewShare(ours);
        await new SharedChapterRepository(db.DataSource).ShareAsync(sameBook, Ct);
        var (_, relinked) = await SharedAsync(theirs, sameBook.OperationId);
        var (otherBook, _) = await SharedAsync(await db.NewBookAsync(account));
        var (_, unlinked) = await SharedAsync(await db.NewBookAsync(guest), otherBook.OperationId);

        var merged = await MergeAsync(guest, account);

        Assert.Equal(2, merged.DroppedDuplicates);
        var checkpoints = await CheckpointsAsync(account);
        var r = checkpoints.Single(c => c.Id == relinked);
        Assert.Equal((sameBook.Id, DiscussionPayloads.CheckpointSha256(r)), (r.SharedChapterId, r.PayloadSha256));
        var u = checkpoints.Single(c => c.Id == unlinked);
        Assert.Equal(((Guid?)null, DiscussionPayloads.CheckpointSha256(u)), (u.SharedChapterId, u.PayloadSha256));
    }

    // ===== Identity =====

    [Theory]
    [InlineData(null, "uk", "uk")]
    [InlineData("", "uk", "uk")]
    [InlineData("de", "uk", "de")]
    public async Task MergeAsync_NativeLanguage_TheGuestsOnlyWhenTheAccountHasNone(string? accountLanguage, string guestLanguage, string expected)
    {
        var (guest, account) = await PairAsync();
        await db.ExecAsync("UPDATE users SET native_language = @guestLanguage WHERE id = @guest; UPDATE users SET native_language = @accountLanguage WHERE id = @account",
            new { guest, account, guestLanguage, accountLanguage });

        await MergeAsync(guest, account);

        Assert.Equal(expected, await ScalarAsync<string>("SELECT native_language FROM users WHERE id = @account", new { account }));
    }

    [Theory]
    [InlineData(false, false, false, true)]
    [InlineData(true, false, false, false)]
    [InlineData(false, true, false, false)]
    // Another guest's book does not count for this one.
    [InlineData(false, false, true, true)]
    public async Task HoldsNothingDurableAsync_WhatTheGuestHolds_OnlyItsOwnBookOrWordCounts(bool book, bool word, bool anothersBook, bool expected)
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        if (book) await db.NewBookAsync(guest);
        if (word) await new VocabularyRepository(db.DataSource).SaveWordAsync(guest, NewWord(guest), Ct);
        if (anothersBook) await db.NewBookAsync(await db.NewReaderAsync(isGuest: true));

        Assert.Equal(expected, await _repo.HoldsNothingDurableAsync(guest, Ct));
    }
}
