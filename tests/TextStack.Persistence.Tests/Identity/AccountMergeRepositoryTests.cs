using System.Text.Json;
using Application.Vocabulary;
using Dapper;
using Domain.Identity;
using Domain.Reading;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
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
    private static readonly string[] Dying = ["user_refresh_tokens", "password_reset_tokens", "device_authorizations", "oauth_authorization_requests"];

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

    public static TheoryData<string> RefusedCases => ["NotGuest", "AccountIsGuest", "SameId", "NoAccount"];

    [Theory, MemberData(nameof(RefusedCases))]
    public async Task MergeAsync_NotAGuestIntoAnAccount_RefusedAndNothingMoves(string refused)
    {
        var guest = refused == "NotGuest" ? await db.NewReaderAsync() : await NewGuestAsync();
        var account = refused switch
        {
            "AccountIsGuest" => await NewGuestAsync(),
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

    /// <summary>A guest and an account book with the same bytes, each with a state: the guest's at 0.3 written at <paramref name="guestAt"/>, the account's at 0.8 then back to 0.2.</summary>
    private async Task<(Guid Guest, Guid Account, Guid AccountBook)> BothReadAsync(DateTimeOffset guestAt, bool resetAccount = false)
    {
        var (guest, account) = (await NewGuestAsync(), await db.NewReaderAsync());
        var theirs = await db.NewBookAsync(guest);
        var ours = await db.NewBookAsync(account, sha256: theirs.CurrentFile!.Sha256);
        var states = new ReadingStateRepository(db.DataSource);
        var now = DateTimeOffset.UtcNow.AddMinutes(-10);
        await states.AdvanceAsync(guest, theirs.Id, State(theirs.CurrentFile.Id, 0.3m, guestAt), null, Ct);
        await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile!.Id, 0.8m, now), null, Ct);
        var back = await states.AdvanceAsync(account, ours.Id, State(ours.CurrentFile.Id, 0.2m, now.AddMinutes(1)), 1, Ct);
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
}
