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
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// The guest→account merge (v2-sync-protocol.md "Guest → account merge", M2.5 plan §2). Each test runs
/// the merge in its own transaction and ends it with <c>SET CONSTRAINTS ALL IMMEDIATE</c> before the
/// commit (ADR-031 rule 9), so a deferred provenance FK the merge left dangling fails the test. Only
/// the "every table" tests seed everything; the rest seed the aggregate they are about.
/// </summary>
public class AccountMergeRepositoryTests(V2PostgresFixture db)
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

    private Task<List<(Guid Id, bool IsCurrent)>> FilesAsync(Guid userId) =>
        RowsAsync<(Guid, bool)>("SELECT id, is_current FROM book_files WHERE user_id = @userId", new { userId });

    // ===== Outcomes =====

    [Fact]
    public async Task MergeAsync_GuestAbsent_NoGuest()
    {
        Assert.Equal(AccountMergeOutcome.NoGuest, (await MergeAsync(Guid.NewGuid(), await db.NewReaderAsync())).Outcome);
    }

    public static TheoryData<string> RefusedCases => ["NotGuest", "SameId", "NoAccount"];

    [Theory, MemberData(nameof(RefusedCases))]
    public async Task MergeAsync_NotAGuestIntoAnAccount_RefusedAndNothingMoves(string refused)
    {
        var guest = await db.NewReaderAsync(isGuest: refused != "NotGuest");
        var account = refused switch { "SameId" => guest, "NoAccount" => Guid.NewGuid(), _ => await db.NewReaderAsync() };
        await db.NewBookAsync(guest);

        Assert.Equal(AccountMergeOutcome.Refused, (await MergeAsync(guest, account)).Outcome);
        Assert.Equal((1L, 1L), (await db.CountAsync("books", guest), await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest })));
    }

    [Fact]
    public async Task MergeAsync_AccountStillFlaggedAGuest_MergedAndTheFlagCleared()
    {
        // A guest promoted in place whose promotion did not reach V2: the caller signed it in as an account.
        var (guest, account) = (await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync(isGuest: true));
        await db.NewBookAsync(guest);

        Assert.Equal(AccountMergeOutcome.Merged, (await MergeAsync(guest, account)).Outcome);
        Assert.Equal((false, 1L), (await ScalarAsync<bool>("SELECT is_guest FROM users WHERE id = @account", new { account }), await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_RunTwice_SecondIsNoGuest()
    {
        var (guest, account) = await PairAsync();
        await db.NewBookAsync(guest);

        await MergeAsync(guest, account);

        Assert.Equal(AccountMergeOutcome.NoGuest, (await MergeAsync(guest, account)).Outcome);
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

    // ===== Every table =====

    [Fact]
    public async Task MergeAsync_NothingMatches_EveryRowMovesWithItsIdCredentialsDieTheGuestIsGone()
    {
        var (guest, account) = await PairAsync();
        var carol = await db.NewReaderAsync();
        var (book, _) = await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(carol);
        await db.ExecAsync("UPDATE vocabulary_words SET word_key = 'other' WHERE user_id = @guest", new { guest });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((AccountMergeOutcome.Merged, 0, 0, 0), (merged.Outcome, merged.Books.Count, merged.Words.Count, merged.DroppedDuplicates));
        foreach (var table in await db.UserTablesAsync())
        {
            // The trace keeps the guest's id: no FK by design (ADR-031).
            var (guestLeft, moved) = table == "llm_traces" ? (1L, 0L) : (0L, Dying.Contains(table) ? 0L : Seeded(table));
            Assert.Equal((table, guestLeft, moved, Seeded(table)),
                (table, await db.CountAsync(table, guest), await db.CountAsync(table, account), await db.CountAsync(table, carol)));
        }
        Assert.Equal(0L, await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest }));
        Assert.Equal(book.Id, await ScalarAsync<Guid>("SELECT id FROM books WHERE user_id = @account", new { account }));
    }

    [Theory]
    [InlineData("vocabulary_examples", 0)]
    [InlineData("vocabulary_reviews", 0)]
    [InlineData("shared_chapters", 1)]
    [InlineData("discussion_checkpoints", 1)]
    public async Task MergeAsync_OperationIdBothHold_GuestCopyDroppedAccountKeptAnomalyCounted(string table, int anomalies)
    {
        var (guest, account) = await PairAsync();
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        var kept = await ScalarAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account", new { account });
        await db.ExecAsync($"UPDATE {table} SET operation_id = (SELECT operation_id FROM {table} WHERE user_id = @account) WHERE user_id = @guest", new { guest, account });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((1, anomalies), (merged.DroppedDuplicates, merged.HashAnomalies));
        Assert.Equal(kept, await ScalarAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account", new { account }));
    }

    [Fact]
    public async Task MergeAsync_ClientSessionIdBothHold_GuestCopyDropped()
    {
        var (guest, account) = await PairAsync();
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        await db.ExecAsync("""
            UPDATE reading_sessions SET client_session_id = (SELECT client_session_id FROM reading_sessions WHERE user_id = @account AND book_id IS NULL)
            WHERE user_id = @guest AND book_id IS NULL
            """, new { guest, account });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((1, 0), (merged.DroppedDuplicates, merged.HashAnomalies));
        Assert.Equal(3L, await db.CountAsync("reading_sessions", account));
    }

    [Fact]
    public async Task MergeAsync_MatchedGuestBookWithStoredBytes_ReleasesTheSupersededAndDuplicateKeys()
    {
        var (guest, account) = await PairAsync();
        var theirs = await db.NewBookAsync(guest);
        var oldVersion = theirs.CurrentFile!.Id;
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        // Bytes on both guest versions (an old one as a pre-M2.6 row could hold), and an unmatched book's that must stay.
        var kept = await db.NewBookAsync(guest);
        await db.ExecAsync("UPDATE book_files SET server_storage_key = 'k-' || id WHERE user_id = @guest", new { guest });
        await db.NewBookAsync(account, sha256: current.Sha256);

        var merged = await MergeAsync(guest, account);

        Assert.Equal(new[] { $"k-{oldVersion}", $"k-{current.Id}" }.Order(), merged.ReleasedKeys.Order());
        Assert.Null(await ScalarAsync<string?>("SELECT server_storage_key FROM book_files WHERE id = @oldVersion", new { oldVersion }));
        Assert.Equal($"k-{kept.CurrentFile!.Id}", await ScalarAsync<string>("SELECT server_storage_key FROM book_files WHERE id = @id", new { id = kept.CurrentFile.Id }));
    }

    [Fact]
    public async Task MergeAsync_SameBytesLiveBooks_AccountBookKeptGuestChildrenOnItOldVersionsNonCurrent()
    {
        var (guest, account) = await PairAsync();
        var (theirs, share) = await db.SeedEverythingAsync(guest);
        var oldVersion = theirs.CurrentFile!.Id;
        // The seed's annotation, example and share stay anchored in the old version; the guest reads on in the new one.
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        var ours = await db.NewBookAsync(account, sha256: current.Sha256);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((ours.Id, ours.CurrentFile!.Id), (merged.Books[theirs.Id], merged.Files[current.Id]));
        Assert.Equal(1L, await db.CountAsync("books", account));
        foreach (var table in (string[])["annotations", "vocabulary_examples", "shared_chapters", "discussion_checkpoints", "book_insight", "reading_sessions"])
            Assert.Equal((table, 1L), (table, await db.CountAsync(table, account, ours.Id)));
        Assert.Equal([(ours.CurrentFile.Id, true), (oldVersion, false)], (await FilesAsync(account)).OrderByDescending(f => f.IsCurrent));
        Assert.Equal(oldVersion, await ScalarAsync<Guid>("SELECT file_id FROM annotations WHERE user_id = @account", new { account }));
        // Book ids are hashed: the moved appends carry the hash of what the seed wrote, under the account's book.
        var example = new VocabularyExample { Sentence = "A quiver of arrows.", BookId = ours.Id, FileId = oldVersion };
        Assert.Equal(VocabularyPayloads.ExampleSha256(NewWord(account), example),
            await ScalarAsync<string>("SELECT payload_sha256 FROM vocabulary_examples WHERE user_id = @account", new { account }));
        (share.BookId, share.FileId) = (ours.Id, oldVersion);
        Assert.Equal(DiscussionPayloads.ShareSha256(share),
            await ScalarAsync<string>("SELECT payload_sha256 FROM shared_chapters WHERE user_id = @account", new { account }));
        var checkpoint = Assert.Single(await CheckpointsAsync(account));
        Assert.Equal((share.Id, DiscussionPayloads.CheckpointSha256(checkpoint)), (checkpoint.SharedChapterId, checkpoint.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_MovedRows_UpdatedAtBumpedForTheFeeds()
    {
        var (guest, account) = await PairAsync();
        await db.SeedEverythingAsync(guest);
        await db.ExecAsync("""
            UPDATE books SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE reading_state SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE annotations SET updated_at = now() - interval '1 day' WHERE user_id = @guest;
            UPDATE vocabulary_words SET updated_at = now() - interval '1 day' WHERE user_id = @guest
            """, new { guest });
        var since = DateTimeOffset.UtcNow.AddMinutes(-1);

        await MergeAsync(guest, account);

        foreach (var table in (string[])["books", "reading_state", "annotations", "vocabulary_words"])
            Assert.Equal((table, 1L), (table, await ScalarAsync<long>($"SELECT count(*) FROM {table} WHERE user_id = @account AND updated_at > @since", new { account, since })));
    }

    // ===== Words =====

    /// <summary>The user's card "quiver" (English) with one example and one answer; returns the card.</summary>
    private async Task<VocabularyWord> CardWithHistoryAsync(Guid userId, string language = "en")
    {
        var vocabulary = new VocabularyRepository(db.DataSource);
        var card = NewWord(userId, translation: "guest's");
        card.Language = language;
        card = (await vocabulary.SaveWordAsync(userId, card, Ct)).Word!;
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
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task MergeAsync_SameWordKey_AccountIdSurvivesWithBothHistories(bool accountTombstone, bool guestTombstone)
    {
        var (guest, account) = await PairAsync();
        var theirs = await CardWithHistoryAsync(guest);
        var vocabulary = new VocabularyRepository(db.DataSource);
        var ours = (await vocabulary.SaveWordAsync(account, NewWord(account, translation: "account's"), Ct)).Word!;
        await db.ExecAsync("""
            UPDATE vocabulary_words SET revision = 5, deleted_at = CASE WHEN @guestTombstone THEN now() END WHERE user_id = @guest;
            UPDATE vocabulary_words SET revision = 2, deleted_at = CASE WHEN @accountTombstone THEN now() END WHERE user_id = @account
            """, new { guest, account, guestTombstone, accountTombstone });

        var merged = await MergeAsync(guest, account);

        Assert.Equal(ours.Id, merged.Words[theirs.Id]);
        var card = (await vocabulary.GetWordAsync(account, ours.Id, Ct))!;
        // Revived from the guest's live card, or the account's live card as it was.
        Assert.Equal((6L, accountTombstone ? "guest's" : "account's", (DateTimeOffset?)null), (card.Revision, card.Translation, card.DeletedAt));
        Assert.Equal((1L, 1L, 1L), (await db.CountAsync("vocabulary_words", account), await db.CountAsync("vocabulary_examples", account), await db.CountAsync("vocabulary_reviews", account)));
        // A review hashes its card's id: rehashed under the survivor's.
        var review = Assert.Single(await RowsAsync<VocabularyReview>(
            "SELECT word_id, review_mode, is_correct, response_time_ms, client_recorded_at, payload_sha256 FROM vocabulary_reviews WHERE user_id = @account", new { account }));
        Assert.Equal((ours.Id, VocabularyPayloads.ReviewSha256(review)), (review.WordId, review.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_BothTombstones_AccountTombstoneKeptRevisionPastBoth()
    {
        var (guest, account) = await PairAsync();
        await CardWithHistoryAsync(guest);
        var ours = (await new VocabularyRepository(db.DataSource).SaveWordAsync(account, NewWord(account, translation: "account's"), Ct)).Word!;
        await db.ExecAsync("""
            UPDATE vocabulary_words SET revision = 7, deleted_at = now() WHERE user_id = @guest;
            UPDATE vocabulary_words SET revision = 3, deleted_at = now() WHERE user_id = @account
            """, new { guest, account });

        await MergeAsync(guest, account);

        Assert.Equal((8L, true, "account's"), Assert.Single(await RowsAsync<(long, bool, string?)>(
            "SELECT revision, deleted_at IS NOT NULL, translation FROM vocabulary_words WHERE user_id = @account AND id = @id", new { account, id = ours.Id })));
    }

    [Fact]
    public async Task MergeAsync_SameKeyOtherLanguage_NotMatched()
    {
        var (guest, account) = await PairAsync();
        await CardWithHistoryAsync(guest, language: "de");
        await new VocabularyRepository(db.DataSource).SaveWordAsync(account, NewWord(account), Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Words.Count, await db.CountAsync("vocabulary_words", account)));
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

        // The snapshot collision the mirror retries once (V2IdentityMirror).
        Assert.Equal("23505", (await Assert.ThrowsAsync<PostgresException>(() => first)).SqlState);
        var second = await MergeAsync(guest, account);
        Assert.Equal((AccountMergeOutcome.Merged, 1), (second.Outcome, second.DroppedDuplicates));
        Assert.Equal("replayed", await ScalarAsync<string>("SELECT sentence FROM vocabulary_examples WHERE user_id = @account AND operation_id = @op", new { account, op }));
    }

    // ===== Book matching =====

    [Fact]
    public async Task MergeAsync_RemovedGuestBook_NotMatched()
    {
        var (guest, account, theirs, _) = await SameBytesAsync();
        await new LibraryRepository(db.DataSource).RemoveAsync(guest, theirs.Id, Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_AccountBookRemoved_NotMatched()
    {
        var (guest, account, _, ours) = await SameBytesAsync();
        await new LibraryRepository(db.DataSource).RemoveAsync(account, ours.Id, Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    public static TheoryData<bool> NotCurrentSides => [true, false];

    [Theory, MemberData(nameof(NotCurrentSides))]
    public async Task MergeAsync_SameBytesInANonCurrentFile_NotMatched(bool guestSide)
    {
        var (guest, account) = await PairAsync();
        // One side holds the bytes only in an old version; the other has them current.
        var (holder, other) = guestSide ? (guest, account) : (account, guest);
        var replaced = await db.NewBookAsync(holder);
        await db.ReplaceFileAsync(replaced);
        await db.NewBookAsync(other, sha256: replaced.CurrentFile!.Sha256);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_TwoAccountBooksSameBytes_OldestWins()
    {
        var (guest, account, theirs, oldest) = await SameBytesAsync();
        // Import refuses a second live book with the same bytes; a replacement can make one.
        var younger = await db.NewBookAsync(account);
        await db.ExecAsync("UPDATE book_files SET sha256 = @sha WHERE user_id = @account AND book_id = @bookId",
            new { sha = theirs.CurrentFile!.Sha256, account, bookId = younger.Id });

        Assert.Equal(oldest.Id, (await MergeAsync(guest, account)).Books[theirs.Id]);
    }

    [Fact]
    public async Task MergeAsync_MatchedBook_AccountBookAndTheMovedAnnotationBumpedForTheFeeds()
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        await new AnnotationRepository(db.DataSource).SaveAsync(guest,
            new() { Id = Guid.NewGuid(), UserId = guest, BookId = theirs.Id, FileId = theirs.CurrentFile!.Id, SelectedText = "quoted", Locator = TestJson.Cfi(1) }, null, Ct);
        await db.ExecAsync("""
            UPDATE books SET updated_at = now() - interval '1 day' WHERE user_id IN (@guest, @account);
            UPDATE annotations SET updated_at = now() - interval '1 day' WHERE user_id = @guest
            """, new { guest, account });
        var since = DateTimeOffset.UtcNow.AddMinutes(-1);

        await MergeAsync(guest, account);

        foreach (var table in (string[])["books", "annotations"])
            Assert.Equal((table, 1L), (table, await ScalarAsync<long>(
                $"SELECT count(*) FROM {table} WHERE user_id = @account AND updated_at > @since", new { account, since })));
        Assert.Equal(ours.Id, await ScalarAsync<Guid>("SELECT book_id FROM annotations WHERE user_id = @account", new { account }));
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
        Assert.Equal([(replaced.Current!.Id, true), (theirs.CurrentFile.Id, false)],
            (await FilesAsync(account)).Where(f => f.Id == replaced.Current.Id || f.Id == theirs.CurrentFile.Id).OrderByDescending(f => f.IsCurrent));
    }

    // ===== Reading state =====

    private static ReadingState State(Guid fileId, decimal fraction, DateTimeOffset at) =>
        new() { FileId = fileId, CurrentLocator = TestJson.Cfi((int)(fraction * 100)), BookFraction = fraction, ClientRecordedAt = at };

    /// <summary>Matched books, each read: the guest's at 0.3 written at <paramref name="guestAt"/>, the account's at 0.8 then back to <paramref name="accountBack"/>.</summary>
    private async Task<(Guid Guest, Guid Account, Guid AccountBook)> BothReadAsync(DateTimeOffset guestAt, bool resetAccount = false, decimal accountBack = 0.2m)
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var states = new ReadingStateRepository(db.DataSource);
        var now = DateTimeOffset.UtcNow.AddMinutes(-10);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile!.Id, 0.3m, guestAt), null, default, Ct);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.8m, now), null, default, Ct);
        var back = await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile.Id, accountBack, now.AddMinutes(1)), 1, default, Ct);
        if (resetAccount) await states.ResetAsync(account, ours.Id, back.Current!.Revision, Ct);
        return (guest, account, ours.Id);
    }

    private Task<ReadingState?> StateAsync(Guid userId, Guid bookId) => new ReadingStateRepository(db.DataSource).GetAsync(userId, bookId, Ct);

    [Fact]
    public async Task MergeAsync_ReadingStateGuestNewer_GuestPositionFrontierIsTheMaxRevisionPastBoth()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow);

        await MergeAsync(guest, account);

        var state = (await StateAsync(account, book))!;
        Assert.Equal((0.3m, 0.8m, 3L, (long?)null), (state.BookFraction, state.FrontierFraction, state.Revision, state.ResetRevision));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateAccountNewerAndReset_AccountPositionAndResetKept()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1), resetAccount: true);

        await MergeAsync(guest, account);

        // The reset cleared the account's frontier; the guest's 0.3 is the furthest left.
        var state = (await StateAsync(account, book))!;
        Assert.Equal((0.2m, 0.3m, 4L, (long?)3), (state.BookFraction, state.FrontierFraction, state.Revision, state.ResetRevision));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateAccountWinsAfterAReset_FrontierNeverBelowItsPosition()
    {
        // The account's reset left no frontier at 0.5; the guest's older frontier is 0.3.
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1), resetAccount: true, accountBack: 0.5m);

        await MergeAsync(guest, account);

        var state = (await StateAsync(account, book))!;
        Assert.Equal((0.5m, 0.5m), (state.BookFraction, state.FrontierFraction));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateOlderSideCompleted_CompletionFollowsTheWinner()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1));
        await db.ExecAsync("UPDATE reading_state SET completed_at = now() WHERE user_id = @guest", new { guest });

        await MergeAsync(guest, account);

        Assert.Null((await StateAsync(account, book))!.CompletedAt);
    }

    [Fact]
    public async Task MergeAsync_ReadingStateOnlyGuest_MovesAsItIsOntoTheAccountFile()
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        await new ReadingStateRepository(db.DataSource).AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile!.Id, 0.4m, DateTimeOffset.UtcNow), null, default, Ct);

        await MergeAsync(guest, account);

        var state = (await StateAsync(account, ours.Id))!;
        Assert.Equal((ours.CurrentFile!.Id, 0.4m, 1L), (state.FileId, state.BookFraction, state.Revision));
    }

    [Fact]
    public async Task MergeAsync_GuestStateOnASupersededFile_Dropped()
    {
        var (guest, account) = await PairAsync();
        var theirs = await db.NewBookAsync(guest);
        var old = theirs.CurrentFile!.Id;
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        await db.ExecAsync("""
            INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, client_recorded_at)
            VALUES (@guest, @book, @old, CAST(@loc AS jsonb), 0.3, now())
            """, new { guest, book = theirs.Id, old, loc = TestJson.Cfi(3) });
        await db.NewBookAsync(account, sha256: current.Sha256);

        await MergeAsync(guest, account);

        Assert.Equal(0L, await db.CountAsync("reading_state", account));
    }

    [Fact]
    public async Task MergeAsync_AccountStateOnAnOldVersion_GuestStateTakesItsPlaceWithARevisionPastIt()
    {
        var (guest, account) = await PairAsync();
        var ours = await db.NewBookAsync(account);
        var states = new ReadingStateRepository(db.DataSource);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.9m, DateTimeOffset.UtcNow), null, default, Ct);
        await db.ExecAsync("UPDATE reading_state SET revision = 4 WHERE user_id = @account", new { account });
        // A replacement by the use case would delete the state; here it stays on the old version.
        var current = (await db.ReplaceFileAsync(ours)).Current!;
        var theirs = await db.NewBookAsync(guest, sha256: current.Sha256);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile!.Id, 0.2m, DateTimeOffset.UtcNow.AddHours(-1)), null, default, Ct);

        await MergeAsync(guest, account);

        var state = (await StateAsync(account, ours.Id))!;
        Assert.Equal((current.Id, 0.2m, 5L), (state.FileId, state.BookFraction, state.Revision));
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
    public async Task MergeAsync_DroppedShareOnAMatchedBook_GuestCheckpointRelinkedToTheAccountsShare()
    {
        var (guest, account, theirs, ours) = await SameBytesAsync();
        var accountShare = NewShare(ours);
        await new SharedChapterRepository(db.DataSource).ShareAsync(accountShare, Ct);
        var (_, checkpoint) = await SharedAsync(theirs, accountShare.OperationId);

        var merged = await MergeAsync(guest, account);

        var c = (await CheckpointsAsync(account)).Single(c => c.Id == checkpoint);
        Assert.Equal((1, accountShare.Id, DiscussionPayloads.CheckpointSha256(c)), (merged.DroppedDuplicates, c.SharedChapterId, c.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_DroppedShareOnAnotherBook_GuestCheckpointUnlinkedAndRehashed()
    {
        var (guest, account) = await PairAsync();
        var (accountShare, _) = await SharedAsync(await db.NewBookAsync(account));
        var (_, checkpoint) = await SharedAsync(await db.NewBookAsync(guest), accountShare.OperationId);

        await MergeAsync(guest, account);

        var c = (await CheckpointsAsync(account)).Single(c => c.Id == checkpoint);
        Assert.Equal(((Guid?)null, DiscussionPayloads.CheckpointSha256(c)), (c.SharedChapterId, c.PayloadSha256));
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

    [Fact]
    public async Task HoldsNothingDurableAsync_EmptyGuest_True()
    {
        Assert.True(await _repo.HoldsNothingDurableAsync(await db.NewReaderAsync(isGuest: true), Ct));
    }

    [Fact]
    public async Task HoldsNothingDurableAsync_GuestWithABook_False()
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        await db.NewBookAsync(guest);

        Assert.False(await _repo.HoldsNothingDurableAsync(guest, Ct));
    }

    [Fact]
    public async Task HoldsNothingDurableAsync_GuestWithAWordOnly_False()
    {
        var guest = await db.NewReaderAsync(isGuest: true);
        await new VocabularyRepository(db.DataSource).SaveWordAsync(guest, NewWord(guest), Ct);

        Assert.False(await _repo.HoldsNothingDurableAsync(guest, Ct));
    }

    [Fact]
    public async Task HoldsNothingDurableAsync_BobsBook_DoesNotCountForAlice()
    {
        var (alice, bob) = (await db.NewReaderAsync(isGuest: true), await db.NewReaderAsync(isGuest: true));
        await db.NewBookAsync(bob);

        Assert.True(await _repo.HoldsNothingDurableAsync(alice, Ct));
    }
}
