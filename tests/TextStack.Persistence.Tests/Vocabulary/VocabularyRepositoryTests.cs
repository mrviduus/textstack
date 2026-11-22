using Application.Common;
using Application.Vocabulary;
using Dapper;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Vocabulary;

// The deferred provenance FKs on vocabulary_examples need no SET CONSTRAINTS here: every repository
// write commits before the call returns, so a deferred check fails inside the call that broke it.
public class VocabularyRepositoryTests(PostgresFixture db)
{
    private readonly VocabularyRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DateTimeOffset Noon = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    private static VocabularyWord Word(Guid userId, string? translation = null, string key = "quiver") => NewWord(userId, key, translation);

    private static VocabularyExample Example(VocabularyWord card, string sentence, Guid? operationId = null) => NewExample(card, sentence, operationId);

    /// <summary>A correct answer to the card, recorded at noon.</summary>
    private static VocabularyReview Review(VocabularyWord card, Guid? operationId = null) => new()
    {
        Id = Guid.NewGuid(),
        UserId = card.UserId,
        WordId = card.Id,
        OperationId = operationId ?? Guid.NewGuid(),
        PayloadSha256 = PayloadSha256("correct"),
        ReviewMode = "multiple_choice",
        IsCorrect = true,
        ResponseTimeMs = 900,
        ClientRecordedAt = Noon,
    };

    /// <summary>A schedule that moves the card one stage up, due <paramref name="intervalDays"/> later.</summary>
    private static Func<VocabularyWord, ReviewSchedule> NextStage(decimal intervalDays = 1m) =>
        card => new ReviewSchedule(card.Stage + 1, intervalDays, 0, Retire: false);

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

    // Plan §4.4: one card per word across books; v2-sync-protocol.md: translation and definition are used
    // only when the card is created.
    [Fact]
    public async Task SaveWordAsync_SameWordSavedTwice_KeepsOneCardItsScheduleAndFirstTranslation()
    {
        var user = await db.NewReaderAsync();

        var saved = await _repo.SaveWordAsync(user, Word(user, "колчан"), Ct);
        var card = saved.Word!;
        Assert.Equal(WordSaveOutcome.Created, saved.Outcome);
        Assert.Equal((0, 0m, 0, (DateTimeOffset?)null, 1L, "колчан"),
            (card.Stage, card.IntervalDays, card.ConsecutiveCorrect, card.LastReviewedAt, card.Revision, card.Translation));

        // Saved again before anything else: the stored card, untouched (not even updated_at).
        var untouched = await _repo.SaveWordAsync(user, Word(user, "сагайдак"), Ct);
        Assert.Equal((WordSaveOutcome.Existing, card.Id, "колчан", 1L, card.UpdatedAt),
            (untouched.Outcome, untouched.Word!.Id, untouched.Word.Translation, untouched.Word.Revision, untouched.Word.UpdatedAt));

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

        // A card saved with no translation keeps none when saved again with one.
        var bare = await SavedWordAsync(user, key: "bow");
        var bareAgain = await _repo.SaveWordAsync(user, Word(user, "лук", "bow"), Ct);
        Assert.Equal((WordSaveOutcome.Existing, bare.Id, (string?)null, 1L, bare.UpdatedAt),
            (bareAgain.Outcome, bareAgain.Word!.Id, bareAgain.Word.Translation, bareAgain.Word.Revision, bareAgain.Word.UpdatedAt));

        // A client id that already names another of the reader's cards writes nothing.
        var clash = Word(user, key: "arrow");
        clash.Id = card.Id;
        var conflict = await _repo.SaveWordAsync(user, clash, Ct);
        Assert.Equal((WordSaveOutcome.IdConflict, (VocabularyWord?)null), (conflict.Outcome, conflict.Word));
        Assert.Equal(2L, await db.CountAsync("vocabulary_words", user));
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

    // updated_at is the sync feed's watermark: every revisioned write must move it.
    [Fact]
    public async Task UpdateDeleteAndRestoreWordAsync_EditedFromTwoDevicesThenDeletedAndRestored_StaleRevisionsLose()
    {
        var card = await SavedWordAsync(translation: "колчан");
        var user = card.UserId;

        // Phone and laptop both edit revision 1: the first wins, the second gets the stored card back.
        var phone = await _repo.UpdateWordAsync(user, card.Id, "сагайдак", "a case for arrows", 1, Ct);
        var laptop = await _repo.UpdateWordAsync(user, card.Id, "stale", null, 1, Ct);
        Assert.True(phone.Accepted);
        Assert.Equal(("сагайдак", "a case for arrows", 2L), (phone.Current!.Translation, phone.Current.Definition, phone.Current.Revision));
        Assert.False(laptop.Accepted);
        Assert.Equal(("сагайдак", 2L), (laptop.Current!.Translation, laptop.Current.Revision));
        Assert.True(phone.Current.UpdatedAt > card.UpdatedAt, "update");

        // Deleted once: a tombstone at revision 3; the second delete finds nothing live.
        Assert.True(await _repo.DeleteWordAsync(user, card.Id, Ct));
        Assert.False(await _repo.DeleteWordAsync(user, card.Id, Ct));
        var deleted = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal((3L, true), (deleted.Revision, deleted.DeletedAt is not null));
        Assert.True(deleted.UpdatedAt > phone.Current.UpdatedAt, "delete");

        // The tombstone wins over an edit at its own revision and over a fresh save of the word.
        var revived = await _repo.UpdateWordAsync(user, card.Id, "revived", null, 3, Ct);
        Assert.Equal((false, "сагайдак"), (revived.Accepted, revived.Current!.Translation));
        var resaved = await _repo.SaveWordAsync(user, Word(user, "колчан"), Ct);
        Assert.Equal((WordSaveOutcome.Deleted, card.Id, "сагайдак", 3L), (resaved.Outcome, resaved.Word!.Id, resaved.Word.Translation, resaved.Word.Revision));
        Assert.NotNull(resaved.Word.DeletedAt);

        // A restore at a stale revision loses; at the tombstone's revision it brings the card back once.
        var stale = await _repo.RestoreWordAsync(user, card.Id, 2, Ct);
        Assert.Equal((false, 3L), (stale.Accepted, stale.Current!.Revision));
        Assert.NotNull((await _repo.GetWordAsync(user, card.Id, Ct))!.DeletedAt);

        var restored = await _repo.RestoreWordAsync(user, card.Id, 3, Ct);
        var again = await _repo.RestoreWordAsync(user, card.Id, 4, Ct); // live now: nothing to restore
        Assert.Equal((true, 4L, (DateTimeOffset?)null), (restored.Accepted, restored.Current!.Revision, restored.Current.DeletedAt));
        Assert.Equal((false, 4L), (again.Accepted, again.Current!.Revision));
        Assert.True(restored.Current.UpdatedAt > deleted.UpdatedAt, "restore");
    }

    // v2-sync-protocol.md principle 6: the idempotency check runs before the tombstone check.
    [Fact]
    public async Task AddExampleAsync_ReaderCollectsSentencesThenDeletesTheCard_ReplaysOnceAndRefusesNewOnes()
    {
        var book = await db.NewReaderWithBookAsync();
        var card = await SavedWordAsync(book.UserId);
        var user = card.UserId;
        var operation = Guid.NewGuid();

        // A new sentence moves the card's updated_at, not its revision.
        var example = Example(card, "A quiver of arrows.", operation);
        var first = await _repo.AddExampleAsync(user, example, Ct);
        Assert.Equal((WriteOutcome.Created, example.Id, card.Id, example.PayloadSha256),
            (first.Outcome, first.Row!.Id, first.Row.WordId, first.Row.PayloadSha256));
        var touched = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal(1L, touched.Revision);
        Assert.True(touched.UpdatedAt > card.UpdatedAt);

        // The retry replays the stored row and leaves the card; a reused operation id with another sentence conflicts.
        var retry = await AddAsync(card, "A quiver of arrows.", operation);
        Assert.Equal((WriteOutcome.Replayed, first.Row.Id), (retry.Outcome, retry.Row!.Id));
        Assert.Equal(touched.UpdatedAt, (await _repo.GetWordAsync(user, card.Id, Ct))!.UpdatedAt);
        var reused = await AddAsync(card, "Something else.", operation);
        Assert.Equal((WriteOutcome.OperationConflict, first.Row.Id, "A quiver of arrows."), (reused.Outcome, reused.Row!.Id, reused.Row.Sentence));
        Assert.Equal(1L, await db.CountAsync("vocabulary_examples", user));

        // A sentence naming a file of another of the reader's books is refused by the deferred FK.
        var other = await db.NewBookAsync(user, "Another book");
        var crossed = Example(card, "From the wrong file.");
        crossed.BookId = book.Id;
        crossed.FileId = other.CurrentFile!.Id;
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AddExampleAsync(user, crossed, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_book_files_user_id_book_id_file_id"),
            (error.SqlState, error.ConstraintName));

        // A deleted example drops out of the card; the live ones read oldest first.
        var deletedExample = (await AddAsync(card, "Deleted.")).Row!;
        var last = (await AddAsync(card, "Last.")).Row!;
        // No repository method deletes an example yet; the column is there for the ETL and sync.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE vocabulary_examples SET deleted_at = now() WHERE id = @Id", deletedExample, cancellationToken: Ct));
        Assert.Equal([first.Row.Id, last.Id], (await _repo.GetWordAsync(user, card.Id, Ct))!.Examples.Select(e => e.Id));

        // Card deleted: a new sentence is refused, the old retry still replays.
        await _repo.DeleteWordAsync(user, card.Id, Ct);
        var afterDelete = await AddAsync(card, "After the delete.");
        Assert.Equal((WriteOutcome.Deleted, (VocabularyExample?)null), (afterDelete.Outcome, afterDelete.Row));
        Assert.Equal(3L, await db.CountAsync("vocabulary_examples", user));
        var lateRetry = await AddAsync(card, "A quiver of arrows.", operation);
        Assert.Equal((WriteOutcome.Replayed, first.Row.Id), (lateRetry.Outcome, lateRetry.Row!.Id));
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
        await db.WaitUntilBlockedByAsync(conn, add);
        await delete.CommitAsync(Ct);

        Assert.Equal(WriteOutcome.Deleted, (await add).Outcome);
        Assert.Equal(0L, await db.CountAsync("vocabulary_examples", card.UserId));
    }

    // v2-sync-protocol.md principle 6: the idempotency check runs before the tombstone check.
    [Fact]
    public async Task RecordReviewAsync_ReaderAnswersRetriesAndAnswersOffline_SchedulesEachAnswerOnce()
    {
        var card = await SavedWordAsync();
        var user = card.UserId;
        var operation = Guid.NewGuid();

        // The answer moves the card one stage, scheduled from the server's clock, with no revision bump.
        var first = await ReviewAsync(card, operation);
        Assert.Equal((WriteOutcome.Created, 0, 1), (first.Outcome, first.Row!.StageBefore, first.Row.StageAfter));
        var reviewed = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal((1, 1m, 0, (DateTimeOffset?)Noon, 1L),
            (reviewed.Stage, reviewed.IntervalDays, reviewed.ConsecutiveCorrect, reviewed.LastReviewedAt, reviewed.Revision));
        // One statement, one now(): due exactly one interval after the card's new updated_at.
        Assert.Equal(reviewed.UpdatedAt.AddDays(1), reviewed.NextReviewAt);
        Assert.True(reviewed.UpdatedAt > card.UpdatedAt);

        // The retry replays and applies no second schedule; the same operation with another answer conflicts.
        var retry = await _repo.RecordReviewAsync(user, Review(card, operation), NextStage(5m), Ct);
        Assert.Equal((WriteOutcome.Replayed, first.Row.Id), (retry.Outcome, retry.Row!.Id));
        var wrong = Review(card, operation);
        wrong.IsCorrect = false;
        wrong.PayloadSha256 = PayloadSha256("wrong");
        var conflict = await _repo.RecordReviewAsync(user, wrong, NextStage(5m), Ct);
        Assert.Equal((WriteOutcome.OperationConflict, true), (conflict.Outcome, conflict.Row!.IsCorrect));
        var read = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal((1, reviewed.NextReviewAt, reviewed.UpdatedAt), (read.Stage, read.NextReviewAt, read.UpdatedAt));
        Assert.Equal(1L, await db.CountAsync("vocabulary_reviews", user));

        // An answer recorded offline yesterday arrives now: last_reviewed_at stays the latest.
        var offline = Review(card);
        offline.ClientRecordedAt = Noon.AddDays(-1);
        await _repo.RecordReviewAsync(user, offline, NextStage(), Ct);
        var later = (await _repo.GetWordAsync(user, card.Id, Ct))!;
        Assert.Equal((2, (DateTimeOffset?)Noon), (later.Stage, later.LastReviewedAt));

        // Card deleted: a new answer is refused without computing a schedule; the old retry still replays.
        await _repo.DeleteWordAsync(user, card.Id, Ct);
        var afterDelete = await _repo.RecordReviewAsync(user, Review(card), NeverCalled, Ct);
        Assert.Equal((WriteOutcome.Deleted, (VocabularyReview?)null), (afterDelete.Outcome, afterDelete.Row));
        Assert.Equal(2L, await db.CountAsync("vocabulary_reviews", user));
        Assert.Equal(2, (await _repo.GetWordAsync(user, card.Id, Ct))!.Stage);
        var lateRetry = await _repo.RecordReviewAsync(user, Review(card, operation), NeverCalled, Ct);
        Assert.Equal((WriteOutcome.Replayed, first.Row.Id), (lateRetry.Outcome, lateRetry.Row!.Id));
    }

    // Owner decision 1: a mastered word is retired, not deleted, and other devices see it by revision.
    [Fact]
    public async Task RecordReviewAsync_FutureDatedAnswerMastersTheWord_RetiresItOnceOnTheServersClock()
    {
        var card = await SavedWordAsync();
        var future = Review(card);
        future.ClientRecordedAt = DateTimeOffset.MaxValue.AddDays(-1);
        Func<VocabularyWord, ReviewSchedule> mastered = c => new ReviewSchedule(c.Stage + 1, 1m, 0, Retire: true);

        await _repo.RecordReviewAsync(card.UserId, future, mastered, Ct);
        var retired = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;
        // Mastered again: still retired once, at the first time, with one revision bump.
        await _repo.RecordReviewAsync(card.UserId, Review(card), mastered, Ct);
        var reviewedAgain = (await _repo.GetWordAsync(card.UserId, card.Id, Ct))!;

        Assert.Equal(retired.UpdatedAt, retired.LastReviewedAt); // one statement, one now()
        Assert.Equal((2L, retired.UpdatedAt, (DateTimeOffset?)null), (retired.Revision, retired.RetiredAt!.Value, retired.DeletedAt));
        Assert.Equal((2L, retired.RetiredAt), (reviewedAgain.Revision, reviewedAgain.RetiredAt));
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

    // Bob, holding Alice's ids and operation ids, never reads, changes or deletes her rows,
    // and rows he sends naming her land under him.
    [Fact]
    public async Task EveryMethod_AnotherReaderHoldingAlicesIds_CanReadAndChangeNoneOfAlicesWords()
    {
        var alices = await SavedWordAsync(translation: "колчан");
        var alice = alices.UserId;
        var bob = await db.NewReaderAsync();
        var operation = Guid.NewGuid();
        await AddAsync(alices, "Hers.", operation);
        await ReviewAsync(alices, operation);
        var hers = (await _repo.GetWordAsync(alice, alices.Id, Ct))!;

        // Reads, edits, deletes and restores of her card: nothing, and nothing changes.
        Assert.Null(await _repo.GetWordAsync(bob, alices.Id, Ct));
        var update = await _repo.UpdateWordAsync(bob, alices.Id, "bob's", null, 1, Ct);
        Assert.Equal((false, (VocabularyWord?)null), (update.Accepted, update.Current));
        Assert.False(await _repo.DeleteWordAsync(bob, alices.Id, Ct));

        var example = Example(alices, "Bob's sentence.");
        example.UserId = bob;
        var add = await _repo.AddExampleAsync(bob, example, Ct);
        Assert.Equal((WriteOutcome.NotFound, (VocabularyExample?)null), (add.Outcome, add.Row));
        var review = Review(alices);
        review.UserId = bob;
        var answer = await _repo.RecordReviewAsync(bob, review, NeverCalled, Ct);
        Assert.Equal((WriteOutcome.NotFound, (VocabularyReview?)null), (answer.Outcome, answer.Row));

        var after = (await _repo.GetWordAsync(alice, alices.Id, Ct))!;
        Assert.Equal(("колчан", (DateTimeOffset?)null, hers.Stage, hers.UpdatedAt, 1),
            (after.Translation, after.DeletedAt, after.Stage, after.UpdatedAt, after.Examples.Count));

        await _repo.DeleteWordAsync(alice, alices.Id, Ct);
        var restore = await _repo.RestoreWordAsync(bob, alices.Id, 2, Ct);
        Assert.Equal((false, (VocabularyWord?)null), (restore.Accepted, restore.Current));
        Assert.NotNull((await _repo.GetWordAsync(alice, alices.Id, Ct))!.DeletedAt);

        // The same key gives Bob his own card, every time.
        var bobsSave = await _repo.SaveWordAsync(bob, Word(bob, "сагайдак"), Ct);
        var bobsAgain = await _repo.SaveWordAsync(bob, Word(bob, "сагайдак"), Ct); // read back by key
        var bobs = bobsSave.Word!;
        Assert.Equal(WordSaveOutcome.Created, bobsSave.Outcome);
        Assert.NotEqual(alices.Id, bobs.Id);
        Assert.Equal((bobs.Id, bob), (bobsAgain.Word!.Id, bobsAgain.Word.UserId));

        // Her operation ids are his to use: created, then replayed as his own rows.
        var bobsExample = await AddAsync(bobs, "His.", operation);
        var bobsExampleRetry = await AddAsync(bobs, "His.", operation);
        Assert.Equal(WriteOutcome.Created, bobsExample.Outcome);
        Assert.Equal((WriteOutcome.Replayed, bobsExample.Row!.Id), (bobsExampleRetry.Outcome, bobsExampleRetry.Row!.Id));
        var bobsReview = await ReviewAsync(bobs, operation);
        var bobsReviewRetry = await ReviewAsync(bobs, operation);
        Assert.Equal(WriteOutcome.Created, bobsReview.Outcome);
        Assert.Equal((WriteOutcome.Replayed, bobsReview.Row!.Id), (bobsReviewRetry.Outcome, bobsReviewRetry.Row!.Id));

        // Her book on his card is refused by the deferred FK.
        var alicesBook = await db.NewReaderWithBookAsync();
        var fromHerBook = Example(bobs, "From her book.");
        fromHerBook.BookId = alicesBook.Id;
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.AddExampleAsync(bob, fromHerBook, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_vocabulary_examples_books_user_id_book_id"),
            (error.SqlState, error.ConstraintName));

        // Rows Alice sends naming Bob land under her.
        var namingBob = Word(bob, key: "arrow");
        var aliceSaves = await _repo.SaveWordAsync(alice, namingBob, Ct);
        Assert.Equal((WordSaveOutcome.Created, alice), (aliceSaves.Outcome, aliceSaves.Word!.UserId));
        var aliceExample = Example(aliceSaves.Word, "Whose?");
        aliceExample.UserId = bob;
        var aliceAdds = await _repo.AddExampleAsync(alice, aliceExample, Ct);
        Assert.Equal((WriteOutcome.Created, alice), (aliceAdds.Outcome, aliceAdds.Row!.UserId));
        var aliceReview = Review(aliceSaves.Word);
        aliceReview.UserId = bob;
        var aliceAnswers = await _repo.RecordReviewAsync(alice, aliceReview, NextStage(), Ct);
        Assert.Equal((WriteOutcome.Created, alice), (aliceAnswers.Outcome, aliceAnswers.Row!.UserId));

        Assert.Equal((1L, 1L, 1L), (await db.CountAsync("vocabulary_words", bob),
            await db.CountAsync("vocabulary_examples", bob), await db.CountAsync("vocabulary_reviews", bob)));
    }
}
