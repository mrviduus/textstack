using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Vocabulary;
using Contracts.V2;
using Domain.Vocabulary;
using Moq;
using TextStack.Vocabulary;

namespace TextStack.UnitTests.V2;

/// <summary>The vocabulary codes and the server-side schedule (S3) of v2-sync-protocol.md, on fakes.</summary>
public class VocabularySyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid CardId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, FileId);
    private readonly Mock<IVocabularyRepository> _words = new();
    private VocabularySyncService Service => new(_library.Object, _words.Object, Mock.Of<IVocabularyFeedRepository>(), new SrsEngine());

    private static VocabularyWord Card(long revision = 1, DateTimeOffset? deletedAt = null) => new()
    {
        Id = CardId,
        UserId = User,
        Language = "en",
        Word = "Quiver",
        WordKey = "quiver",
        Translation = "колчан",
        Revision = revision,
        DeletedAt = deletedAt,
    };

    private static VocabularyExampleRequest Sentence(Guid? operationId = null, Guid? bookId = null, Guid? fileId = null) =>
        new(operationId ?? Guid.NewGuid(), "Her voice quivered.", null, bookId, fileId, null, null);

    private static SaveVocabularyWordRequest Save(VocabularyExampleRequest? example = null) =>
        new(Guid.NewGuid(), "en", "  Quiver ", "колчан", null, example);

    private void Saves(WordSaveOutcome outcome, VocabularyWord? card)
    {
        _words.Setup(w => w.SaveWordAsync(User, It.IsAny<VocabularyWord>(), It.IsAny<CancellationToken>())).ReturnsAsync(new SavedWord(outcome, card));
        if (card is not null) _words.Setup(w => w.GetWordAsync(User, card.Id, It.IsAny<CancellationToken>())).ReturnsAsync(card);
    }

    private void AddsExample(WriteOutcome outcome, VocabularyExample? row = null) =>
        _words.Setup(w => w.AddExampleAsync(User, It.IsAny<VocabularyExample>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Guid _, VocabularyExample e, CancellationToken _) => new WriteResult<VocabularyExample>(outcome, row ?? e));

    private static VocabularyWordDto CardOf(SyncResult result) => Assert.IsType<VocabularyWordDto>(result.Body);

    [Fact]
    public async Task SaveWordAsync_NewWord_SavesItUnderTheTrimmedLowercaseKeyAndIs201()
    {
        Saves(WordSaveOutcome.Created, Card());

        var result = await Service.SaveWordAsync(User, Save(), Ct);

        Assert.Equal((201, (string?)null), (result.Status, CardOf(result).Example));
        _words.Verify(w => w.SaveWordAsync(User, It.Is<VocabularyWord>(c => c.WordKey == "quiver" && c.Word == "  Quiver "), It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task SaveWordAsync_KeyOfAnExistingCard_Is200WithTheStoredCardsId()
    {
        Saves(WordSaveOutcome.Existing, Card(revision: 4));

        var result = await Service.SaveWordAsync(User, Save(), Ct);

        Assert.Equal((200, CardId, 4L), (result.Status, CardOf(result).Id, CardOf(result).Revision));
    }

    [Fact]
    public async Task SaveWordAsync_DeletedCard_IsDeletedWithTheTombstoneAndAddsNoExample()
    {
        Saves(WordSaveOutcome.Deleted, Card(revision: 2, deletedAt: DateTimeOffset.UtcNow));

        var result = await Service.SaveWordAsync(User, Save(Sentence()), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.Deleted, 2L), (result.Status, error.Code, error.Revision));
        Assert.IsType<VocabularyWordDto>(error.Current);
        _words.Verify(w => w.AddExampleAsync(It.IsAny<Guid>(), It.IsAny<VocabularyExample>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task SaveWordAsync_IdOfAnotherCard_IsIdConflict()
    {
        Saves(WordSaveOutcome.IdConflict, null);

        var result = await Service.SaveWordAsync(User, Save(), Ct);

        Assert.Equal((409, SyncCodes.IdConflict), (result.Status, V2Fakes.Error(result).Code));
    }

    [Fact]
    public async Task SaveWordAsync_ExampleFromABookThatIsNotTheUsers_IsBookNotFoundAndWritesNothing()
    {
        var result = await Service.SaveWordAsync(User, Save(Sentence(bookId: Guid.NewGuid())), Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (result.Status, V2Fakes.Error(result).Code));
        _words.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveWordAsync_ExampleFromAFileThatIsNoVersionOfTheBook_IsUnknownFileAndWritesNothing()
    {
        var result = await Service.SaveWordAsync(User, Save(Sentence(bookId: BookId, fileId: Guid.NewGuid())), Ct);

        Assert.Equal((409, SyncCodes.UnknownFile), (result.Status, V2Fakes.Error(result).Code));
        _words.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData(WriteOutcome.Created, "added")]
    [InlineData(WriteOutcome.Replayed, "replayed")]
    public async Task SaveWordAsync_WithAnExample_SaysWhetherItWasAddedOrReplayed(WriteOutcome outcome, string said)
    {
        Saves(WordSaveOutcome.Existing, Card());
        AddsExample(outcome);

        var result = await Service.SaveWordAsync(User, Save(Sentence(bookId: BookId, fileId: FileId)), Ct);

        Assert.Equal((200, said), (result.Status, CardOf(result).Example));
    }

    [Fact]
    public async Task SaveWordAsync_ExampleUnderAReusedOperationId_IsOperationConflictWithTheStoredExample()
    {
        Saves(WordSaveOutcome.Existing, Card());
        var stored = new VocabularyExample { Id = Guid.NewGuid(), WordId = CardId, Sentence = "Another sentence." };
        AddsExample(WriteOutcome.OperationConflict, stored);

        var result = await Service.SaveWordAsync(User, Save(Sentence()), Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((409, SyncCodes.OperationConflict), (result.Status, error.Code));
        Assert.Equal(stored.Id, Assert.IsType<VocabularyExampleDto>(error.Current).Id);
    }

    // M1.3 delta 5: a save-by-key and an add-by-id of one example hash the same, whatever id the save sent.
    [Fact]
    public async Task AddExampleAsync_SameExampleAsASaveByKey_HashesTheSame()
    {
        Saves(WordSaveOutcome.Existing, Card());
        var hashes = new List<string>();
        _words.Setup(w => w.AddExampleAsync(User, It.IsAny<VocabularyExample>(), It.IsAny<CancellationToken>()))
            .Callback((Guid _, VocabularyExample e, CancellationToken _) => hashes.Add(e.PayloadSha256))
            .ReturnsAsync((Guid _, VocabularyExample e, CancellationToken _) => new WriteResult<VocabularyExample>(WriteOutcome.Created, e));
        var example = Sentence(bookId: BookId);

        await Service.SaveWordAsync(User, Save(example), Ct);
        await Service.AddExampleAsync(User, CardId, example, Ct);

        Assert.Equal(2, hashes.Count);
        Assert.Single(hashes.Distinct());
    }

    [Fact]
    public async Task AddExampleAsync_CardThatIsNotTheUsers_IsNotFoundAndWritesNothing()
    {
        var result = await Service.AddExampleAsync(User, Guid.NewGuid(), Sentence(), Ct);

        Assert.Equal((404, SyncCodes.NotFound), (result.Status, V2Fakes.Error(result).Code));
        _words.Verify(w => w.AddExampleAsync(It.IsAny<Guid>(), It.IsAny<VocabularyExample>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    private static PatchVocabularyWordRequest Patch(long revision, string translationJson = "\"сагайдак\"", string? definitionJson = null) =>
        new(revision, JsonSerializer.Deserialize<JsonElement>(translationJson),
            definitionJson is null ? default : JsonSerializer.Deserialize<JsonElement>(definitionJson));

    private void Updates(bool accepted, VocabularyWord current) =>
        _words.Setup(w => w.UpdateWordAsync(User, CardId, It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<long>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<VocabularyWord>(accepted, current));

    [Fact]
    public async Task UpdateWordAsync_AbsentDefinition_KeepsTheStoredOne()
    {
        var stored = Card();
        stored.Definition = "a case for arrows";
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(stored);
        Updates(true, Card(revision: 2));

        await Service.UpdateWordAsync(User, CardId, Patch(1), Ct);

        _words.Verify(w => w.UpdateWordAsync(User, CardId, "сагайдак", "a case for arrows", 1, It.IsAny<CancellationToken>()));
    }

    [Fact]
    public async Task UpdateWordAsync_StaleRevision_IsStaleRevisionWithTheStoredCard()
    {
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(Card(revision: 3));
        Updates(false, Card(revision: 3)); // still колчан: another device's edit, not this one

        var result = await Service.UpdateWordAsync(User, CardId, Patch(2), Ct);

        Assert.Equal((409, SyncCodes.StaleRevision, 3L), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).Revision));
    }

    [Fact]
    public async Task UpdateWordAsync_RetryOfAnEditThatLanded_Is200()
    {
        var landed = Card(revision: 2);
        landed.Translation = "сагайдак";
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(landed);
        Updates(false, landed);

        var result = await Service.UpdateWordAsync(User, CardId, Patch(1), Ct);

        Assert.Equal((200, 2L), (result.Status, CardOf(result).Revision));
    }

    [Fact]
    public async Task UpdateWordAsync_DeletedCard_IsDeletedAndWritesNothing()
    {
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(Card(2, DateTimeOffset.UtcNow));

        var result = await Service.UpdateWordAsync(User, CardId, Patch(2), Ct);

        Assert.Equal((409, SyncCodes.Deleted), (result.Status, V2Fakes.Error(result).Code));
        _words.Verify(w => w.UpdateWordAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<long>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task RestoreWordAsync_StaleRevision_IsStaleRevisionWithTheTombstone()
    {
        _words.Setup(w => w.RestoreWordAsync(User, CardId, 1, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<VocabularyWord>(false, Card(2, DateTimeOffset.UtcNow)));

        var result = await Service.RestoreWordAsync(User, CardId, new RestoreVocabularyWordRequest(1), Ct);

        Assert.Equal((409, SyncCodes.StaleRevision, 2L), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).Revision));
    }

    [Fact]
    public async Task RestoreWordAsync_CardThatIsNotTheUsers_IsNotFound()
    {
        _words.Setup(w => w.RestoreWordAsync(User, CardId, 1, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<VocabularyWord>(false, null));

        var result = await Service.RestoreWordAsync(User, CardId, new RestoreVocabularyWordRequest(1), Ct);

        Assert.Equal(404, result.Status);
    }

    [Fact]
    public async Task DeleteWordAsync_AlreadyDeleted_AnswersTheTombstoneAgain()
    {
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(Card(2, DateTimeOffset.UtcNow));

        var result = await Service.DeleteWordAsync(User, CardId, Ct);

        Assert.Equal((200, true), (result.Status, CardOf(result).DeletedAt is not null));
    }

    private static VocabularyReviewRequest Answer(bool isCorrect = true, DateTimeOffset? at = null, Guid? operationId = null) =>
        new(operationId ?? Guid.NewGuid(), CardId, "multiple_choice", isCorrect, null, at ?? DateTimeOffset.UtcNow);

    /// <summary>Records each review's hash and schedule; answers <paramref name="outcome"/>.</summary>
    private List<(string Sha256, Func<VocabularyWord, ReviewSchedule> Schedule)> RecordsReviews(WriteOutcome outcome = WriteOutcome.Created)
    {
        var seen = new List<(string, Func<VocabularyWord, ReviewSchedule>)>();
        _words.Setup(w => w.RecordReviewAsync(User, It.IsAny<VocabularyReview>(), It.IsAny<Func<VocabularyWord, ReviewSchedule>>(), It.IsAny<CancellationToken>()))
            .Callback((Guid _, VocabularyReview r, Func<VocabularyWord, ReviewSchedule> s, CancellationToken _) => seen.Add((r.PayloadSha256, s)))
            .ReturnsAsync((Guid _, VocabularyReview r, Func<VocabularyWord, ReviewSchedule> _, CancellationToken _) => new WriteResult<VocabularyReview>(outcome, r));
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(Card());
        return seen;
    }

    // S3: the schedule is the engine's, computed from the card the repository hands it (the locked one).
    [Fact]
    public async Task RecordReviewAsync_ThirdCorrectAnswerAtMastery_RetiresTheCard()
    {
        var seen = RecordsReviews();

        var result = await Service.RecordReviewAsync(User, Answer(), Ct);

        var mastered = new VocabularyWord { Stage = 4, ConsecutiveCorrect = 2, IntervalDays = 28m };
        Assert.Equal(201, result.Status);
        Assert.Equal(new ReviewSchedule(4, 56m, 3, Retire: true), seen.Single().Schedule(mastered));
    }

    [Fact]
    public async Task RecordReviewAsync_AnswerToARetiredCard_DoesNotRetireItAgain()
    {
        var seen = RecordsReviews();

        await Service.RecordReviewAsync(User, Answer(), Ct);

        var retired = new VocabularyWord { Stage = 4, ConsecutiveCorrect = 3, IntervalDays = 56m, RetiredAt = DateTimeOffset.UtcNow };
        Assert.False(seen.Single().Schedule(retired).Retire);
    }

    [Fact]
    public async Task RecordReviewAsync_OneInstantInTwoOffsets_HashesTheSame()
    {
        var seen = RecordsReviews();
        var operationId = Guid.NewGuid();
        var instant = new DateTimeOffset(2026, 10, 30, 20, 15, 3, 500, TimeSpan.FromHours(2));

        await Service.RecordReviewAsync(User, Answer(at: instant, operationId: operationId), Ct);
        await Service.RecordReviewAsync(User, Answer(at: instant.ToUniversalTime(), operationId: operationId), Ct);
        await Service.RecordReviewAsync(User, Answer(isCorrect: false, at: instant, operationId: operationId), Ct);

        Assert.Equal(seen[0].Sha256, seen[1].Sha256);
        Assert.NotEqual(seen[0].Sha256, seen[2].Sha256);
    }

    [Fact]
    public async Task RecordReviewAsync_DeletedCard_IsDeletedWithTheTombstone()
    {
        RecordsReviews(WriteOutcome.Deleted);
        _words.Setup(w => w.GetWordAsync(User, CardId, It.IsAny<CancellationToken>())).ReturnsAsync(Card(2, DateTimeOffset.UtcNow));

        var result = await Service.RecordReviewAsync(User, Answer(), Ct);

        Assert.Equal((409, SyncCodes.Deleted, 2L), (result.Status, V2Fakes.Error(result).Code, V2Fakes.Error(result).Revision));
    }

    [Fact]
    public async Task RecordReviewAsync_Replayed_Is200WithTheReviewAndTheCard()
    {
        RecordsReviews(WriteOutcome.Replayed);

        var result = await Service.RecordReviewAsync(User, Answer(), Ct);

        var body = Assert.IsType<RecordedReviewDto>(result.Body);
        Assert.Equal((200, CardId), (result.Status, body.Word.Id));
    }
}
