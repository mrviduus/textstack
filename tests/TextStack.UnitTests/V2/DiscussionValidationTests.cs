using System.Text.Json;
using Application.Common;
using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Discussion;
using Moq;
using static Application.Discussion.DiscussionSyncService;

namespace TextStack.UnitTests.V2;

/// <summary>What a share and a checkpoint refuse with 400 <c>invalid_payload</c>, and what they let through to the repository.</summary>
public class DiscussionValidationTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly DiscussionSyncService _service;

    public DiscussionValidationTests()
    {
        var shares = new Mock<ISharedChapterRepository>();
        shares.Setup(s => s.ShareAsync(It.IsAny<SharedChapter>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((SharedChapter s, CancellationToken _) => new WriteResult<SharedChapter>(WriteOutcome.Created, s));
        var checkpoints = new Mock<ICheckpointRepository>();
        checkpoints.Setup(c => c.AppendAsync(It.IsAny<DiscussionCheckpoint>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((DiscussionCheckpoint c, CancellationToken _) => new WriteResult<DiscussionCheckpoint>(WriteOutcome.Created, c));
        _service = new DiscussionSyncService(V2Fakes.Library(User, BookId, null).Object, shares.Object, checkpoints.Object);
    }

    /// <summary>The refused field, or null when the request got past validation.</summary>
    private static async Task<string?> FieldOf(Task<SyncResult> pending) => (await pending).Body is V2Error { Code: SyncCodes.InvalidPayload } e ? e.Field : null;

    private Task<string?> Share(
        string? chapterKey = "ch02.xhtml", string? chapterTitle = null, string? chapterText = "It was the night.",
        string? notes = "[]", string? language = null, Guid? operationId = null) =>
        FieldOf(_service.ShareAsync(User, BookId, new ShareChapterRequest(
            operationId ?? Guid.NewGuid(), null, chapterKey, chapterTitle, chapterText,
            notes is null ? null : JsonDocument.Parse(notes).RootElement, language), Ct));

    private Task<string?> Save(
        string?[]? readerThoughts = null, string?[]? conclusions = null, string? topic = "The letter",
        string? language = "en", string? chapterKey = null, Guid? operationId = null, bool sectionsNull = false) =>
        FieldOf(_service.SaveCheckpointAsync(User, BookId, new CheckpointRequest(
            operationId ?? Guid.NewGuid(), topic, sectionsNull ? null : readerThoughts ?? ["A thought."], [], conclusions ?? [], [],
            language, chapterKey, null, null), Ct));

    private static string Text(int length) => new('x', length);

    [Fact]
    public async Task ShareAsync_EveryFieldAtItsCap_PassesValidation()
    {
        var notes = "[\"" + Text(MaxNotesBytes - 4) + "\"]";

        Assert.Null(await Share(Text(SyncValidation.MaxChapterKey), Text(MaxChapterTitle), Text(MaxChapterTextBytes), notes, Text(SyncValidation.MaxLanguage)));
    }

    [Fact]
    public async Task ShareAsync_NoOperationId_IsRefused() => Assert.Equal("operationId", await Share(operationId: Guid.Empty));

    [Fact]
    public async Task ShareAsync_BlankOrLongChapterKey_IsRefused()
    {
        Assert.Equal("chapterKey", await Share(chapterKey: " "));
        Assert.Equal("chapterKey", await Share(chapterKey: Text(SyncValidation.MaxChapterKey + 1)));
    }

    [Fact]
    public async Task ShareAsync_LongChapterTitle_IsRefused() => Assert.Equal("chapterTitle", await Share(chapterTitle: Text(MaxChapterTitle + 1)));

    // The cap is in UTF-8 bytes: 100 K Cyrillic letters are 200 KB.
    [Fact]
    public async Task ShareAsync_ChapterTextOverItsBytes_IsRefused() =>
        Assert.Equal("chapterText", await Share(chapterText: new string('ж', MaxChapterTextBytes / 2 + 1)));

    [Fact]
    public async Task ShareAsync_ChapterTextWithANul_IsRefused() => Assert.Equal("chapterText", await Share(chapterText: "a\0b"));

    [Theory]
    [InlineData(null)]
    [InlineData("""{"text":"night"}""")]
    [InlineData("""[{"a":1,"a":2}]""")]
    [InlineData("""["\u0000"]""")]
    public async Task ShareAsync_NotesMissingNotAnArrayRepeatingAMemberOrUnstorable_AreRefused(string? notes) =>
        Assert.Equal("notes", await Share(notes: notes));

    [Fact]
    public async Task ShareAsync_NotesOverTheirBytes_IsRefused() => Assert.Equal("notes", await Share(notes: "[\"" + Text(MaxNotesBytes) + "\"]"));

    [Fact]
    public async Task ShareAsync_LongLanguage_IsRefused() => Assert.Equal("language", await Share(language: Text(SyncValidation.MaxLanguage + 1)));

    [Fact]
    public async Task SaveCheckpointAsync_OneSectionWithAnItem_PassesValidation() => Assert.Null(await Save());

    [Fact]
    public async Task SaveCheckpointAsync_AllFourSectionsEmpty_IsRefused() => Assert.Equal("readerThoughts", await Save(readerThoughts: []));

    [Fact]
    public async Task SaveCheckpointAsync_AMissingSection_IsRefused() => Assert.Equal("readerThoughts", await Save(sectionsNull: true));

    [Fact]
    public async Task SaveCheckpointAsync_SectionOverItsItems_IsRefused() =>
        Assert.Equal("conclusions", await Save(conclusions: Enumerable.Repeat("c", MaxSectionItems + 1).ToArray()));

    [Fact]
    public async Task SaveCheckpointAsync_SectionAtItsItems_PassesValidation() =>
        Assert.Null(await Save(conclusions: Enumerable.Repeat("c", MaxSectionItems).ToArray()));

    [Theory]
    [InlineData(" ")]
    [InlineData(null)]
    [InlineData("a\0b")]
    public async Task SaveCheckpointAsync_BlankNullOrUnstorableItem_IsRefused(string? item) => Assert.Equal("conclusions", await Save(conclusions: [item]));

    [Fact]
    public async Task SaveCheckpointAsync_SectionsTogetherOverTheirBytes_IsRefused() =>
        Assert.Equal("readerThoughts", await Save(readerThoughts: [Text(MaxSectionsBytes / 2)], conclusions: [Text(MaxSectionsBytes / 2 + 1)]));

    [Fact]
    public async Task SaveCheckpointAsync_SectionsTogetherAtTheirBytes_PassValidation() =>
        Assert.Null(await Save(readerThoughts: [Text(MaxSectionsBytes / 2)], conclusions: [Text(MaxSectionsBytes / 2)]));

    [Fact]
    public async Task SaveCheckpointAsync_BlankOrLongTopic_IsRefused()
    {
        Assert.Equal("topic", await Save(topic: " "));
        Assert.Equal("topic", await Save(topic: Text(MaxTopic + 1)));
    }

    [Fact]
    public async Task SaveCheckpointAsync_MissingOrLongLanguage_IsRefused()
    {
        Assert.Equal("language", await Save(language: null));
        Assert.Equal("language", await Save(language: Text(SyncValidation.MaxLanguage + 1)));
    }

    [Fact]
    public async Task SaveCheckpointAsync_BlankChapterKey_IsRefused() => Assert.Equal("chapterKey", await Save(chapterKey: " "));

    [Fact]
    public async Task SaveCheckpointAsync_NoOperationId_IsRefused() => Assert.Equal("operationId", await Save(operationId: Guid.Empty));
}
