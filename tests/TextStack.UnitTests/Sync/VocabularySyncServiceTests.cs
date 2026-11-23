using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Vocabulary;
using Contracts.Sync;
using Domain.Vocabulary;
using NSubstitute;
using TextStack.Vocabulary;

namespace TextStack.UnitTests.Sync;

/// <summary>A reader's vocabulary cards synced by /me/v2 (v2-sync-protocol.md), and the server-side schedule (S3), on fakes.</summary>
public class VocabularySyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid CardId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>The user has <see cref="BookId"/>, whose one version is <see cref="FileId"/>; nothing else.</summary>
    private readonly ILibraryRepository _library = SyncFakes.Library(User, BookId, FileId);
    private readonly IVocabularyRepository _words = Substitute.For<IVocabularyRepository>();
    private readonly SteppedClock _clock = new() { Now = new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero) };
    private VocabularySyncService Service => new(new BookAccess(_library), _words, new SrsEngine(), _clock);

    private static VocabularyWord Card(long revision = 1, bool deleted = false) => new()
    {
        Id = CardId,
        UserId = User,
        Language = "en",
        Word = "Quiver",
        WordKey = "quiver",
        Translation = "колчан",
        Revision = revision,
        DeletedAt = deleted ? DateTimeOffset.UtcNow : null,
    };

    private static VocabularyExampleRequest Sentence(Guid? bookId = null, Guid? fileId = null) =>
        new(Guid.NewGuid(), "Her voice quivered.", null, bookId, fileId, null, null);

    private static SaveVocabularyWordRequest Save(VocabularyExampleRequest? example = null) =>
        new(Guid.NewGuid(), "en", "  Quiver ", "колчан", null, example);

    /// <summary>The repository holds <paramref name="card"/>: read with or without its examples.</summary>
    private void Stores(VocabularyWord card)
    {
        _words.GetWordAsync(User, card.Id, Arg.Any<CancellationToken>()).Returns(card);
        _words.GetCardAsync(User, card.Id, Arg.Any<CancellationToken>()).Returns(card);
    }

    private void Saves(WordSaveOutcome outcome, VocabularyWord? card)
    {
        _words.SaveWordAsync(User, Arg.Any<VocabularyWord>(), Arg.Any<CancellationToken>()).Returns(new SavedWord(outcome, card));
        if (card is not null) Stores(card);
    }

    /// <summary>Every example append answers <paramref name="outcome"/> with <paramref name="row"/> (else the example sent); the hashes sent are kept.</summary>
    private List<string> AddsExample(WriteOutcome outcome, VocabularyExample? row = null)
    {
        var hashes = new List<string>();
        _words.AddExampleAsync(User, Arg.Any<VocabularyExample>(), Arg.Any<CancellationToken>()).Returns(call =>
        {
            var sent = call.Arg<VocabularyExample>();
            hashes.Add(sent.PayloadSha256);
            return new WriteResult<VocabularyExample>(outcome, row ?? sent);
        });
        return hashes;
    }

    /// <summary>Every answer is recorded as <paramref name="outcome"/>; each review's hash and schedule are kept.</summary>
    private List<(string Sha256, Func<VocabularyWord, ReviewSchedule> Schedule)> RecordsReviews(WriteOutcome outcome)
    {
        var seen = new List<(string, Func<VocabularyWord, ReviewSchedule>)>();
        _words.RecordReviewAsync(User, Arg.Any<VocabularyReview>(), Arg.Any<Func<VocabularyWord, ReviewSchedule>>(), Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                var review = call.Arg<VocabularyReview>();
                seen.Add((review.PayloadSha256, call.Arg<Func<VocabularyWord, ReviewSchedule>>()));
                return new WriteResult<VocabularyReview>(outcome, review);
            });
        return seen;
    }

    private VocabularyReviewRequest Answer(bool isCorrect = true, DateTimeOffset? at = null, Guid? operationId = null) =>
        new(operationId ?? Guid.NewGuid(), CardId, "multiple_choice", isCorrect, null, at ?? _clock.Now);

    private static PatchVocabularyWordRequest Patch(long revision, string translationJson = "\"сагайдак\"", string? definitionJson = null) =>
        new(revision, JsonSerializer.Deserialize<JsonElement>(translationJson),
            definitionJson is null ? default : JsonSerializer.Deserialize<JsonElement>(definitionJson));

    private void Updates(bool accepted, VocabularyWord current) =>
        _words.UpdateWordAsync(User, CardId, Arg.Any<string?>(), Arg.Any<string?>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(new RevisionedWrite<VocabularyWord>(accepted, current));

    private void Restores(long expectedRevision, VocabularyWord? current, Guid? cardId = null) =>
        _words.RestoreWordAsync(User, cardId ?? CardId, expectedRevision, Arg.Any<CancellationToken>()).Returns(new RevisionedWrite<VocabularyWord>(false, current));

    private static VocabularyWordDto CardOf(SyncResult result) => Assert.IsType<VocabularyWordDto>(result.Body);

    [Fact]
    public async Task SaveWordAsync_NewWordTypedInCapitalsAndSpaces_IsCreatedUnderItsLowercaseKey()
    {
        Saves(WordSaveOutcome.Created, Card());

        var result = await Service.SaveWordAsync(User, Save() with { Language = " EN " }, Ct);

        Assert.Equal((201, (string?)null), (result.Status, CardOf(result).Example));
        await _words.Received(1).SaveWordAsync(User,
            Arg.Is<VocabularyWord>(c => c.WordKey == "quiver" && c.Word == "  Quiver " && c.Language == "en"), Arg.Any<CancellationToken>());
        // A card created without an example has none to load.
        await _words.DidNotReceiveWithAnyArgs().GetWordAsync(default, default, Ct);
    }

    // Principle 6: on a tombstone the example's operation is asked first; a replay answers 200, a new one 409 deleted.
    [Theory]
    [InlineData(WordSaveOutcome.Existing, null, 200, null, null)]
    [InlineData(WordSaveOutcome.Existing, WriteOutcome.Created, 200, null, "added")]
    [InlineData(WordSaveOutcome.Existing, WriteOutcome.Replayed, 200, null, "replayed")]
    [InlineData(WordSaveOutcome.Deleted, null, 409, SyncCodes.Deleted, null)]
    [InlineData(WordSaveOutcome.Deleted, WriteOutcome.Replayed, 200, null, "replayed")]
    [InlineData(WordSaveOutcome.Deleted, WriteOutcome.Deleted, 409, SyncCodes.Deleted, null)]
    public async Task SaveWordAsync_WordAlreadyOnACard_AnswersWithTheStoredCard(
        WordSaveOutcome saved, WriteOutcome? example, int status, string? code, string? said)
    {
        var deleted = saved == WordSaveOutcome.Deleted;
        Saves(saved, Card(revision: 4, deleted));
        if (example is { } outcome) AddsExample(outcome);

        var result = await Service.SaveWordAsync(User, Save(example is null ? null : Sentence(BookId, FileId)), Ct);

        Assert.Equal(status, result.Status);
        var card = code is null ? CardOf(result) : Assert.IsType<VocabularyWordDto>(SyncFakes.Error(result).Current);
        if (code is not null) Assert.Equal((code, 4L), (SyncFakes.Error(result).Code, SyncFakes.Error(result).Revision!.Value));
        Assert.Equal((CardId, 4L, deleted, said), (card.Id, card.Revision, card.DeletedAt is not null, card.Example));
        if (example is null) await _words.DidNotReceiveWithAnyArgs().AddExampleAsync(default, default!, Ct);
        else await _words.Received(1).AddExampleAsync(User, Arg.Is<VocabularyExample>(e => e.WordId == CardId), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Writes_IdsThatAreNotTheReaders_AreRefusedAndWriteNothing()
    {
        var foreignBook = await Service.SaveWordAsync(User, Save(Sentence(bookId: Guid.NewGuid())), Ct);
        var foreignFile = await Service.SaveWordAsync(User, Save(Sentence(BookId, fileId: Guid.NewGuid())), Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (foreignBook.Status, SyncFakes.Error(foreignBook).Code));
        Assert.Equal((409, SyncCodes.UnknownFile), (foreignFile.Status, SyncFakes.Error(foreignFile).Code));
        Assert.Empty(_words.ReceivedCalls());

        var aliceCard = Guid.NewGuid();
        var foreignCard = await Service.AddExampleAsync(User, aliceCard, Sentence(), Ct);
        // A restore has no read before its write: the repository's guarded UPDATE is the ownership check, and finds no row.
        Restores(1, null, aliceCard);
        var foreignRestore = await Service.RestoreWordAsync(User, aliceCard, new RestoreVocabularyWordRequest(1), Ct);

        Assert.Equal((404, SyncCodes.NotFound), (foreignCard.Status, SyncFakes.Error(foreignCard).Code));
        await _words.DidNotReceiveWithAnyArgs().AddExampleAsync(default, default!, Ct);
        Assert.Equal((404, SyncCodes.NotFound), (foreignRestore.Status, SyncFakes.Error(foreignRestore).Code));
        await _words.DidNotReceiveWithAnyArgs().GetWordAsync(default, default, Ct);
    }

    [Fact]
    public async Task SaveWordAsync_IdsAlreadyTaken_AreConflictsCarryingWhatIsStored()
    {
        Saves(WordSaveOutcome.IdConflict, null);
        var idTaken = await Service.SaveWordAsync(User, Save(), Ct);

        Saves(WordSaveOutcome.Existing, Card());
        var stored = new VocabularyExample { Id = Guid.NewGuid(), WordId = CardId, Sentence = "Another sentence." };
        AddsExample(WriteOutcome.OperationConflict, stored);
        var operationTaken = await Service.SaveWordAsync(User, Save(Sentence()), Ct);

        Assert.Equal((409, SyncCodes.IdConflict), (idTaken.Status, SyncFakes.Error(idTaken).Code));
        Assert.Equal((409, SyncCodes.OperationConflict), (operationTaken.Status, SyncFakes.Error(operationTaken).Code));
        Assert.Equal(stored.Id, Assert.IsType<VocabularyExampleDto>(SyncFakes.Error(operationTaken).Current).Id);
    }

    [Fact]
    public async Task UpdateWordAsync_EditsFromTwoDevices_KeepWhatTheyDoNotNameAndTheNewerRevisionWins()
    {
        // An edit naming only the translation keeps the stored definition.
        var stored = Card();
        stored.Definition = "a case for arrows";
        Stores(stored);
        Updates(true, Card(revision: 2));
        var accepted = await Service.UpdateWordAsync(User, CardId, Patch(1), Ct);
        Assert.Equal(200, accepted.Status);
        await _words.Received(1).UpdateWordAsync(User, CardId, "сагайдак", "a case for arrows", 1, Arg.Any<CancellationToken>());

        // Another device edited first: the card still says колчан, so this edit lost.
        Stores(Card(revision: 3));
        Updates(false, Card(revision: 3));
        var stale = await Service.UpdateWordAsync(User, CardId, Patch(2), Ct);
        Assert.Equal((409, SyncCodes.StaleRevision, 3L), (stale.Status, SyncFakes.Error(stale).Code, SyncFakes.Error(stale).Revision!.Value));

        // A retry of an edit that landed, whose response was lost, is its own write.
        var landed = Card(revision: 2);
        landed.Translation = "сагайдак";
        Stores(landed);
        Updates(false, landed);
        var retry = await Service.UpdateWordAsync(User, CardId, Patch(1), Ct);
        Assert.Equal((200, 2L), (retry.Status, CardOf(retry).Revision));
    }

    [Fact]
    public async Task UpdateWordAsync_DeletedCardOrUnreadableDefinition_IsRefusedAndWritesNothing()
    {
        Stores(Card(revision: 2, deleted: true));
        var deleted = await Service.UpdateWordAsync(User, CardId, Patch(2), Ct);

        Stores(Card());
        var loneSurrogate = await Service.UpdateWordAsync(User, CardId, Patch(1, "\"fine\"", "\"\\ud800\""), Ct);

        Assert.Equal((409, SyncCodes.Deleted), (deleted.Status, SyncFakes.Error(deleted).Code));
        var refused = SyncFakes.Error(loneSurrogate);
        Assert.Equal((400, SyncCodes.InvalidPayload, "definition"), (loneSurrogate.Status, refused.Code, refused.Field));
        Assert.Contains("is a string or null", refused.Message);
        await _words.DidNotReceiveWithAnyArgs().UpdateWordAsync(default, default, default, default, default, Ct);
    }

    [Fact]
    public async Task DeleteAndRestore_ACardsTombstone_AnswersAgainAndOnlyTheLatestRevisionRestores()
    {
        // Deleting a tombstone again is idempotent: the tombstone answers.
        Stores(Card(revision: 2, deleted: true));
        var deletedAgain = await Service.DeleteWordAsync(User, CardId, Ct);
        Assert.Equal((200, true), (deletedAgain.Status, CardOf(deletedAgain).DeletedAt is not null));

        // A restore from an older revision loses to the tombstone.
        Restores(1, Card(revision: 2, deleted: true));
        var stale = await Service.RestoreWordAsync(User, CardId, new RestoreVocabularyWordRequest(1), Ct);
        Assert.Equal((409, SyncCodes.StaleRevision, 2L), (stale.Status, SyncFakes.Error(stale).Code, SyncFakes.Error(stale).Revision!.Value));

        // A retried restore whose first response was lost finds the card live, as the restore left it.
        Restores(2, Card(revision: 3));
        Stores(Card(revision: 3));
        var retry = await Service.RestoreWordAsync(User, CardId, new RestoreVocabularyWordRequest(2), Ct);
        Assert.Equal((200, 3L, false), (retry.Status, CardOf(retry).Revision, CardOf(retry).DeletedAt is not null));
    }

    // S3: the schedule is the engine's, computed from the card the repository hands it (the locked one).
    [Theory]
    [InlineData(WriteOutcome.Created, 201)]
    [InlineData(WriteOutcome.Replayed, 200)]
    public async Task RecordReviewAsync_ThirdCorrectAnswerAtMastery_RetiresTheCard(WriteOutcome outcome, int status)
    {
        var seen = RecordsReviews(outcome);
        Stores(Card(revision: 2));

        var result = await Service.RecordReviewAsync(User, Answer(), Ct);

        var mastered = new VocabularyWord { Stage = 4, ConsecutiveCorrect = 2, IntervalDays = 28m };
        Assert.Equal(new ReviewSchedule(4, 56m, 3, Retire: true), seen.Single().Schedule(mastered));
        Assert.Equal((status, CardId), (result.Status, Assert.IsType<RecordedReviewDto>(result.Body).Word.Id));
    }

    [Fact]
    public async Task RecordReviewAsync_DeletedCard_IsDeletedWithTheTombstone()
    {
        RecordsReviews(WriteOutcome.Deleted);
        Stores(Card(revision: 2, deleted: true));

        var result = await Service.RecordReviewAsync(User, Answer(), Ct);

        var error = SyncFakes.Error(result);
        Assert.Equal((409, SyncCodes.Deleted, 2L), (result.Status, error.Code, error.Revision!.Value));
        Assert.NotNull(Assert.IsType<VocabularyWordDto>(error.Current).DeletedAt);
    }

    // M1.3 delta 5: a replay is told apart from a new operation by its hash, so one payload sent two ways must hash the same.
    [Fact]
    public async Task AddExampleAsync_SameExampleAsASaveByKey_HashesTheSame()
    {
        Saves(WordSaveOutcome.Existing, Card());
        var hashes = AddsExample(WriteOutcome.Created);
        var example = Sentence(bookId: BookId);

        await Service.SaveWordAsync(User, Save(example), Ct);
        await Service.AddExampleAsync(User, CardId, example, Ct);

        Assert.Equal(2, hashes.Count);
        Assert.Single(hashes.Distinct());
    }

    [Fact]
    public async Task RecordReviewAsync_OneInstantInTwoOffsets_HashesTheSameAndAnotherAnswerDoesNot()
    {
        var answers = RecordsReviews(WriteOutcome.Created);
        Stores(Card());
        var operationId = Guid.NewGuid();
        var instant = new DateTimeOffset(2025, 12, 31, 20, 15, 3, 500, TimeSpan.FromHours(2));

        await Service.RecordReviewAsync(User, Answer(at: instant, operationId: operationId), Ct);
        await Service.RecordReviewAsync(User, Answer(at: instant.ToUniversalTime(), operationId: operationId), Ct);
        await Service.RecordReviewAsync(User, Answer(isCorrect: false, at: instant, operationId: operationId), Ct);

        Assert.Equal(3, answers.Count);
        Assert.Equal(answers[0].Sha256, answers[1].Sha256);
        Assert.NotEqual(answers[0].Sha256, answers[2].Sha256);
    }
}
