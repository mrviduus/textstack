using System.Security.Cryptography;
using System.Text;
using Application.Vocabulary;
using Dapper;
using Domain.Library;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Vocabulary;

// The deferred provenance FKs on vocabulary_examples need no SET CONSTRAINTS here: every repository
// write commits before the call returns, so a deferred check fails inside the call that broke it.
public class VocabularyRepositoryTests(V2PostgresFixture db)
{
    private readonly VocabularyRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DateTimeOffset Noon = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    /// <summary>Any 64-hex value will do: the repository stores and compares the hash, it does not compute it.</summary>
    private static string Hash(string payload) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));

    private static VocabularyWord Word(Guid userId, string? translation = null, string? definition = null, string key = "quiver") => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        Language = "en",
        Word = key,
        WordKey = key,
        Translation = translation,
        Definition = definition,
    };

    private static VocabularyExample Example(Guid userId, string sentence, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        Sentence = sentence,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = Hash(sentence),
    };

    private static VocabularyExample OnCard(VocabularyWord card, VocabularyExample example)
    {
        example.WordId = card.Id;
        return example;
    }

    /// <summary>A correct answer that takes the card from stage 0 to 1.</summary>
    private static VocabularyReview Review(VocabularyWord word, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = word.UserId,
        WordId = word.Id,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = Hash("correct"),
        ReviewMode = "multiple_choice",
        IsCorrect = true,
        ResponseTimeMs = 900,
        StageBefore = 0,
        StageAfter = 1,
        ClientRecordedAt = Noon,
    };

    private static ReviewSchedule DueAt(DateTimeOffset nextReviewAt) => new(1, 1m, 0, nextReviewAt);

    private async Task<VocabularyWord> SavedWordAsync(Guid? userId = null, string? translation = null) =>
        (await _repo.SaveWordAsync(Word(userId ?? await db.NewReaderAsync(), translation), null, Ct)).Word;

    private async Task<long> CountAsync(string table, Guid userId)
    {
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            $"SELECT count(*) FROM {table} WHERE user_id = @userId", new { userId }, cancellationToken: Ct));
    }

    [Fact]
    public async Task SaveWordAsync_NewWord_CreatesACardOnTheDefaultScheduleWithItsExample()
    {
        var user = await db.NewReaderAsync();

        var saved = await _repo.SaveWordAsync(Word(user, "колчан"), Example(user, "A quiver of arrows."), Ct);

        Assert.Equal(WordSaveOutcome.Created, saved.Outcome);
        Assert.Equal((0, 0m, 0, (DateTimeOffset?)null, 1L, "колчан"), (saved.Word.Stage, saved.Word.IntervalDays,
            saved.Word.ConsecutiveCorrect, saved.Word.LastReviewedAt, saved.Word.Revision, saved.Word.Translation));
        Assert.Equal((WriteOutcome.Created, saved.Word.Id), (saved.Example!.Outcome, saved.Example.Row!.WordId));
        Assert.Equal("A quiver of arrows.", Assert.Single((await _repo.GetWordAsync(user, saved.Word.Id, Ct))!.Examples).Sentence);
    }

    // Plan §4.4: one card per word across books; saving it again from a second book only adds the example.
    [Fact]
    public async Task SaveWordAsync_SameKeyWithAnotherExample_KeepsOneCardItsScheduleAndAddsTheExample()
    {
        var user = await db.NewReaderAsync();
        var card = (await _repo.SaveWordAsync(Word(user, "колчан"), Example(user, "Sentence A."), Ct)).Word;
        await _repo.RecordReviewAsync(Review(card), DueAt(Noon.AddDays(1)), Ct);
        var reviewed = (await _repo.GetWordAsync(user, card.Id, Ct))!;

        var again = await _repo.SaveWordAsync(Word(user, "колчан"), Example(user, "Sentence B."), Ct);

        Assert.Equal((WordSaveOutcome.Existing, card.Id), (again.Outcome, again.Word.Id));
        Assert.Equal((reviewed.Stage, reviewed.IntervalDays, reviewed.ConsecutiveCorrect, reviewed.NextReviewAt, reviewed.LastReviewedAt, reviewed.Revision),
            (again.Word.Stage, again.Word.IntervalDays, again.Word.ConsecutiveCorrect, again.Word.NextReviewAt, again.Word.LastReviewedAt, again.Word.Revision));
        Assert.Equal(1, reviewed.Stage);
        Assert.Equal(WriteOutcome.Created, again.Example!.Outcome);
        Assert.Equal(["Sentence A.", "Sentence B."], (await _repo.GetWordAsync(user, card.Id, Ct))!.Examples.Select(e => e.Sentence));
        Assert.Equal(1L, await CountAsync("vocabulary_words", user));
    }

    [Fact]
    public async Task SaveWordAsync_CardWithoutTranslation_FillsItAndBumpsUpdatedAtNotRevision()
    {
        var card = await SavedWordAsync();

        var again = await _repo.SaveWordAsync(Word(card.UserId, "колчан"), null, Ct);

        Assert.Equal((WordSaveOutcome.Existing, card.Id, "колчан", 1L), (again.Outcome, again.Word.Id, again.Word.Translation, again.Word.Revision));
        Assert.True(again.Word.UpdatedAt > card.UpdatedAt);
    }

    [Fact]
    public async Task SaveWordAsync_NewDefinitionAndDifferentTranslation_FillsTheDefinitionKeepsTheTranslation()
    {
        var card = await SavedWordAsync(translation: "колчан");

        var again = await _repo.SaveWordAsync(Word(card.UserId, "сагайдак", "a case for arrows"), null, Ct);

        Assert.Equal(("колчан", "a case for arrows"), (again.Word.Translation, again.Word.Definition));
    }

    [Fact]
    public async Task SaveWordAsync_DeletedCard_ReturnsTheTombstoneUnchangedAndAddsNoExample()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var again = await _repo.SaveWordAsync(Word(card.UserId, "колчан"), Example(card.UserId, "Too late."), Ct);

        Assert.Equal((WordSaveOutcome.Deleted, card.Id, (string?)null, 2L), (again.Outcome, again.Word.Id, again.Word.Translation, again.Word.Revision));
        Assert.NotNull(again.Word.DeletedAt);
        Assert.Null(again.Example);
        Assert.Equal(0L, await CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task SaveWordAsync_ExampleNamingAnotherUser_Throws()
    {
        var user = await db.NewReaderAsync();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _repo.SaveWordAsync(Word(user), Example(Guid.NewGuid(), "Whose?"), Ct));
    }

    [Fact]
    public async Task SaveWordAsync_ExampleFromAFileOfAnotherBook_IsRefusedAndSavesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = new Book { Id = Guid.NewGuid(), UserId = book.UserId, Title = "Another book" };
        other = await new LibraryRepository(db.DataSource).ImportAsync(other, NewFile(book.UserId, other.Id), Ct);
        var example = Example(book.UserId, "A quiver of arrows.");
        example.BookId = book.Id;
        example.FileId = other.CurrentFile!.Id;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveWordAsync(Word(book.UserId), example, Ct));

        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_book_files_user_id_book_id_file_id"),
            (error.SqlState, error.ConstraintName));
        Assert.Equal(0L, await CountAsync("vocabulary_words", book.UserId)); // the card went with the transaction
    }

    [Fact]
    public async Task UpdateWordAsync_MatchingRevision_ChangesTranslationAndDefinition()
    {
        var card = await SavedWordAsync(translation: "колчан");

        var result = await _repo.UpdateWordAsync(card.UserId, card.Id, "сагайдак", "a case for arrows", 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal(("сагайдак", "a case for arrows", 2L), (result.Current!.Translation, result.Current.Definition, result.Current.Revision));
    }

    [Fact]
    public async Task UpdateWordAsync_StaleRevision_LosesAndReturnsTheStoredCard()
    {
        var card = await SavedWordAsync(translation: "колчан");
        await _repo.UpdateWordAsync(card.UserId, card.Id, "winner", null, 1, Ct);

        var result = await _repo.UpdateWordAsync(card.UserId, card.Id, "stale", null, 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal(("winner", 2L), (result.Current!.Translation, result.Current.Revision));
    }

    [Fact]
    public async Task UpdateWordAsync_DeletedCardWithItsCurrentRevision_Loses()
    {
        var card = await SavedWordAsync(translation: "колчан");
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var result = await _repo.UpdateWordAsync(card.UserId, card.Id, "revived", null, 2, Ct);

        Assert.False(result.Accepted);
        Assert.Equal("колчан", result.Current!.Translation);
    }

    [Fact]
    public async Task DeleteWordAsync_LiveCard_TombstonesItOnceAndBumpsTheRevision()
    {
        var card = await SavedWordAsync();

        Assert.True(await _repo.DeleteWordAsync(card.UserId, card.Id, Ct));
        Assert.False(await _repo.DeleteWordAsync(card.UserId, card.Id, Ct));

        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((2L, true), (read.Revision, read.DeletedAt is not null));
    }

    [Fact]
    public async Task RestoreWordAsync_DeletedCard_BringsItBackOnceAndBumpsTheRevision()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        Assert.True(await _repo.RestoreWordAsync(card.UserId, card.Id, Ct));
        Assert.False(await _repo.RestoreWordAsync(card.UserId, card.Id, Ct));

        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((3L, (DateTimeOffset?)null), (read.Revision, read.DeletedAt));
    }

    [Fact]
    public async Task GetWordAsync_CardWithADeletedExample_ReturnsLiveExamplesOldestFirst()
    {
        var card = await SavedWordAsync();
        var first = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "First.")), Ct)).Row!;
        var deleted = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Deleted.")), Ct)).Row!;
        var last = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Last.")), Ct)).Row!;
        // No repository method deletes an example yet; the column is there for the ETL and sync.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE vocabulary_examples SET deleted_at = now() WHERE id = @Id", deleted, cancellationToken: Ct));

        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;

        Assert.Equal([first.Id, last.Id], read.Examples.Select(e => e.Id));
    }

    [Fact]
    public async Task AddExampleAsync_NewOperation_IsCreatedAndBumpsTheCardsUpdatedAtNotRevision()
    {
        var card = await SavedWordAsync();
        var example = OnCard(card, Example(card.UserId, "A quiver of arrows."));

        var result = await _repo.AddExampleAsync(example, Ct);

        Assert.Equal((WriteOutcome.Created, example.Id, card.Id, example.PayloadSha256),
            (result.Outcome, result.Row!.Id, result.Row.WordId, result.Row.PayloadSha256));
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal(1L, read.Revision);
        Assert.True(read.UpdatedAt > card.UpdatedAt);
    }

    [Fact]
    public async Task AddExampleAsync_SameOperationSamePayload_ReplaysTheStoredRow()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Once.", operation)), Ct)).Row!;

        var retry = await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Once.", operation)), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Id), (retry.Outcome, retry.Row!.Id));
        Assert.Equal(1L, await CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_SameOperationDifferentPayload_ConflictsAndStoresNothing()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Once.", operation)), Ct)).Row!;

        var reused = await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Something else.", operation)), Ct);

        Assert.Equal((WriteOutcome.OperationConflict, first.Id, "Once."), (reused.Outcome, reused.Row!.Id, reused.Row.Sentence));
        Assert.Equal(1L, await CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_NewOperationOnADeletedCard_IsDeletedAndStoresNothing()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var result = await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "After the delete.")), Ct);

        Assert.Equal((WriteOutcome.Deleted, (VocabularyExample?)null), (result.Outcome, result.Row));
        Assert.Equal(0L, await CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_ReplayAfterTheCardWasDeleted_IsReplayed()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Once.", operation)), Ct)).Row!;
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var retry = await _repo.AddExampleAsync(OnCard(card, Example(card.UserId, "Once.", operation)), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task RecordReviewAsync_NewOperation_StoresTheReviewAndAppliesTheScheduleWithoutARevision()
    {
        var card = await SavedWordAsync();

        var result = await _repo.RecordReviewAsync(Review(card), DueAt(Noon.AddDays(1)), Ct);

        Assert.Equal((WriteOutcome.Created, 0, 1), (result.Outcome, result.Row!.StageBefore, result.Row.StageAfter));
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((1, 1m, 0, Noon.AddDays(1), (DateTimeOffset?)Noon, 1L),
            (read.Stage, read.IntervalDays, read.ConsecutiveCorrect, read.NextReviewAt, read.LastReviewedAt, read.Revision));
        Assert.True(read.UpdatedAt > card.UpdatedAt);
    }

    [Fact]
    public async Task RecordReviewAsync_ReplayedOperation_AppliesTheScheduleOnce()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = await _repo.RecordReviewAsync(Review(card, operation), DueAt(Noon.AddDays(1)), Ct);

        // The retry recomputed the schedule later; the stored one must not move.
        var retry = await _repo.RecordReviewAsync(Review(card, operation), DueAt(Noon.AddDays(2)), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Row!.Id), (retry.Outcome, retry.Row!.Id));
        Assert.Equal(1L, await CountAsync("vocabulary_reviews", card.UserId));
        Assert.Equal(Noon.AddDays(1), (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.NextReviewAt);
    }

    [Fact]
    public async Task RecordReviewAsync_SameOperationDifferentPayload_ConflictsAndLeavesTheSchedule()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        await _repo.RecordReviewAsync(Review(card, operation), DueAt(Noon.AddDays(1)), Ct);
        var wrong = Review(card, operation);
        wrong.IsCorrect = false;
        wrong.PayloadSha256 = Hash("wrong");

        var result = await _repo.RecordReviewAsync(wrong, DueAt(Noon.AddHours(12)), Ct);

        Assert.Equal((WriteOutcome.OperationConflict, true), (result.Outcome, result.Row!.IsCorrect));
        Assert.Equal(1L, await CountAsync("vocabulary_reviews", card.UserId));
        Assert.Equal(Noon.AddDays(1), (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.NextReviewAt);
    }

    [Fact]
    public async Task RecordReviewAsync_NewOperationOnADeletedCard_IsDeletedAndLeavesTheSchedule()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var result = await _repo.RecordReviewAsync(Review(card), DueAt(Noon.AddDays(1)), Ct);

        Assert.Equal((WriteOutcome.Deleted, (VocabularyReview?)null), (result.Outcome, result.Row));
        Assert.Equal(0L, await CountAsync("vocabulary_reviews", card.UserId));
        Assert.Equal(0, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.Stage);
    }

    // v2-sync-protocol.md principle 6: the idempotency check runs before the tombstone check.
    [Fact]
    public async Task RecordReviewAsync_ReplayAfterTheCardWasDeleted_IsReplayed()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = await _repo.RecordReviewAsync(Review(card, operation), DueAt(Noon.AddDays(1)), Ct);
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var retry = await _repo.RecordReviewAsync(Review(card, operation), DueAt(Noon.AddDays(2)), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Row!.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task ListDueAsync_MixedCards_ReturnsLiveDueCardsEarliestFirstUpToTheLimit()
    {
        var user = await db.NewReaderAsync();
        async Task<VocabularyWord> CardDueAtAsync(string key, DateTimeOffset due)
        {
            var card = (await _repo.SaveWordAsync(Word(user, key: key), null, Ct)).Word;
            await _repo.RecordReviewAsync(Review(card), DueAt(due), Ct);
            return card;
        }
        var later = await CardDueAtAsync("later", Noon.AddHours(-1));
        var earlier = await CardDueAtAsync("earlier", Noon.AddHours(-2));
        await CardDueAtAsync("future", Noon.AddHours(1));
        var deleted = await CardDueAtAsync("deleted", Noon.AddHours(-3));
        await _repo.DeleteWordAsync(user, deleted.Id, Ct);

        Assert.Equal([earlier.Id, later.Id], (await _repo.ListDueAsync(user, Noon, 10, Ct)).Select(w => w.Id));
        Assert.Equal([earlier.Id], (await _repo.ListDueAsync(user, Noon, 1, Ct)).Select(w => w.Id));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task SaveWordAsync_KeyAliceAlsoHas_GivesBobHisOwnCardEveryTime()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();

        var first = await _repo.SaveWordAsync(Word(bob, "колчан"), null, Ct);
        var again = await _repo.SaveWordAsync(Word(bob, "колчан"), null, Ct); // nothing to fill: read back by key

        Assert.Equal(WordSaveOutcome.Created, first.Outcome);
        Assert.NotEqual(alices.Id, first.Word.Id);
        Assert.Equal((first.Word.Id, bob), (again.Word.Id, again.Word.UserId));
        Assert.Null((await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.Translation);
    }

    [Fact]
    public async Task UpdateWordAsync_AlicesCardAsBob_LosesAndChangesNothing()
    {
        var alices = await SavedWordAsync(translation: "колчан");
        var bob = await db.NewReaderAsync();

        var result = await _repo.UpdateWordAsync(bob, alices.Id, "bob's", null, 1, Ct);

        Assert.Equal((false, (VocabularyWord?)null), (result.Accepted, result.Current));
        Assert.Equal("колчан", (await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.Translation);
    }

    [Fact]
    public async Task DeleteWordAsync_AlicesCardAsBob_ReturnsFalseAndKeepsItLive()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();

        Assert.False(await _repo.DeleteWordAsync(bob, alices.Id, Ct));
        Assert.Null((await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.DeletedAt);
    }

    [Fact]
    public async Task RestoreWordAsync_AlicesDeletedCardAsBob_ReturnsFalseAndKeepsItDeleted()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();
        await _repo.DeleteWordAsync(alices.UserId, alices.Id, Ct);

        Assert.False(await _repo.RestoreWordAsync(bob, alices.Id, Ct));
        Assert.NotNull((await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.DeletedAt);
    }

    [Fact]
    public async Task GetWordAsync_AlicesCardAsBob_ReturnsNull()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.GetWordAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task AddExampleAsync_AlicesCardAsBob_IsRefusedByTheForeignKey()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();

        var error = await Assert.ThrowsAsync<PostgresException>(() =>
            _repo.AddExampleAsync(OnCard(alices, Example(bob, "Bob's sentence.")), Ct));

        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_vocabulary_words_user_id_word_id"),
            (error.SqlState, error.ConstraintName));
        Assert.Empty((await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.Examples);
    }

    [Fact]
    public async Task AddExampleAsync_AlicesBookOnBobsCard_IsRefusedByTheDeferredForeignKey()
    {
        var alicesBook = await db.NewReaderWithBookAsync();
        var bobs = await SavedWordAsync();
        var example = OnCard(bobs, Example(bobs.UserId, "From her book."));
        example.BookId = alicesBook.Id;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AddExampleAsync(example, Ct));

        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_books_user_id_book_id"),
            (error.SqlState, error.ConstraintName));
        Assert.Equal(0L, await CountAsync("vocabulary_examples", bobs.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_OperationIdAliceAlsoUsed_ReplaysBobsOwnExample()
    {
        var operation = Guid.NewGuid();
        var alices = await SavedWordAsync();
        await _repo.AddExampleAsync(OnCard(alices, Example(alices.UserId, "Hers.", operation)), Ct);
        var bobs = await SavedWordAsync();
        var created = await _repo.AddExampleAsync(OnCard(bobs, Example(bobs.UserId, "His.", operation)), Ct);

        var retry = await _repo.AddExampleAsync(OnCard(bobs, Example(bobs.UserId, "His.", operation)), Ct);

        Assert.Equal(WriteOutcome.Created, created.Outcome);
        Assert.Equal((WriteOutcome.Replayed, created.Row!.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task RecordReviewAsync_AlicesCardAsBob_IsRefusedAndHerScheduleStays()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();
        var review = Review(alices);
        review.UserId = bob;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.RecordReviewAsync(review, DueAt(Noon), Ct));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        var read = (await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal((0, alices.UpdatedAt), (read.Stage, read.UpdatedAt));
    }

    [Fact]
    public async Task RecordReviewAsync_OperationIdAliceAlsoUsed_ReplaysBobsOwnReview()
    {
        var operation = Guid.NewGuid();
        var alices = await SavedWordAsync();
        await _repo.RecordReviewAsync(Review(alices, operation), DueAt(Noon), Ct);
        var bobs = await SavedWordAsync();
        var created = await _repo.RecordReviewAsync(Review(bobs, operation), DueAt(Noon), Ct);

        var retry = await _repo.RecordReviewAsync(Review(bobs, operation), DueAt(Noon), Ct);

        Assert.Equal(WriteOutcome.Created, created.Outcome);
        Assert.Equal((WriteOutcome.Replayed, created.Row!.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task ListDueAsync_AlicesDueCardsAsBob_ReturnsEmpty()
    {
        await SavedWordAsync(); // due at creation
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _repo.ListDueAsync(bob, DateTimeOffset.UtcNow.AddMinutes(1), 10, Ct));
    }
}
