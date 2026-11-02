using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Vocabulary;
using Contracts.V2;
using Domain.Vocabulary;
using Moq;
using TextStack.Vocabulary;
using static Application.Sync.SyncValidation;
using static Contracts.V2.SyncLimits;

namespace TextStack.UnitTests.V2;

/// <summary>What a card save and an answer refuse with 400 <c>invalid_payload</c>, and what they let through to the repository.</summary>
public class VocabularyValidationTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<IVocabularyRepository> _words = new();

    public VocabularyValidationTests()
    {
        _words.Setup(w => w.SaveWordAsync(It.IsAny<Guid>(), It.IsAny<VocabularyWord>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new SavedWord(WordSaveOutcome.Created, new VocabularyWord()));
        _words.Setup(w => w.RecordReviewAsync(It.IsAny<Guid>(), It.IsAny<VocabularyReview>(), It.IsAny<Func<VocabularyWord, ReviewSchedule>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((Guid _, VocabularyReview r, Func<VocabularyWord, ReviewSchedule> _, CancellationToken _) => new WriteResult<VocabularyReview>(WriteOutcome.Created, r));
        _words.Setup(w => w.GetWordAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync(new VocabularyWord());
    }

    private VocabularySyncService Service => new(Mock.Of<ILibraryRepository>(), _words.Object, new SrsEngine());

    /// <summary>The refused field, or null when the request got past validation.</summary>
    private static async Task<string?> FieldOf(Task<SyncResult> pending) => (await pending).Body is V2Error { Code: SyncCodes.InvalidPayload } e ? e.Field : null;

    private Task<string?> Save(string word = "quiver", string language = "en", Guid? id = null, VocabularyExampleRequest? example = null) =>
        FieldOf(Service.SaveWordAsync(Guid.NewGuid(), new SaveVocabularyWordRequest(id ?? Guid.NewGuid(), language, word, null, null, example), Ct));

    private Task<string?> Answer(bool? isCorrect = true, int? responseTimeMs = 0, string reviewMode = "multiple_choice", DateTimeOffset? at = null, Guid? operationId = null) =>
        FieldOf(Service.RecordReviewAsync(Guid.NewGuid(),
            new VocabularyReviewRequest(operationId ?? Guid.NewGuid(), Guid.NewGuid(), reviewMode, isCorrect, responseTimeMs, at ?? DateTimeOffset.UtcNow), Ct));

    [Fact]
    public async Task SaveWordAsync_BlankWordOrMissingLanguage_IsRefusedNamingIt()
    {
        Assert.Equal("word", await Save(" "));
        Assert.Equal("language", await FieldOf(Service.SaveWordAsync(Guid.NewGuid(), new(Guid.NewGuid(), null, "quiver", null, null, null), Ct)));
    }

    [Fact]
    public async Task SaveWordAsync_ExampleWithANulInItsSentence_IsRefusedUnderExample() =>
        Assert.Equal("example.sentence", await Save(example: new(Guid.NewGuid(), "a\u0000b", null, null, null, null, null)));

    [Fact]
    public async Task SaveWordAsync_NulInWord_IsRefused() => Assert.Equal("word", await Save("qui\u0000ver"));

    [Fact]
    public async Task SaveWordAsync_OnlyAZeroWidthSpace_IsRefusedAsNoWord() => Assert.Equal("word", await Save("​"));

    [Fact]
    public async Task SaveWordAsync_EmptyId_IsRefused() => Assert.Equal("id", await Save(id: Guid.Empty));

    [Fact]
    public async Task SaveWordAsync_WordAndLanguageAtTheirCaps_PassAndOneMoreIsRefused()
    {
        Assert.Null(await Save(new string('w', MaxWord), new string('l', MaxLanguage)));
        Assert.Equal("word", await Save(new string('w', MaxWord + 1)));
        Assert.Equal("language", await Save(language: new string('l', MaxLanguage + 1)));
    }

    [Fact]
    public async Task RecordReviewAsync_NegativeResponseTime_IsRefused() => Assert.Equal("responseTimeMs", await Answer(responseTimeMs: -1));

    [Fact]
    public async Task RecordReviewAsync_MissingAnswer_IsRefused() => Assert.Equal("isCorrect", await Answer(isCorrect: null));

    [Fact]
    public async Task RecordReviewAsync_NulInReviewMode_IsRefused() => Assert.Equal("reviewMode", await Answer(reviewMode: "multiple\u0000choice"));

    [Fact]
    public async Task RecordReviewAsync_EmptyOperationId_IsRefused() => Assert.Equal("operationId", await Answer(operationId: Guid.Empty));

    [Fact]
    public async Task RecordReviewAsync_ClientTimePastTheSkew_IsRefusedAndWithinItPasses()
    {
        Assert.Equal("clientRecordedAt", await Answer(at: DateTimeOffset.UtcNow.AddMinutes(6)));
        Assert.Null(await Answer(at: DateTimeOffset.UtcNow.AddMinutes(4)));
    }
}
