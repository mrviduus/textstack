using System.Security.Cryptography;
using System.Text;
using Application.Common;
using Application.Vocabulary;
using Dapper;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;

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

    private static VocabularyWord Word(Guid userId, string? translation = null, string key = "quiver") => new()
    {
        Id = Guid.NewGuid(),
        UserId = userId,
        Language = "en",
        Word = key,
        WordKey = key,
        Translation = translation,
    };

    /// <summary>An example for <paramref name="card"/>; its hash is of the sentence, so the same sentence replays.</summary>
    private static VocabularyExample Example(VocabularyWord card, string sentence, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = card.UserId,
        WordId = card.Id,
        Sentence = sentence,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = Hash(sentence),
    };

    /// <summary>A correct answer to the card, recorded at noon.</summary>
    private static VocabularyReview Review(VocabularyWord card, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = card.UserId,
        WordId = card.Id,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = Hash("correct"),
        ReviewMode = "multiple_choice",
        IsCorrect = true,
        ResponseTimeMs = 900,
        ClientRecordedAt = Noon,
    };

    /// <summary>A schedule that moves the card one stage up, due <paramref name="intervalDays"/> later.</summary>
    private static Func<VocabularyWord, ReviewSchedule> NextStage(decimal intervalDays = 1m) =>
        card => new ReviewSchedule(card.Stage + 1, intervalDays, 0);

    private static Func<VocabularyWord, ReviewSchedule> NeverCalled =>
        _ => throw new InvalidOperationException("The schedule must not be computed.");

    private Task<WriteResult<VocabularyReview>> ReviewAsync(VocabularyWord card, Guid? operationId = null) =>
        _repo.RecordReviewAsync(card.UserId, Review(card, operationId), NextStage(), Ct);

    private Task<WriteResult<VocabularyExample>> AddAsync(VocabularyWord card, string sentence, Guid? operationId = null) =>
        _repo.AddExampleAsync(card.UserId, Example(card, sentence, operationId), Ct);

    private async Task<VocabularyWord> SavedWordAsync(Guid? userId = null, string? translation = null, string key = "quiver")
    {
        var user = userId ?? await db.NewReaderAsync();
        return (await _repo.SaveWordAsync(user, Word(user, translation, key), Ct)).Word!;
    }

    [Fact]
    public async Task SaveWordAsync_NewWord_CreatesACardOnTheDefaultSchedule()
    {
        var user = await db.NewReaderAsync();

        var saved = await _repo.SaveWordAsync(user, Word(user, "колчан"), Ct);

        Assert.Equal(WordSaveOutcome.Created, saved.Outcome);
        Assert.Equal((0, 0m, 0, (DateTimeOffset?)null, 1L, "колчан"), (saved.Word!.Stage, saved.Word.IntervalDays,
            saved.Word.ConsecutiveCorrect, saved.Word.LastReviewedAt, saved.Word.Revision, saved.Word.Translation));
    }

    // Plan §4.4: one card per word across books; saving it again from a second book keeps the card,
    // and the second book's sentence is one more example on it.
    [Fact]
    public async Task SaveWordAsync_SameKeyAfterAReview_KeepsOneCardItsScheduleAndTranslationAndTakesASecondExample()
    {
        var user = await db.NewReaderAsync();
        var card = (await _repo.SaveWordAsync(user, Word(user, "колчан"), Ct)).Word!;
        await AddAsync(card, "Sentence A.");
        await ReviewAsync(card);
        var reviewed = (await _repo.GetWordAsync(user, card.Id, Ct))!;

        var again = await _repo.SaveWordAsync(user, Word(user, "сагайдак"), Ct);
        await AddAsync(again.Word!, "Sentence B.");

        var read = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal((WordSaveOutcome.Existing, card.Id), (again.Outcome, again.Word!.Id));
        Assert.Equal((reviewed.Stage, reviewed.IntervalDays, reviewed.ConsecutiveCorrect, reviewed.NextReviewAt, reviewed.LastReviewedAt, reviewed.Revision, "колчан"),
            (read.Stage, read.IntervalDays, read.ConsecutiveCorrect, read.NextReviewAt, read.LastReviewedAt, read.Revision, read.Translation));
        Assert.Equal(1, read.Stage);
        Assert.Equal(["Sentence A.", "Sentence B."], read.Examples.Select(e => e.Sentence));
        Assert.Equal(1L, await db.CountAsync("vocabulary_words", user));
    }

    // v2-sync-protocol.md: translation and definition are used only when the card is created.
    [Fact]
    public async Task SaveWordAsync_CardWithoutTranslation_LeavesItUnchanged()
    {
        var card = await SavedWordAsync();

        var again = await _repo.SaveWordAsync(card.UserId, Word(card.UserId, "колчан"), Ct);

        Assert.Equal((WordSaveOutcome.Existing, card.Id, (string?)null, 1L, card.UpdatedAt),
            (again.Outcome, again.Word!.Id, again.Word.Translation, again.Word.Revision, again.Word.UpdatedAt));
    }

    [Fact]
    public async Task SaveWordAsync_DeletedCard_ReturnsTheTombstoneUnchanged()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var again = await _repo.SaveWordAsync(card.UserId, Word(card.UserId, "колчан"), Ct);

        Assert.Equal((WordSaveOutcome.Deleted, card.Id, (string?)null, 2L), (again.Outcome, again.Word!.Id, again.Word.Translation, again.Word.Revision));
        Assert.NotNull(again.Word.DeletedAt);
    }

    [Fact]
    public async Task SaveWordAsync_SameSaveRetriedWhileTheFirstIsInFlight_StoresOneCardAndNeverThrows()
    {
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var user = await db.NewReaderAsync();
            var id = Guid.NewGuid();

            var saves = await Task.WhenAll(Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                var word = Word(user);
                word.Id = id;
                return _repo.SaveWordAsync(user, word, Ct);
            }, Ct)));

            Assert.All(saves, s => Assert.Equal(id, s.Word!.Id));
            Assert.Single(saves, s => s.Outcome == WordSaveOutcome.Created);
            Assert.Equal(1L, await db.CountAsync("vocabulary_words", user));
        }
    }

    [Fact]
    public async Task SaveWordAsync_ClientIdOfAnotherOwnCard_IsIdConflictAndWritesNothing()
    {
        var card = await SavedWordAsync();
        var clash = Word(card.UserId, key: "arrow");
        clash.Id = card.Id;

        var saved = await _repo.SaveWordAsync(card.UserId, clash, Ct);

        Assert.Equal((WordSaveOutcome.IdConflict, (VocabularyWord?)null), (saved.Outcome, saved.Word));
        Assert.Equal(1L, await db.CountAsync("vocabulary_words", card.UserId));
    }

    [Fact]
    public async Task SaveWordAsync_WordNamingAnotherUser_Throws()
    {
        var user = await db.NewReaderAsync();

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.SaveWordAsync(user, Word(Guid.NewGuid()), Ct));
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

    // updated_at is the sync feed's watermark: every revisioned write must move it.
    [Fact]
    public async Task UpdateWordAsyncDeleteWordAsyncAndRestoreWordAsync_LiveCard_EachMoveUpdatedAt()
    {
        var card = await SavedWordAsync();

        var updated = (await _repo.UpdateWordAsync(card.UserId, card.Id, "колчан", null, 1, Ct)).Current!;
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);
        var deleted = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        await _repo.RestoreWordAsync(card.UserId, card.Id, Ct);
        var restored = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;

        Assert.True(updated.UpdatedAt > card.UpdatedAt, "update");
        Assert.True(deleted.UpdatedAt > updated.UpdatedAt, "delete");
        Assert.True(restored.UpdatedAt > deleted.UpdatedAt, "restore");
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
        var first = (await AddAsync(card, "First.")).Row!;
        var deleted = (await AddAsync(card, "Deleted.")).Row!;
        var last = (await AddAsync(card, "Last.")).Row!;
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
        var example = Example(card, "A quiver of arrows.");

        var result = await _repo.AddExampleAsync(card.UserId, example, Ct);

        Assert.Equal((WriteOutcome.Created, example.Id, card.Id, example.PayloadSha256),
            (result.Outcome, result.Row!.Id, result.Row.WordId, result.Row.PayloadSha256));
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal(1L, read.Revision);
        Assert.True(read.UpdatedAt > card.UpdatedAt);
    }

    [Fact]
    public async Task AddExampleAsync_SameOperationSamePayload_ReplaysTheStoredRowAndLeavesTheCard()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await AddAsync(card, "Once.", operation)).Row!;
        var touched = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;

        var retry = await AddAsync(card, "Once.", operation);

        Assert.Equal((WriteOutcome.Replayed, first.Id), (retry.Outcome, retry.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("vocabulary_examples", card.UserId));
        Assert.Equal(touched.UpdatedAt, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.UpdatedAt);
    }

    [Fact]
    public async Task AddExampleAsync_SameOperationDifferentPayload_ConflictsAndStoresNothing()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await AddAsync(card, "Once.", operation)).Row!;

        var reused = await AddAsync(card, "Something else.", operation);

        Assert.Equal((WriteOutcome.OperationConflict, first.Id, "Once."), (reused.Outcome, reused.Row!.Id, reused.Row.Sentence));
        Assert.Equal(1L, await db.CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_NewOperationOnADeletedCard_IsDeletedAndStoresNothing()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var result = await AddAsync(card, "After the delete.");

        Assert.Equal((WriteOutcome.Deleted, (VocabularyExample?)null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("vocabulary_examples", card.UserId));
    }

    // v2-sync-protocol.md principle 6: the idempotency check runs before the tombstone check.
    [Fact]
    public async Task AddExampleAsync_ReplayAfterTheCardWasDeleted_IsReplayed()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = (await AddAsync(card, "Once.", operation)).Row!;
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var retry = await AddAsync(card, "Once.", operation);

        Assert.Equal((WriteOutcome.Replayed, first.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task AddExampleAsync_WhileADeleteIsInFlight_WaitsAndAnswersDeleted()
    {
        var card = await SavedWordAsync();
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await using var delete = await conn.BeginTransactionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE vocabulary_words SET deleted_at = now(), updated_at = now(), revision = revision + 1 WHERE id = @Id",
            card, delete, cancellationToken: Ct));

        var add = AddAsync(card, "Racing the delete.");
        // Commit only once the add is blocked on the card: without the card lock it would not wait,
        // would see the card live, and would store an example on a card deleted a moment later.
        await using (var observer = await db.DataSource.OpenConnectionAsync(Ct))
            for (var waited = 0; waited < 5000 && !add.IsCompleted; waited += 10)
            {
                if (await observer.ExecuteScalarAsync<bool>(new CommandDefinition(
                        "SELECT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock')",
                        cancellationToken: Ct)))
                    break;
                await Task.Delay(10, Ct);
            }
        await delete.CommitAsync(Ct);

        Assert.Equal(WriteOutcome.Deleted, (await add).Outcome);
        Assert.Equal(0L, await db.CountAsync("vocabulary_examples", card.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_ExampleFromAFileOfAnotherBook_IsRefusedByTheDeferredForeignKey()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = await db.NewBookAsync(book.UserId, "Another book");
        var card = await SavedWordAsync(book.UserId);
        var example = Example(card, "A quiver of arrows.");
        example.BookId = book.Id;
        example.FileId = other.CurrentFile!.Id;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AddExampleAsync(book.UserId, example, Ct));

        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_book_files_user_id_book_id_file_id"),
            (error.SqlState, error.ConstraintName));
        Assert.Equal(0L, await db.CountAsync("vocabulary_examples", book.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_ExampleNamingAnotherUser_Throws()
    {
        var card = await SavedWordAsync();

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.AddExampleAsync(Guid.NewGuid(), Example(card, "Whose?"), Ct));
    }

    [Fact]
    public async Task RecordReviewAsync_NewOperation_StoresTheStagesAndSchedulesFromTheServersClockWithoutARevision()
    {
        var card = await SavedWordAsync();

        var result = await ReviewAsync(card);

        Assert.Equal((WriteOutcome.Created, 0, 1), (result.Outcome, result.Row!.StageBefore, result.Row.StageAfter));
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((1, 1m, 0, (DateTimeOffset?)Noon, 1L),
            (read.Stage, read.IntervalDays, read.ConsecutiveCorrect, read.LastReviewedAt, read.Revision));
        // One statement, one now(): due exactly one interval after the card's new updated_at.
        Assert.Equal(read.UpdatedAt.AddDays(1), read.NextReviewAt);
        Assert.True(read.UpdatedAt > card.UpdatedAt);
    }

    [Fact]
    public async Task RecordReviewAsync_ReplayedOperation_AppliesTheScheduleOnce()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = await ReviewAsync(card, operation);
        var reviewed = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;

        var retry = await _repo.RecordReviewAsync(card.UserId, Review(card, operation), NextStage(5m), Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Row!.Id), (retry.Outcome, retry.Row!.Id));
        Assert.Equal(1L, await db.CountAsync("vocabulary_reviews", card.UserId));
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((1, reviewed.NextReviewAt, reviewed.UpdatedAt), (read.Stage, read.NextReviewAt, read.UpdatedAt));
    }

    [Fact]
    public async Task RecordReviewAsync_SameOperationDifferentPayload_ConflictsAndLeavesTheSchedule()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        await ReviewAsync(card, operation);
        var reviewed = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        var wrong = Review(card, operation);
        wrong.IsCorrect = false;
        wrong.PayloadSha256 = Hash("wrong");

        var result = await _repo.RecordReviewAsync(card.UserId, wrong, NextStage(5m), Ct);

        Assert.Equal((WriteOutcome.OperationConflict, true), (result.Outcome, result.Row!.IsCorrect));
        Assert.Equal(1L, await db.CountAsync("vocabulary_reviews", card.UserId));
        Assert.Equal(reviewed.NextReviewAt, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.NextReviewAt);
    }

    [Fact]
    public async Task RecordReviewAsync_NewOperationOnADeletedCard_IsDeletedAndLeavesTheSchedule()
    {
        var card = await SavedWordAsync();
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var result = await _repo.RecordReviewAsync(card.UserId, Review(card), NeverCalled, Ct);

        Assert.Equal((WriteOutcome.Deleted, (VocabularyReview?)null), (result.Outcome, result.Row));
        Assert.Equal(0L, await db.CountAsync("vocabulary_reviews", card.UserId));
        Assert.Equal(0, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.Stage);
    }

    // v2-sync-protocol.md principle 6: the idempotency check runs before the tombstone check.
    [Fact]
    public async Task RecordReviewAsync_ReplayAfterTheCardWasDeleted_IsReplayed()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();
        var first = await ReviewAsync(card, operation);
        await _repo.DeleteWordAsync(card.UserId, card.Id, Ct);

        var retry = await _repo.RecordReviewAsync(card.UserId, Review(card, operation), NeverCalled, Ct);

        Assert.Equal((WriteOutcome.Replayed, first.Row!.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task RecordReviewAsync_TwoAnswersInFlight_EachSchedulesFromTheOthersResult()
    {
        var card = await SavedWordAsync();

        var results = await Task.WhenAll(
            Task.Run(() => ReviewAsync(card), Ct),
            Task.Run(() => ReviewAsync(card), Ct));

        Assert.All(results, r => Assert.Equal(WriteOutcome.Created, r.Outcome));
        Assert.Equal([(0, 1), (1, 2)], results.Select(r => (r.Row!.StageBefore, r.Row.StageAfter)).Order());
        Assert.Equal(2, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.Stage);
    }

    [Fact]
    public async Task RecordReviewAsync_SameOperationTwiceInFlight_CreatesOnceAndAppliesTheWinnersSchedule()
    {
        var card = await SavedWordAsync();
        var operation = Guid.NewGuid();

        var results = await Task.WhenAll(
            Task.Run(() => _repo.RecordReviewAsync(card.UserId, Review(card, operation), NextStage(1m), Ct), Ct),
            Task.Run(() => _repo.RecordReviewAsync(card.UserId, Review(card, operation), NextStage(5m), Ct), Ct));

        Assert.Equal([WriteOutcome.Created, WriteOutcome.Replayed], results.Select(r => r.Outcome).Order());
        var winnersInterval = results[0].Outcome == WriteOutcome.Created ? 1m : 5m;
        var read = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        Assert.Equal((1, winnersInterval, read.UpdatedAt.AddDays((double)winnersInterval)), (read.Stage, read.IntervalDays, read.NextReviewAt));
        Assert.Equal(1L, await db.CountAsync("vocabulary_reviews", card.UserId));
    }

    [Fact]
    public async Task RecordReviewAsync_AnswerRecordedEarlierArrivingLater_KeepsTheLatestLastReviewedAt()
    {
        var card = await SavedWordAsync();
        await ReviewAsync(card);
        var offline = Review(card);
        offline.ClientRecordedAt = Noon.AddDays(-1);

        await _repo.RecordReviewAsync(card.UserId, offline, NextStage(), Ct);

        Assert.Equal(Noon, (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!.LastReviewedAt);
    }

    [Fact]
    public async Task RecordReviewAsync_ReviewNamingAnotherUser_Throws()
    {
        var card = await SavedWordAsync();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _repo.RecordReviewAsync(Guid.NewGuid(), Review(card), NeverCalled, Ct));
    }

    [Fact]
    public async Task ListDueAsync_MixedCards_ReturnsLiveDueCardsEarliestFirstUpToTheLimit()
    {
        var user = await db.NewReaderAsync();
        // Due times are the server's to set; the test pins them directly.
        async Task<VocabularyWord> CardDueAtAsync(string key, DateTimeOffset due)
        {
            var card = await SavedWordAsync(user, key: key);
            await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE vocabulary_words SET next_review_at = @due WHERE id = @Id", new { card.Id, due }, cancellationToken: Ct));
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

    [Fact]
    public async Task ListDueAsync_LimitOfZero_Throws()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _repo.ListDueAsync(Guid.NewGuid(), Noon, 0, Ct));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task SaveWordAsync_KeyAliceAlsoHas_GivesBobHisOwnCardEveryTime()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();

        var first = await _repo.SaveWordAsync(bob, Word(bob, "колчан"), Ct);
        var again = await _repo.SaveWordAsync(bob, Word(bob, "колчан"), Ct); // read back by key

        Assert.Equal(WordSaveOutcome.Created, first.Outcome);
        Assert.NotEqual(alices.Id, first.Word!.Id);
        Assert.Equal((first.Word.Id, bob), (again.Word!.Id, again.Word.UserId));
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
    public async Task AddExampleAsync_AlicesCardAsBob_IsNotFoundAndStoresNothing()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();
        var example = Example(alices, "Bob's sentence.");
        example.UserId = bob;

        var result = await _repo.AddExampleAsync(bob, example, Ct);

        Assert.Equal((WriteOutcome.NotFound, (VocabularyExample?)null), (result.Outcome, result.Row));
        Assert.Empty((await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!.Examples);
    }

    [Fact]
    public async Task AddExampleAsync_AlicesBookOnBobsCard_IsRefusedByTheDeferredForeignKey()
    {
        var alicesBook = await db.NewReaderWithBookAsync();
        var bobs = await SavedWordAsync();
        var example = Example(bobs, "From her book.");
        example.BookId = alicesBook.Id;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AddExampleAsync(bobs.UserId, example, Ct));

        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_books_user_id_book_id"),
            (error.SqlState, error.ConstraintName));
        Assert.Equal(0L, await db.CountAsync("vocabulary_examples", bobs.UserId));
    }

    [Fact]
    public async Task AddExampleAsync_OperationIdAliceAlsoUsed_ReplaysBobsOwnExample()
    {
        var operation = Guid.NewGuid();
        var alices = await SavedWordAsync();
        await AddAsync(alices, "Hers.", operation);
        var bobs = await SavedWordAsync();
        var created = await AddAsync(bobs, "His.", operation);

        var retry = await AddAsync(bobs, "His.", operation);

        Assert.Equal(WriteOutcome.Created, created.Outcome);
        Assert.Equal((WriteOutcome.Replayed, created.Row!.Id), (retry.Outcome, retry.Row!.Id));
    }

    [Fact]
    public async Task RecordReviewAsync_AlicesCardAsBob_IsNotFoundAndHerScheduleStays()
    {
        var alices = await SavedWordAsync();
        var bob = await db.NewReaderAsync();
        var review = Review(alices);
        review.UserId = bob;

        var result = await _repo.RecordReviewAsync(bob, review, NeverCalled, Ct);

        Assert.Equal((WriteOutcome.NotFound, (VocabularyReview?)null), (result.Outcome, result.Row));
        var read = (await _repo.GetWordAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal((0, alices.UpdatedAt), (read.Stage, read.UpdatedAt));
        Assert.Equal(0L, await db.CountAsync("vocabulary_reviews", bob));
    }

    [Fact]
    public async Task RecordReviewAsync_OperationIdAliceAlsoUsed_ReplaysBobsOwnReview()
    {
        var operation = Guid.NewGuid();
        var alices = await SavedWordAsync();
        await ReviewAsync(alices, operation);
        var bobs = await SavedWordAsync();
        var created = await ReviewAsync(bobs, operation);

        var retry = await ReviewAsync(bobs, operation);

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
