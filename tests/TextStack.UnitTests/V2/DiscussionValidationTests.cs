using Application.Discussion;
using Application.Sync;
using Contracts.V2;
using static Contracts.V2.SyncLimits;
using static TextStack.UnitTests.V2.V2Fakes;

namespace TextStack.UnitTests.V2;

/// <summary>What a share and a checkpoint refuse with 400 <c>invalid_payload</c>, and what they let through to the repository.</summary>
public class DiscussionValidationTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly DiscussionSyncService _service = new(Library(User, BookId, null).Object, Shares().Object, Checkpoints().Object);

    /// <summary>The refused field, or null when the request got past validation.</summary>
    private static async Task<string?> FieldOf(Task<SyncResult> pending) => (await pending).Body is V2Error { Code: SyncCodes.InvalidPayload } e ? e.Field : null;

    private Task<string?> Share(ShareChapterRequest r) => FieldOf(_service.ShareAsync(User, BookId, r, Ct));

    private Task<string?> Save(CheckpointRequest r) => FieldOf(_service.SaveCheckpointAsync(User, BookId, r, Ct));

    private static string Text(int length) => new('x', length);

    [Fact]
    public async Task ShareAsync_EveryFieldAtItsCap_PassesValidation() =>
        Assert.Null(await Share(NewShare() with
        {
            ChapterKey = Text(MaxChapterKey),
            ChapterTitle = Text(MaxChapterTitle),
            ChapterText = Text(MaxChapterTextBytes),
            Notes = JsonOf("[\"" + Text(MaxNotesBytes - 4) + "\"]"),
            Language = Text(MaxLanguage),
        }));

    [Fact]
    public async Task ShareAsync_NoOperationId_IsRefused() => Assert.Equal("operationId", await Share(NewShare() with { OperationId = Guid.Empty }));

    [Fact]
    public async Task ShareAsync_BlankOrLongChapterKey_IsRefused()
    {
        Assert.Equal("chapterKey", await Share(NewShare() with { ChapterKey = " " }));
        Assert.Equal("chapterKey", await Share(NewShare() with { ChapterKey = Text(MaxChapterKey + 1) }));
    }

    [Fact]
    public async Task ShareAsync_LongChapterTitle_IsRefused() => Assert.Equal("chapterTitle", await Share(NewShare() with { ChapterTitle = Text(MaxChapterTitle + 1) }));

    // The cap is in UTF-8 bytes: four-byte emoji to exactly the cap fit, one byte more does not.
    [Fact]
    public async Task ShareAsync_ChapterTextOfEmojiAtItsBytesAndOneOver_PassesThenIsRefused()
    {
        var atCap = string.Concat(Enumerable.Repeat("😀", MaxChapterTextBytes / 4));

        Assert.Null(await Share(NewShare() with { ChapterText = atCap }));
        Assert.Equal("chapterText", await Share(NewShare() with { ChapterText = atCap + "x" }));
    }

    [Fact]
    public async Task ShareAsync_ChapterTextWithANul_IsRefused() => Assert.Equal("chapterText", await Share(NewShare() with { ChapterText = "a\0b" }));

    [Theory]
    [InlineData(null)]
    [InlineData("""{"text":"night"}""")]
    [InlineData("""[{"a":1,"a":2}]""")]
    [InlineData("""["\u0000"]""")]
    [InlineData("[1e400]")]
    [InlineData("""[{"rect":{"x":-1e400}}]""")]
    public async Task ShareAsync_NotesMissingNotAnArrayRepeatingAMemberUnstorableOrNonFinite_AreRefused(string? notes) =>
        Assert.Equal("notes", await Share(NewShare() with { Notes = notes is null ? null : JsonOf(notes) }));

    [Fact]
    public async Task ShareAsync_NotesOneByteOverTheirCap_IsRefused() =>
        Assert.Equal("notes", await Share(NewShare() with { Notes = JsonOf("[\"" + Text(MaxNotesBytes - 3) + "\"]") }));

    [Fact]
    public async Task ShareAsync_LongLanguage_IsRefused() => Assert.Equal("language", await Share(NewShare() with { Language = Text(MaxLanguage + 1) }));

    [Fact]
    public async Task SaveCheckpointAsync_OneSectionWithAnItem_PassesValidation() =>
        Assert.Null(await Save(NewCheckpoint() with { OpenQuestions = [] }));

    [Fact]
    public async Task SaveCheckpointAsync_AllFourSectionsEmpty_IsRefused() =>
        Assert.Equal("readerThoughts", await Save(NewCheckpoint() with { ReaderThoughts = [], OpenQuestions = [] }));

    [Fact]
    public async Task SaveCheckpointAsync_AMissingSection_IsRefused() => Assert.Equal("readerThoughts", await Save(NewCheckpoint() with { ReaderThoughts = null }));

    [Fact]
    public async Task SaveCheckpointAsync_SectionOverItsItems_IsRefused() =>
        Assert.Equal("conclusions", await Save(NewCheckpoint() with { Conclusions = Enumerable.Repeat("c", MaxSectionItems + 1).ToArray() }));

    [Fact]
    public async Task SaveCheckpointAsync_SectionAtItsItems_PassesValidation() =>
        Assert.Null(await Save(NewCheckpoint() with { Conclusions = Enumerable.Repeat("c", MaxSectionItems).ToArray() }));

    [Theory]
    [InlineData(" ")]
    [InlineData(null)]
    [InlineData("a\0b")]
    public async Task SaveCheckpointAsync_BlankNullOrUnstorableItem_IsRefusedNamingThatItem(string? item) =>
        Assert.Equal("conclusions[1]", await Save(NewCheckpoint() with { Conclusions = ["ok", item] }));

    [Fact]
    public async Task SaveCheckpointAsync_SectionsTogetherOverTheirBytes_IsRefused() =>
        Assert.Equal("readerThoughts", await Save(NewCheckpoint() with
        {
            ReaderThoughts = [Text(MaxSectionsBytes / 2)],
            Conclusions = [Text(MaxSectionsBytes / 2 + 1)],
            OpenQuestions = [],
        }));

    [Fact]
    public async Task SaveCheckpointAsync_SectionsTogetherAtTheirBytes_PassValidation() =>
        Assert.Null(await Save(NewCheckpoint() with
        {
            ReaderThoughts = [Text(MaxSectionsBytes / 2)],
            Conclusions = [Text(MaxSectionsBytes / 2)],
            OpenQuestions = [],
        }));

    [Fact]
    public async Task SaveCheckpointAsync_BlankOrLongTopic_IsRefused()
    {
        Assert.Equal("topic", await Save(NewCheckpoint() with { Topic = " " }));
        Assert.Equal("topic", await Save(NewCheckpoint() with { Topic = Text(MaxTopic + 1) }));
    }

    [Fact]
    public async Task SaveCheckpointAsync_MissingOrLongLanguage_IsRefused()
    {
        Assert.Equal("language", await Save(NewCheckpoint() with { Language = null }));
        Assert.Equal("language", await Save(NewCheckpoint() with { Language = Text(MaxLanguage + 1) }));
    }

    [Fact]
    public async Task SaveCheckpointAsync_BlankChapterKey_IsRefused() => Assert.Equal("chapterKey", await Save(NewCheckpoint() with { ChapterKey = " " }));

    [Fact]
    public async Task SaveCheckpointAsync_SharedChapterIdWithoutChapterKey_IsRefusedNamingChapterKey() =>
        Assert.Equal("chapterKey", await Save(NewCheckpoint(Guid.NewGuid()) with { ChapterKey = null }));

    [Fact]
    public async Task SaveCheckpointAsync_NoOperationId_IsRefused() => Assert.Equal("operationId", await Save(NewCheckpoint() with { OperationId = Guid.Empty }));
}
