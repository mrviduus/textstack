using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.Sync;
using NSubstitute;
using static Contracts.Sync.SyncLimits;
using static TextStack.UnitTests.Sync.SyncFakes;

namespace TextStack.UnitTests.Sync;

/// <summary>
/// A reader shares a chapter with the assistant, or saves a checkpoint of the talk: what is refused with 400
/// <c>invalid_payload</c> (naming the field and why), and what is let through to the repository.
/// </summary>
public class DiscussionValidationTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly ISharedChapterRepository _shares = Shares();
    private readonly ICheckpointRepository _checkpoints = Checkpoints();
    private readonly DiscussionSyncService _service;

    public DiscussionValidationTests() => _service = new(new BookAccess(Library(User, BookId, (Guid?)null)), _shares, _checkpoints);

    private static string Text(int length) => new('x', length);

    // The cap is in UTF-8 bytes: four-byte emoji to exactly the cap fit, one byte more does not.
    private static readonly string EmojiAtCap = string.Concat(Enumerable.Repeat("😀", MaxChapterTextBytes / 4));

    private static readonly Dictionary<string, Func<ShareChapterRequest>> BadShares = new()
    {
        ["no operationId"] = () => NewShare() with { OperationId = Guid.Empty },
        ["blank chapterKey"] = () => NewShare() with { ChapterKey = " " },
        ["long chapterKey"] = () => NewShare() with { ChapterKey = Text(MaxChapterKey + 1) },
        ["long chapterTitle"] = () => NewShare() with { ChapterTitle = Text(MaxChapterTitle + 1) },
        ["emoji text one byte over"] = () => NewShare() with { ChapterText = EmojiAtCap + "x" },
        ["text with a NUL"] = () => NewShare() with { ChapterText = "a\0b" },
        ["no notes"] = () => NewShare() with { Notes = null },
        ["notes an object"] = () => NewShare() with { Notes = JsonOf("""{"text":"night"}""") },
        ["notes repeat a member"] = () => NewShare() with { Notes = JsonOf("""[{"a":1,"a":2}]""") },
        ["notes with a NUL"] = () => NewShare() with { Notes = JsonOf("""["\u0000"]""") },
        ["notes non-finite"] = () => NewShare() with { Notes = JsonOf("[1e400]") },
        ["notes nested non-finite"] = () => NewShare() with { Notes = JsonOf("""[{"rect":{"x":-1e400}}]""") },
        ["notes one byte over"] = () => NewShare() with { Notes = JsonOf("[\"" + Text(MaxNotesBytes - 3) + "\"]") },
        ["long language"] = () => NewShare() with { Language = Text(MaxLanguage + 1) },
    };

    private static readonly Dictionary<string, Func<CheckpointRequest>> BadCheckpoints = new()
    {
        ["no operationId"] = () => NewCheckpoint() with { OperationId = Guid.Empty },
        ["blank topic"] = () => NewCheckpoint() with { Topic = " " },
        ["long topic"] = () => NewCheckpoint() with { Topic = Text(MaxTopic + 1) },
        ["all sections empty"] = () => NewCheckpoint() with { ReaderThoughts = [], OpenQuestions = [] },
        ["a section missing"] = () => NewCheckpoint() with { ReaderThoughts = null },
        ["a section over its items"] = () => NewCheckpoint() with { Conclusions = Enumerable.Repeat("c", MaxSectionItems + 1).ToArray() },
        ["a blank item"] = () => NewCheckpoint() with { Conclusions = ["ok", " "] },
        ["a null item"] = () => NewCheckpoint() with { Conclusions = ["ok", null] },
        ["an item with a NUL"] = () => NewCheckpoint() with { Conclusions = ["ok", "a\0b"] },
        ["sections over their bytes"] = () => NewCheckpoint() with
        {
            ReaderThoughts = [Text(MaxSectionsBytes / 2)],
            Conclusions = [Text(MaxSectionsBytes / 2 + 1)],
            OpenQuestions = [],
        },
        ["no language"] = () => NewCheckpoint() with { Language = null },
        ["long language"] = () => NewCheckpoint() with { Language = Text(MaxLanguage + 1) },
        ["blank chapterKey"] = () => NewCheckpoint() with { ChapterKey = " " },
        ["share without its chapter"] = () => NewCheckpoint(Guid.NewGuid()) with { ChapterKey = null },
    };

    [Fact]
    public async Task ShareAsync_EveryFieldAtItsCap_ReachesTheRepository()
    {
        var atCaps = NewShare() with
        {
            ChapterKey = Text(MaxChapterKey),
            ChapterTitle = Text(MaxChapterTitle),
            ChapterText = Text(MaxChapterTextBytes),
            Notes = JsonOf("[\"" + Text(MaxNotesBytes - 4) + "\"]"),
            Language = Text(MaxLanguage),
        };

        Assert.IsNotType<SyncError>((await _service.ShareAsync(User, BookId, atCaps, Ct)).Body);
        Assert.IsNotType<SyncError>((await _service.ShareAsync(User, BookId, NewShare() with { ChapterText = EmojiAtCap }, Ct)).Body);
        await _shares.ReceivedWithAnyArgs(2).ShareAsync(default!, Ct);
    }

    [Theory]
    [InlineData("no operationId", "operationId", "must be a client-minted UUID")]
    [InlineData("blank chapterKey", "chapterKey", "chapterKey is required")]
    [InlineData("long chapterKey", "chapterKey", "is at most 200 characters")]
    [InlineData("long chapterTitle", "chapterTitle", "is at most 500 characters")]
    [InlineData("emoji text one byte over", "chapterText", "is at most 200 KB")]
    [InlineData("text with a NUL", "chapterText", "holds a NUL")]
    [InlineData("no notes", "notes", "must be a JSON array")]
    [InlineData("notes an object", "notes", "must be a JSON array")]
    [InlineData("notes repeat a member", "notes", "repeats a member name")]
    [InlineData("notes with a NUL", "notes", "holds a NUL")]
    [InlineData("notes non-finite", "notes", "out-of-range number")]
    [InlineData("notes nested non-finite", "notes", "out-of-range number")]
    [InlineData("notes one byte over", "notes", "is at most 64 KB")]
    [InlineData("long language", "language", "is at most 16 characters")]
    public async Task ShareAsync_InvalidPayload_RefusedNamingFieldAndWhyBeforeAnyWrite(string share, string field, string why)
    {
        var error = Error(await _service.ShareAsync(User, BookId, BadShares[share](), Ct));

        Assert.Equal((SyncCodes.InvalidPayload, field), (error.Code, error.Field));
        Assert.Contains(why, error.Message);
        await _shares.DidNotReceiveWithAnyArgs().ShareAsync(default!, Ct);
    }

    [Fact]
    public async Task SaveCheckpointAsync_OneSectionOrEverySectionAtItsCap_ReachesTheRepository()
    {
        var oneSection = NewCheckpoint() with { OpenQuestions = [] };
        var itemsAtCap = NewCheckpoint() with { Conclusions = Enumerable.Repeat("c", MaxSectionItems).ToArray() };
        var bytesAtCap = NewCheckpoint() with
        {
            ReaderThoughts = [Text(MaxSectionsBytes / 2)],
            Conclusions = [Text(MaxSectionsBytes / 2)],
            OpenQuestions = [],
        };

        foreach (var checkpoint in (CheckpointRequest[])[oneSection, itemsAtCap, bytesAtCap])
            Assert.IsNotType<SyncError>((await _service.SaveCheckpointAsync(User, BookId, checkpoint, Ct)).Body);
        await _checkpoints.ReceivedWithAnyArgs(3).AppendAsync(default!, Ct);
    }

    [Theory]
    [InlineData("no operationId", "operationId", "must be a client-minted UUID")]
    [InlineData("blank topic", "topic", "topic is required")]
    [InlineData("long topic", "topic", "is at most 500 characters")]
    [InlineData("all sections empty", "readerThoughts", "At least one section must have an item")]
    [InlineData("a section missing", "readerThoughts", "readerThoughts is required")]
    [InlineData("a section over its items", "conclusions", "has at most 50 items")]
    [InlineData("a blank item", "conclusions[1]", "conclusions[1] is required")]
    [InlineData("a null item", "conclusions[1]", "conclusions[1] is required")]
    [InlineData("an item with a NUL", "conclusions[1]", "holds a NUL")]
    [InlineData("sections over their bytes", "readerThoughts", "together are at most 32 KB")]
    [InlineData("no language", "language", "language is required")]
    [InlineData("long language", "language", "is at most 16 characters")]
    [InlineData("blank chapterKey", "chapterKey", "chapterKey is required")]
    [InlineData("share without its chapter", "chapterKey", "required with sharedChapterId")]
    public async Task SaveCheckpointAsync_InvalidPayload_RefusedNamingFieldAndWhyBeforeAnyWrite(string checkpoint, string field, string why)
    {
        var error = Error(await _service.SaveCheckpointAsync(User, BookId, BadCheckpoints[checkpoint](), Ct));

        Assert.Equal((SyncCodes.InvalidPayload, field), (error.Code, error.Field));
        Assert.Contains(why, error.Message);
        await _checkpoints.DidNotReceiveWithAnyArgs().AppendAsync(default!, Ct);
    }
}
