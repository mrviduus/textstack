using System.Text.Json;
using Application.Vocabulary;
using Dapper;
using Application.Discussion;
using Contracts.V2;
using Domain.Discussion;
using Domain.Identity;
using Domain.Reading;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>
/// The guest→account merge (v2-sync-protocol.md "Guest → account merge", M2.5 plan §2). Each test runs
/// the merge in its own transaction and ends it with <c>SET CONSTRAINTS ALL IMMEDIATE</c> before the
/// commit (ADR-031 rule 9), so a deferred provenance FK the merge left dangling fails the test.
/// </summary>
public class AccountMergeRepositoryTests(V2PostgresFixture db)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly AccountMergeRepository _repo = new(db.DataSource);

    /// <summary>The tables that die with the guest row (step 8): the account gets none of the guest's.</summary>
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

    private async Task<Guid> NewGuestAsync()
    {
        var guest = await db.NewReaderAsync();
        await ExecAsync("UPDATE users SET is_guest = true WHERE id = @guest", new { guest });
        return guest;
    }

    private async Task ExecAsync(string sql, object args)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(sql, args, cancellationToken: Ct));
    }

    private async Task<T> ScalarAsync<T>(string sql, object args)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.ExecuteScalarAsync<T>(new CommandDefinition(sql, args, cancellationToken: Ct)))!;
    }

    [Fact]
    public async Task MergeAsync_GuestAbsent_NoGuest()
    {
        var account = await db.NewReaderAsync();

        Assert.Equal(AccountMergeOutcome.NoGuest, (await MergeAsync(Guid.NewGuid(), account)).Outcome);
    }

    public static TheoryData<string> RefusedCases => ["NotGuest", "SameId", "NoAccount"];

    [Theory, MemberData(nameof(RefusedCases))]
    public async Task MergeAsync_NotAGuestIntoAnAccount_RefusedAndNothingMoves(string refused)
    {
        var guest = refused == "NotGuest" ? await db.NewReaderAsync() : await NewGuestAsync();
        var account = refused switch
        {
            "SameId" => guest,
            "NoAccount" => Guid.NewGuid(),
            _ => await db.NewReaderAsync(),
        };
        await db.SeedEverythingAsync(guest);

        Assert.Equal(AccountMergeOutcome.Refused, (await MergeAsync(guest, account)).Outcome);
        Assert.Equal(1L, await db.CountAsync("books", guest));
        Assert.Equal(1L, await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest }));
    }

    [Fact]
    public async Task MergeAsync_AccountStillFlaggedAGuest_MergedAndTheFlagCleared()
    {
        // A guest promoted in place whose promotion did not reach V2: the caller signed it in as an account.
        var (guest, account) = (await NewGuestAsync(), await NewGuestAsync());
        await db.NewBookAsync(guest);

        Assert.Equal(AccountMergeOutcome.Merged, (await MergeAsync(guest, account)).Outcome);
        Assert.Equal((false, 1L), (await ScalarAsync<bool>("SELECT is_guest FROM users WHERE id = @account", new { account }), await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_NothingMatches_EveryRowMovesWithItsIdAndTheGuestIsGone()
    {
        var (guest, account, carol) = (await NewGuestAsync(), await db.NewReaderAsync(), await db.NewReaderAsync());
        var (book, _) = await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(carol);
        await ExecAsync("UPDATE vocabulary_words SET word_key = 'other' WHERE user_id = @guest", new { guest });
        var tables = await UserTablesAsync();

        var merged = await MergeAsync(guest, account);

        Assert.Equal((AccountMergeOutcome.Merged, 0, 0, 0), (merged.Outcome, merged.Books.Count, merged.Words.Count, merged.DroppedDuplicates));
        foreach (var table in tables)
        {
            var seeded = table == "reading_sessions" ? 2L : 1L;
            // The trace keeps the guest's id: no FK by design (ADR-031).
            var (guestLeft, moved) = table == "llm_traces" ? (1L, 0L) : (0L, Dying.Contains(table) ? 0L : seeded);
            Assert.Equal((table, guestLeft, moved, seeded), (table, await db.CountAsync(table, guest), await db.CountAsync(table, account), await db.CountAsync(table, carol)));
        }
        Assert.Equal(0L, await ScalarAsync<long>("SELECT count(*) FROM users WHERE id = @guest", new { guest }));
        Assert.Equal(book.Id, await ScalarAsync<Guid>("SELECT id FROM books WHERE user_id = @account", new { account }));
    }

    /// <summary>Every table with a user_id column but users itself, from the catalog: a table added later is covered without anyone listing it.</summary>
    private async Task<List<string>> UserTablesAsync()
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<string>(new CommandDefinition(
            "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id' ORDER BY 1",
            cancellationToken: Ct))).AsList();
    }

    [Theory]
    [InlineData("vocabulary_examples", 0)]
    [InlineData("vocabulary_reviews", 0)]
    [InlineData("shared_chapters", 1)]
    [InlineData("discussion_checkpoints", 1)]
    public async Task MergeAsync_OperationIdBothHold_GuestCopyDroppedAccountKeptAnomalyCounted(string table, int anomalies)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        var kept = await ScalarAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account", new { account });
        await ExecAsync($"UPDATE {table} SET operation_id = (SELECT operation_id FROM {table} WHERE user_id = @account) WHERE user_id = @guest", new { guest, account });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((1, anomalies), (merged.DroppedDuplicates, merged.HashAnomalies));
        Assert.Equal(kept, await ScalarAsync<Guid>($"SELECT id FROM {table} WHERE user_id = @account", new { account }));
    }

    [Fact]
    public async Task MergeAsync_ClientSessionIdBothHold_GuestCopyDropped()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        await ExecAsync("""
            UPDATE reading_sessions SET client_session_id = (SELECT client_session_id FROM reading_sessions WHERE user_id = @account AND book_id IS NULL)
            WHERE user_id = @guest AND book_id IS NULL
            """, new { guest, account });

        var merged = await MergeAsync(guest, account);

        Assert.Equal((1, 0), (merged.DroppedDuplicates, merged.HashAnomalies));
        Assert.Equal(3L, await db.CountAsync("reading_sessions", account));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task MergeAsync_SameWordKey_AccountIdSurvivesWithBothHistories(bool accountTombstone, bool guestTombstone)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        var vocabulary = new VocabularyRepository(db.DataSource);
        var ours = (await vocabulary.SaveWordAsync(account, NewWord(account, translation: "account's"), Ct)).Word!;
        await ExecAsync("""
            UPDATE vocabulary_words SET translation = 'guest''s', revision = 5, deleted_at = CASE WHEN @guestTombstone THEN now() END WHERE user_id = @guest;
            UPDATE vocabulary_words SET revision = 2, deleted_at = CASE WHEN @accountTombstone THEN now() END WHERE user_id = @account
            """, new { guest, account, guestTombstone, accountTombstone });
        var theirs = await ScalarAsync<Guid>("SELECT id FROM vocabulary_words WHERE user_id = @guest", new { guest });

        var merged = await MergeAsync(guest, account);

        Assert.Equal(ours.Id, merged.Words[theirs]);
        var card = (await vocabulary.GetWordAsync(account, ours.Id, Ct))!;
        Assert.Equal(6L, card.Revision);
        Assert.Equal(accountTombstone ? "guest's" : "account's", card.Translation);
        // Revived from the guest's live card, or the account's live card as it was.
        Assert.Null(card.DeletedAt);
        Assert.Equal((1L, 1L, 1L), (await db.CountAsync("vocabulary_words", account), await db.CountAsync("vocabulary_examples", account), await db.CountAsync("vocabulary_reviews", account)));
        var review = await ScalarAsync<string>("SELECT payload_sha256 FROM vocabulary_reviews WHERE user_id = @account", new { account });
        var stored = (await ReviewsAsync(account)).Single();
        Assert.Equal((ours.Id, VocabularyPayloads.ReviewSha256(stored)), (stored.WordId, review));
    }

    private async Task<List<VocabularyReview>> ReviewsAsync(Guid userId)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<VocabularyReview>(new CommandDefinition(
            "SELECT id, word_id, review_mode, is_correct, response_time_ms, client_recorded_at FROM vocabulary_reviews WHERE user_id = @userId",
            new { userId }, cancellationToken: Ct))).AsList();
    }

    [Fact]
    public async Task MergeAsync_SameBytesLiveBooks_AccountBookKeptGuestChildrenOnItOldVersionsNonCurrent()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var (theirs, _) = await db.SeedEverythingAsync(guest);
        var oldVersion = theirs.CurrentFile!.Id;
        // The seed's annotation stays anchored in the old version; the guest reads on in the new one.
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        var ours = await db.NewBookAsync(account, sha256: current.Sha256);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((ours.Id, ours.CurrentFile!.Id), (merged.Books[theirs.Id], merged.Files[current.Id]));
        Assert.Equal(1L, await db.CountAsync("books", account));
        foreach (var table in (string[])["annotations", "vocabulary_examples", "shared_chapters", "discussion_checkpoints", "book_insight"])
            Assert.Equal((table, 1L), (table, await db.CountAsync(table, account, ours.Id)));
        Assert.Equal(1L, await db.CountAsync("reading_sessions", account, ours.Id));
        var files = await FilesAsync(account);
        Assert.Equal([(ours.CurrentFile.Id, true), (oldVersion, false)], files.OrderByDescending(f => f.IsCurrent));
        Assert.Equal(oldVersion, await ScalarAsync<Guid>("SELECT file_id FROM annotations WHERE user_id = @account", new { account }));
        // The example's book and file ids are hashed: its hash is the one the API would compute now.
        Assert.Equal(await ExpectedExampleHashAsync(account),
            await ScalarAsync<string>("SELECT payload_sha256 FROM vocabulary_examples WHERE user_id = @account", new { account }));
    }

    private async Task<string> ExpectedExampleHashAsync(Guid account)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<VocabularyExample, VocabularyWord, string>(new CommandDefinition("""
            SELECT e.id, e.book_id, e.file_id, e.chapter_key, e.book_title, e.sentence, e.contextual_translation, w.language, w.word_key
            FROM vocabulary_examples e JOIN vocabulary_words w ON w.user_id = e.user_id AND w.id = e.word_id
            WHERE e.user_id = @account
            """, new { account }, cancellationToken: Ct), (e, w) => VocabularyPayloads.ExampleSha256(w, e), splitOn: "language")).Single();
    }

    private async Task<List<(Guid Id, bool IsCurrent)>> FilesAsync(Guid userId)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<(Guid, bool)>(new CommandDefinition(
            "SELECT id, is_current FROM book_files WHERE user_id = @userId", new { userId }, cancellationToken: Ct))).AsList();
    }

    [Fact]
    public async Task MergeAsync_RemovedGuestBook_NotMatched()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        await new LibraryRepository(db.DataSource).RemoveAsync(guest, theirs.Id, Ct);
        await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);

        var merged = await MergeAsync(guest, account);

        Assert.Empty(merged.Books);
        Assert.Equal(2L, await db.CountAsync("books", account));
    }

    [Fact]
    public async Task MergeAsync_TwoAccountBooksSameBytes_OldestWins()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var oldest = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        // Import refuses a second live book with the same bytes; a replacement can make one.
        var younger = await db.NewBookAsync(account);
        await ExecAsync("UPDATE book_files SET sha256 = @sha WHERE user_id = @account AND book_id = @bookId",
            new { sha = theirs.CurrentFile.Sha256, account, bookId = younger.Id });

        var merged = await MergeAsync(guest, account);

        Assert.Equal(oldest.Id, merged.Books[theirs.Id]);
    }

    private static ReadingState State(Guid fileId, decimal fraction, DateTimeOffset at) =>
        new() { FileId = fileId, CurrentLocator = TestJson.Page((int)(fraction * 100)), BookFraction = fraction, ClientRecordedAt = at };

    /// <summary>A guest and an account book with the same bytes, each with a state: the guest's at 0.3 written at <paramref name="guestAt"/>, the account's at 0.8 then back to <paramref name="accountBack"/>.</summary>
    private async Task<(Guid Guest, Guid Account, Guid AccountBook)> BothReadAsync(DateTimeOffset guestAt, bool resetAccount = false, decimal accountBack = 0.2m)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        var states = new ReadingStateRepository(db.DataSource);
        var now = DateTimeOffset.UtcNow.AddMinutes(-10);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile.Id, 0.3m, guestAt), null, Ct);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.8m, now), null, Ct);
        var back = await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile.Id, accountBack, now.AddMinutes(1)), 1, Ct);
        if (resetAccount) await states.ResetAsync(account, ours.Id, back.Current!.Revision, Ct);
        return (guest, account, ours.Id);
    }

    [Fact]
    public async Task MergeAsync_ReadingStateGuestNewer_GuestPositionFrontierIsTheMaxRevisionPastBoth()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow);

        await MergeAsync(guest, account);

        var state = (await new ReadingStateRepository(db.DataSource).GetAsync(account, book, Ct))!;
        Assert.Equal((0.3m, 0.8m, 3L, (long?)null), (state.BookFraction, state.FrontierFraction, state.Revision, state.ResetRevision));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateAccountNewerAndReset_AccountPositionAndResetKept()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1), resetAccount: true);

        await MergeAsync(guest, account);

        // The reset cleared the account's frontier; the guest's 0.3 is the furthest left.
        var state = (await new ReadingStateRepository(db.DataSource).GetAsync(account, book, Ct))!;
        Assert.Equal((0.2m, 0.3m, 4L, (long?)3), (state.BookFraction, state.FrontierFraction, state.Revision, state.ResetRevision));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateOnlyGuest_MovesAsItIsOntoTheAccountFile()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        await new ReadingStateRepository(db.DataSource).AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile.Id, 0.4m, DateTimeOffset.UtcNow), null, Ct);

        await MergeAsync(guest, account);

        var state = (await new ReadingStateRepository(db.DataSource).GetAsync(account, ours.Id, Ct))!;
        Assert.Equal((ours.CurrentFile!.Id, 0.4m, 1L), (state.FileId, state.BookFraction, state.Revision));
    }

    [Fact]
    public async Task MergeAsync_InsightClash_NewerStaysOlderKeptInFullAsACheckpoint()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var (theirs, _) = await db.SeedEverythingAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        var loser = await ScalarAsync<Guid>("SELECT id FROM book_insight WHERE user_id = @guest", new { guest });
        var winner = (await new Infrastructure.Persistence.Repositories.BookInsightRepository(db.DataSource).SaveAsync(NewInsight(ours, "ch-1", "newer"), Ct))!;

        var merged = await MergeAsync(guest, account);

        Assert.Equal(1, merged.UnscheduledReviewQuestions);
        Assert.Equal(winner.Id, await ScalarAsync<Guid>("SELECT id FROM book_insight WHERE user_id = @account", new { account }));
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var kept = await conn.QuerySingleAsync<(string Topic, string Thoughts, string Suggestions, string Conclusions, string Open, string Language, Guid OperationId, string? ChapterKey)>(
            new CommandDefinition("""
                SELECT topic, reader_thoughts::text, assistant_suggestions::text, conclusions::text, open_questions::text, language, operation_id, chapter_key
                FROM discussion_checkpoints WHERE user_id = @account AND id = @loser
                """, new { account, loser }, cancellationToken: Ct));
        Assert.Equal(("q", """["q"]""", """["{}"]""", """["text"]""", "Why? — Because.", "und", loser, "ch-1"),
            (kept.Topic, kept.Thoughts, kept.Suggestions, kept.Conclusions, JsonSerializer.Deserialize<string[]>(kept.Open)!.Single(), kept.Language, kept.OperationId, kept.ChapterKey));
        Assert.Equal(0L, await db.CountAsync("review_question", account));
    }

    [Fact]
    public async Task MergeAsync_MovedRows_UpdatedAtBumpedForTheFeeds()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        await ExecAsync("""
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

    [Fact]
    public async Task MergeAsync_RunTwice_SecondIsNoGuest()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);

        await MergeAsync(guest, account);

        Assert.Equal(AccountMergeOutcome.NoGuest, (await MergeAsync(guest, account)).Outcome);
    }

    [Fact]
    public async Task MergeAsync_TwoAtOnce_OneMergesTheOtherFindsNoGuest()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);

        // Own transactions: the commit checks the deferred FKs.
        var outcomes = await Task.WhenAll(_repo.MergeAsync(guest, account, null, Ct), _repo.MergeAsync(guest, account, null, Ct));

        Assert.Equal([AccountMergeOutcome.Merged, AccountMergeOutcome.NoGuest], outcomes.Select(o => o.Outcome).Order());
        Assert.Equal(1L, await db.CountAsync("books", account));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateAccountWinsAfterAReset_FrontierNeverBelowItsPosition()
    {
        // The account's reset left no frontier at 0.5; the guest's older frontier is 0.3.
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1), resetAccount: true, accountBack: 0.5m);

        await MergeAsync(guest, account);

        var state = (await new ReadingStateRepository(db.DataSource).GetAsync(account, book, Ct))!;
        Assert.Equal((0.5m, 0.5m), (state.BookFraction, state.FrontierFraction));
    }

    [Fact]
    public async Task MergeAsync_ReadingStateOlderSideCompleted_CompletionFollowsTheWinner()
    {
        var (guest, account, book) = await BothReadAsync(DateTimeOffset.UtcNow.AddHours(-1));
        await ExecAsync("UPDATE reading_state SET completed_at = now() WHERE user_id = @guest", new { guest });

        await MergeAsync(guest, account);

        Assert.Null((await new ReadingStateRepository(db.DataSource).GetAsync(account, book, Ct))!.CompletedAt);
    }

    [Fact]
    public async Task MergeAsync_GuestStateOnASupersededFile_Dropped()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var old = theirs.CurrentFile!.Id;
        var current = (await db.ReplaceFileAsync(theirs)).Current!;
        await ExecAsync("""
            INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, client_recorded_at)
            VALUES (@guest, @book, @old, CAST(@loc AS jsonb), 0.3, now())
            """, new { guest, book = theirs.Id, old, loc = TestJson.Page(3) });
        var ours = await db.NewBookAsync(account, sha256: current.Sha256);

        await MergeAsync(guest, account);

        Assert.Null(await new ReadingStateRepository(db.DataSource).GetAsync(account, ours.Id, Ct));
        Assert.Equal(0L, await db.CountAsync("reading_state", account));
    }

    [Fact]
    public async Task MergeAsync_AccountStateOnAnOldVersion_GuestStateTakesItsPlaceWithARevisionPastIt()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var ours = await db.NewBookAsync(account);
        var states = new ReadingStateRepository(db.DataSource);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.9m, DateTimeOffset.UtcNow), null, Ct);
        await ExecAsync("UPDATE reading_state SET revision = 4 WHERE user_id = @account", new { account });
        // A replacement by the use case would delete the state; here it stays on the old version.
        var current = (await db.ReplaceFileAsync(ours)).Current!;
        var theirs = await db.NewBookAsync(guest, sha256: current.Sha256);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile!.Id, 0.2m, DateTimeOffset.UtcNow.AddHours(-1)), null, Ct);

        await MergeAsync(guest, account);

        var state = (await states.GetAsync(account, ours.Id, Ct))!;
        Assert.Equal((current.Id, 0.2m, 5L), (state.FileId, state.BookFraction, state.Revision));
    }

    [Fact]
    public async Task MergeAsync_SameKeyOtherLanguage_NotMatched()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        await ExecAsync("UPDATE vocabulary_words SET language = 'de' WHERE user_id = @guest", new { guest });
        await new VocabularyRepository(db.DataSource).SaveWordAsync(account, NewWord(account), Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Words.Count, await db.CountAsync("vocabulary_words", account)));
    }

    [Fact]
    public async Task MergeAsync_BothTombstones_AccountTombstoneKeptRevisionPastBoth()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        var ours = (await new VocabularyRepository(db.DataSource).SaveWordAsync(account, NewWord(account, translation: "account's"), Ct)).Word!;
        await ExecAsync("""
            UPDATE vocabulary_words SET revision = 7, deleted_at = now() WHERE user_id = @guest;
            UPDATE vocabulary_words SET revision = 3, deleted_at = now() WHERE user_id = @account
            """, new { guest, account });

        await MergeAsync(guest, account);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        Assert.Equal((8L, true, "account's"), await conn.QuerySingleAsync<(long, bool, string?)>(new CommandDefinition(
            "SELECT revision, deleted_at IS NOT NULL, translation FROM vocabulary_words WHERE user_id = @account AND id = @id",
            new { account, id = ours.Id }, cancellationToken: Ct)));
    }

    public static TheoryData<bool> NotCurrentSides => [true, false];

    [Theory, MemberData(nameof(NotCurrentSides))]
    public async Task MergeAsync_SameBytesInANonCurrentFile_NotMatched(bool guestSide)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        // One side holds the bytes only in an old version; the other has them current.
        var (holder, other) = guestSide ? (guest, account) : (account, guest);
        var replaced = await db.NewBookAsync(holder);
        var sha = replaced.CurrentFile!.Sha256;
        await db.ReplaceFileAsync(replaced);
        await db.NewBookAsync(other, sha256: sha);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_AccountBookRemoved_NotMatched()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        await new LibraryRepository(db.DataSource).RemoveAsync(account, ours.Id, Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal((0, 2L), (merged.Books.Count, await db.CountAsync("books", account)));
    }

    [Fact]
    public async Task MergeAsync_MatchedBook_AccountBookAndTheMovedAnnotationBumpedForTheFeeds()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var (theirs, _) = await db.SeedEverythingAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        await ExecAsync("""
            UPDATE books SET updated_at = now() - interval '1 day' WHERE user_id IN (@guest, @account);
            UPDATE annotations SET updated_at = now() - interval '1 day' WHERE user_id = @guest
            """, new { guest, account });
        var since = DateTimeOffset.UtcNow.AddMinutes(-1);

        await MergeAsync(guest, account);

        foreach (var table in (string[])["books", "annotations"])
            Assert.Equal((table, 1L), (table, await ScalarAsync<long>(
                $"SELECT count(*) FROM {table} WHERE user_id = @account AND updated_at > @since", new { account, since })));
        Assert.Equal(ours.Id, await ScalarAsync<Guid>("SELECT id FROM books WHERE user_id = @account", new { account }));
    }

    [Theory]
    [InlineData(null, "uk", "uk")]
    [InlineData("", "uk", "uk")]
    [InlineData("de", "uk", "de")]
    public async Task MergeAsync_NativeLanguage_TheGuestsOnlyWhenTheAccountHasNone(string? accountLanguage, string guestLanguage, string expected)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await ExecAsync("UPDATE users SET native_language = @guestLanguage WHERE id = @guest; UPDATE users SET native_language = @accountLanguage WHERE id = @account",
            new { guest, account, guestLanguage, accountLanguage });

        await MergeAsync(guest, account);

        Assert.Equal(expected, await ScalarAsync<string>("SELECT native_language FROM users WHERE id = @account", new { account }));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MergeAsync_InsightClashWithThreeQuestions_LoserKeptInFullWithTheApiHash(bool guestLoses)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        var insights = new BookInsightRepository(db.DataSource);
        var questions = new ReviewQuestionRepository(db.DataSource);
        var g = await insights.SaveReviewAsync(NewInsight(theirs, "ch-2", "guest text", reviewJson: """{"b":1,"a":[2]}"""), Ct);
        var a = await insights.SaveReviewAsync(NewInsight(ours, "ch-2", "account text", reviewJson: """{"z":true}"""), Ct);
        await ExecAsync("UPDATE book_insight SET updated_at = now() - interval '1 hour' WHERE id = @id", new { id = guestLoses ? g.Id : a.Id });
        var (loser, winner) = guestLoses ? (g, a) : (a, g);
        await questions.ReplaceForInsightAsync(loser.UserId, loser.Id,
            [.. Enumerable.Range(1, 3).Select(i => new ReviewQuestion { Id = Guid.NewGuid(), UserId = loser.UserId, BookInsightId = loser.Id, BlockIndex = i, Prompt = $"P{i}?", Answer = $"A{i}.", PromptHash = $"h{i}", NextReviewAt = DateTimeOffset.UtcNow })], Ct);
        await questions.ReplaceForInsightAsync(winner.UserId, winner.Id,
            [new ReviewQuestion { Id = Guid.NewGuid(), UserId = winner.UserId, BookInsightId = winner.Id, BlockIndex = 1, Prompt = "W?", Answer = "W.", PromptHash = "w1", NextReviewAt = DateTimeOffset.UtcNow }], Ct);

        var merged = await MergeAsync(guest, account);

        Assert.Equal(3, merged.UnscheduledReviewQuestions);
        Assert.Equal(winner.Id, await ScalarAsync<Guid>("SELECT id FROM book_insight WHERE user_id = @account", new { account }));
        Assert.Equal(1L, await db.CountAsync("review_question", account));
        var kept = (await CheckpointsAsync(account)).Single(c => c.Id == loser.Id);
        Assert.Equal(["P1? — A1.", "P2? — A2.", "P3? — A3."], Items(kept.OpenQuestions));
        Assert.Equal([loser.Text], Items(kept.Conclusions));
        Assert.Equal(("und", "ch-2", ours.Id, ApiHash(kept)), (kept.Language, kept.ChapterKey, kept.BookId, kept.PayloadSha256));
    }

    private async Task<List<DiscussionCheckpoint>> CheckpointsAsync(Guid userId)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return (await conn.QueryAsync<DiscussionCheckpoint>(new CommandDefinition("""
            SELECT id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256
            FROM discussion_checkpoints WHERE user_id = @userId
            """, new { userId }, cancellationToken: Ct))).AsList();
    }

    private static string?[] Items(string json) => JsonSerializer.Deserialize<string?[]>(json)!;

    /// <summary>The hash the API computes for this checkpoint as it is stored now.</summary>
    private static string ApiHash(DiscussionCheckpoint c) => DiscussionPayloads.CheckpointSha256(c.BookId, new CheckpointRequest(
        c.OperationId, c.Topic, Items(c.ReaderThoughts), Items(c.AssistantSuggestions), Items(c.Conclusions), Items(c.OpenQuestions),
        c.Language, c.ChapterKey, c.FileId, c.SharedChapterId));

    [Fact]
    public async Task MergeAsync_MatchedBook_ShareAndCheckpointCarryTheApiHashUnderTheAccountIds()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var (theirs, share) = await db.SeedEverythingAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);

        await MergeAsync(guest, account);

        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        var s = await conn.QuerySingleAsync<SharedChapter>(new CommandDefinition(
            "SELECT id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language, operation_id, payload_sha256 FROM shared_chapters WHERE user_id = @account",
            new { account }, cancellationToken: Ct));
        Assert.Equal((ours.Id, ours.CurrentFile!.Id), (s.BookId, s.FileId));
        Assert.Equal(DiscussionPayloads.ShareSha256(ours.Id, new ShareChapterRequest(
            s.OperationId, s.FileId, s.ChapterKey, s.ChapterTitle, s.ChapterText, JsonSerializer.Deserialize<JsonElement>(s.NotesSnapshot), s.Language)), s.PayloadSha256);
        var c = (await CheckpointsAsync(account)).Single(c => c.Language != "und");
        Assert.Equal((share.Id, ApiHash(c)), (c.SharedChapterId, c.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_DroppedShareOnAMatchedBook_GuestCheckpointRelinkedToTheAccountsShare()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var (theirs, _) = await db.SeedEverythingAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        var accountShare = NewShare(ours);
        await new SharedChapterRepository(db.DataSource).ShareAsync(accountShare, Ct);
        await ExecAsync("UPDATE shared_chapters SET operation_id = @op WHERE user_id = @guest", new { guest, op = accountShare.OperationId });
        var checkpoint = await ScalarAsync<Guid>("SELECT id FROM discussion_checkpoints WHERE user_id = @guest", new { guest });

        var merged = await MergeAsync(guest, account);

        var c = (await CheckpointsAsync(account)).Single(c => c.Id == checkpoint);
        Assert.Equal((1, accountShare.Id, ApiHash(c)), (merged.DroppedDuplicates, c.SharedChapterId, c.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_DroppedShareOnAnotherBook_GuestCheckpointUnlinkedAndRehashed()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
        await db.SeedEverythingAsync(account);
        await ExecAsync("UPDATE shared_chapters SET operation_id = (SELECT operation_id FROM shared_chapters WHERE user_id = @account) WHERE user_id = @guest", new { guest, account });
        var checkpoint = await ScalarAsync<Guid>("SELECT id FROM discussion_checkpoints WHERE user_id = @guest", new { guest });

        await MergeAsync(guest, account);

        var c = (await CheckpointsAsync(account)).Single(c => c.Id == checkpoint);
        Assert.Equal(((Guid?)null, ApiHash(c)), (c.SharedChapterId, c.PayloadSha256));
    }

    [Fact]
    public async Task MergeAsync_GuestAnnotationInFlightOnAMatchedBook_LandsOnTheAccountBook()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
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
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        await using var writer = await db.DataSource.OpenConnectionAsync(Ct);
        await using var write = await writer.BeginTransactionAsync(Ct);
        var replaced = await new LibraryRepository(db.DataSource).ReplaceFileAsync(guest, theirs.Id, NewFile(guest, theirs.Id), theirs.CurrentFile.Id, write, Ct);

        var merge = MergeAsync(guest, account);
        await db.WaitUntilBlockedByAsync(writer, merge);
        await write.CommitAsync(Ct);

        // The merge saw the replacement: the guest book's bytes changed, so it no longer matches and
        // moves with both its versions, the new one current.
        var merged = await merge;
        Assert.Empty(merged.Books);
        Assert.Equal([(replaced.Current!.Id, true), (theirs.CurrentFile.Id, false)],
            (await FilesAsync(account)).Where(f => f.Id == replaced.Current.Id || f.Id == theirs.CurrentFile.Id).OrderByDescending(f => f.IsCurrent));
    }

    [Fact]
    public async Task MergeAsync_AccountReplaysAGuestOperationIdDuringTheMerge_FirstRunCollidesSecondMerges()
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        await db.SeedEverythingAsync(guest);
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
}
