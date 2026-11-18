using System.Text.Json;
using Application.Annotations;
using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.V2;
using Domain.Annotations;
using NSubstitute;

namespace TextStack.UnitTests.V2;

/// <summary>
/// A reader highlights a passage on the phone, edits the note on the web, deletes it: the annotation codes of
/// v2-sync-protocol.md "M1.3 as merged", delta 1, derived on fakes.
/// </summary>
public class AnnotationSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid Bob = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid Id = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Cfi = """{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"bright"}""";
    private const string PdfAnchor = """{"version":1,"scheme":"pdf-page","value":{"page":2,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"bright"}}""";
    private const string TextPosition = """{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.5}}""";
    private const string OnChapter = "ch-1";

    // The reader's one book, its file an epub with chapter ch-1; Bob has none of it.
    private readonly ILibraryRepository _library = V2Fakes.Library(User, BookId, FileId);
    private readonly IAnnotationRepository _annotations = Substitute.For<IAnnotationRepository>();
    private readonly IBookChapterRepository _chapters = Substitute.For<IBookChapterRepository>();

    public AnnotationSyncServiceTests()
    {
        _chapters.ExistsAsync(User, FileId, OnChapter, Arg.Any<CancellationToken>()).Returns(true);
        _chapters.ClearReceivedCalls();
    }

    private AnnotationSyncService Service => new(_library, _annotations, _chapters);

    private static string TextAnchor(string chapterKey) =>
        $$$"""{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"{{{chapterKey}}}","prefix":"It was a ","exact":"bright","suffix":" cold day","startOffset":9,"endOffset":15}}""";

    /// <summary>A highlight in the book; no locator means no file either (a bare note).</summary>
    private static AnnotationRequest Highlight(string? locator = Cfi, Guid? fileId = null, long? expectedRevision = 2, string note = "a note") =>
        new(expectedRevision, BookId, locator is null ? null : fileId ?? FileId, "It was a bright cold day", note,
            locator is null ? null : JsonSerializer.Deserialize<JsonElement>(locator), null);

    private static Annotation Stored(long revision = 3, DateTimeOffset? deletedAt = null, string note = "a note", string? locator = null) => new()
    {
        Id = Id,
        UserId = User,
        BookId = BookId,
        FileId = FileId,
        SelectedText = "It was a bright cold day",
        NoteText = note,
        // Another key order, as jsonb gives it back.
        Locator = locator ?? """{"quote":"bright","value":"epubcfi(/6/4!/4/2/1:0)","scheme":"epub-cfi","version":1}""",
        Color = "yellow",
        Revision = revision,
        DeletedAt = deletedAt,
    };

    private void FileIs(string format) => _library.FileFormatAsync(User, BookId, FileId, Arg.Any<CancellationToken>()).Returns(format);

    private void HasStored(Annotation stored) => _annotations.GetAsync(User, Id, Arg.Any<CancellationToken>()).Returns(stored);

    private void Accepts() =>
        _annotations.SaveAsync(User, Arg.Any<Annotation>(), Arg.Any<long?>(), Arg.Any<CancellationToken>())
            .Returns(call => new RevisionedWrite<Annotation>(true, call.Arg<Annotation>()));

    private void Loses(Annotation? stored) =>
        _annotations.SaveAsync(User, Arg.Any<Annotation>(), Arg.Any<long?>(), Arg.Any<CancellationToken>())
            .Returns(new RevisionedWrite<Annotation>(false, stored));

    private void WroteNothing() => _ = _annotations.DidNotReceiveWithAnyArgs().SaveAsync(default, default!, default, Ct);

    [Fact]
    public async Task SaveAsync_HighlightOnThePhoneEditedOnTheWeb_IsCreatedThenUpdated()
    {
        _annotations.SaveAsync(User, Arg.Any<Annotation>(), Arg.Is<long?>(r => r == null), Arg.Any<CancellationToken>())
            .Returns(new RevisionedWrite<Annotation>(true, Stored(1, locator: TextAnchor(OnChapter))));
        _annotations.SaveAsync(User, Arg.Any<Annotation>(), Arg.Is<long?>(r => r == 1), Arg.Any<CancellationToken>())
            .Returns(new RevisionedWrite<Annotation>(true, Stored(2, note: "edited", locator: TextAnchor(OnChapter))));

        var created = await Service.SaveAsync(User, Id, Highlight(TextAnchor(OnChapter), expectedRevision: null), Ct);
        var edited = await Service.SaveAsync(User, Id, Highlight(TextAnchor(OnChapter), expectedRevision: 1, note: "edited") with { Color = "green" }, Ct);

        Assert.Equal((201, 1L), (created.Status, Assert.IsType<AnnotationDto>(created.Body).Revision));
        Assert.Equal((200, 2L, "edited"), (edited.Status, Assert.IsType<AnnotationDto>(edited.Body).Revision, Assert.IsType<AnnotationDto>(edited.Body).NoteText));
        // The phone sent no color: yellow. The web picked green. Both carry the anchor as sent.
        await _annotations.Received(1).SaveAsync(User,
            Arg.Is<Annotation>(a => a.Id == Id && a.BookId == BookId && a.FileId == FileId && a.Color == "yellow" && a.NoteText == "a note" && a.Locator == TextAnchor(OnChapter)),
            Arg.Is<long?>(r => r == null), Arg.Any<CancellationToken>());
        await _annotations.Received(1).SaveAsync(User, Arg.Is<Annotation>(a => a.Color == "green" && a.NoteText == "edited"),
            Arg.Is<long?>(r => r == 1), Arg.Any<CancellationToken>());
    }

    // The file's format is read with the provenance check: a misfit costs no second round trip (#1122).
    [Theory]
    [InlineData("id", Cfi, null, "id must be a client-minted UUID")]
    [InlineData("selectedText", Cfi, null, "selectedText is at most")]
    [InlineData("locator", TextPosition, null, "reading position only")]
    [InlineData("fileId", Cfi, null, "fileId is required")]
    [InlineData("locator", PdfAnchor, "epub", "A pdf-page locator does not fit a epub file")]
    [InlineData("locator", PdfAnchor, "html", "A pdf-page locator does not fit a html file")]
    [InlineData("locator", Cfi, "pdf", "A epub-cfi locator does not fit a pdf file")]
    public async Task SaveAsync_HighlightTheServerCannotStore_IsInvalidPayloadSayingWhyAndWritesNothing(
        string field, string locator, string? format, string why)
    {
        if (format is not null) FileIs(format);
        var highlight = field switch
        {
            "selectedText" => Highlight(locator) with { SelectedText = new string('s', SyncLimits.MaxSelectedText + 1) },
            "fileId" => Highlight(locator) with { FileId = null },
            _ => Highlight(locator),
        };

        var result = await Service.SaveAsync(User, field == "id" ? Guid.Empty : Id, highlight, Ct);

        var error = V2Fakes.Error(result);
        Assert.Equal((400, SyncCodes.InvalidPayload, field), (result.Status, error.Code, error.Field));
        Assert.Contains(why, error.Message);
        WroteNothing();
        _ = _library.DidNotReceiveWithAnyArgs().ExistsAsync(default, default, Ct);
        // A payload refused on its face asks no repository anything.
        if (format is null) Assert.Empty(_library.ReceivedCalls().Concat(_annotations.ReceivedCalls()).Concat(_chapters.ReceivedCalls()));
    }

    // The file first: unknown_file keeps the write queued, chapter_not_found would drop it.
    [Theory]
    [InlineData(true, true, false, 404, SyncCodes.BookNotFound)]   // Bob sends the reader's book and file ids
    [InlineData(true, false, false, 404, SyncCodes.BookNotFound)]  // Bob sends the reader's book id, a note with no locator
    [InlineData(false, true, false, 409, SyncCodes.UnknownFile)]   // a file that is no version of the book
    [InlineData(false, true, true, 409, SyncCodes.UnknownFile)]    // ... with a text anchor on a chapter nobody has
    public async Task SaveAsync_HighlightOnABookOrFileNotTheReaders_IsRefusedAndWritesNothing(
        bool asBob, bool withFile, bool onMissingChapter, int status, string code)
    {
        var locator = !withFile ? null : onMissingChapter ? TextAnchor("no-such") : Cfi;

        var result = await Service.SaveAsync(asBob ? Bob : User, Id, Highlight(locator, asBob ? FileId : Guid.NewGuid()), Ct);

        Assert.Equal((status, code), (result.Status, V2Fakes.Error(result).Code));
        Assert.Empty(_annotations.ReceivedCalls());
        Assert.Empty(_chapters.ReceivedCalls());
    }

    // A text anchor (textstack-anchor-v1 on chapter ch-1) fits any file; only it asks for its chapter.
    [Theory]
    [InlineData(PdfAnchor, "pdf", false)]
    [InlineData(Cfi, "epub", false)]
    [InlineData(Cfi, "html", false)]
    [InlineData(null, "epub", true)]
    [InlineData(null, "pdf", true)]
    public async Task SaveAsync_LocatorSchemeThatFitsTheFile_Writes(string? locator, string format, bool asksChapter)
    {
        FileIs(format);
        Accepts();

        var result = await Service.SaveAsync(User, Id, Highlight(locator ?? TextAnchor(OnChapter)), Ct);

        Assert.Equal(200, result.Status);
        if (asksChapter) _ = _chapters.Received(1).ExistsAsync(User, FileId, OnChapter, Arg.Any<CancellationToken>());
        else Assert.Empty(_chapters.ReceivedCalls());
    }

    // An annotation stored before the scheme check (#1122): an edit keeping its locator lands, one moving it is refused.
    [Theory]
    [InlineData(Cfi, 200, null)]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/2!/4/2/1:0)","quote":"bright"}""", 400, "A epub-cfi locator does not fit a pdf file")]
    public async Task SaveAsync_EditOfAMisfitLocatorStoredBeforeTheCheck_LandsOnlyIfItKeepsIt(string storedLocator, int status, string? why)
    {
        FileIs("pdf");
        Accepts();
        HasStored(Stored(locator: storedLocator));

        var result = await Service.SaveAsync(User, Id, Highlight(note: "an edit"), Ct);

        Assert.Equal(status, result.Status);
        if (why is null) return;
        var error = V2Fakes.Error(result);
        Assert.Equal((SyncCodes.InvalidPayload, "locator"), (error.Code, error.Field));
        Assert.Contains(why, error.Message);
        WroteNothing();
    }

    // A re-extraction renamed the chapter after the highlight landed: what keeps the stored anchor still lands.
    // A replay's write loses to the row it already wrote: the answer is that stored row (revision 3), not an echo.
    [Theory]
    [InlineData("renamed", "renamed", "edited", 2L, true, 200, null, null)]                       // an edit of the note
    [InlineData("renamed", "renamed", "a note", 2L, false, 200, 3L, null)]                        // a replay whose response was lost
    [InlineData(OnChapter, "no-such", "a note", 2L, true, 409, null, SyncCodes.ChapterNotFound)] // an edit moving it off the file
    [InlineData(null, "no-such", "a note", null, true, 409, null, SyncCodes.ChapterNotFound)]    // a new highlight
    public async Task SaveAsync_AnchorOnAChapterTheFileLacks_LandsOnlyIfItIsTheStoredOne(
        string? storedChapter, string sentChapter, string note, long? expectedRevision, bool accepts, int status, long? storedRevision, string? code)
    {
        if (storedChapter is not null) HasStored(Stored(locator: TextAnchor(storedChapter)));
        if (accepts) Accepts();
        else Loses(Stored(locator: TextAnchor(storedChapter!)));

        var result = await Service.SaveAsync(User, Id, Highlight(TextAnchor(sentChapter), expectedRevision: expectedRevision, note: note), Ct);

        Assert.Equal(status, result.Status);
        if (code is not null)
        {
            Assert.Equal(code, V2Fakes.Error(result).Code);
            WroteNothing();
            return;
        }
        var dto = Assert.IsType<AnnotationDto>(result.Body);
        Assert.Equal(note, dto.NoteText);
        if (storedRevision is not null)
        {
            Assert.Equal(storedRevision, dto.Revision);
            // The one write it tried is the one that lost: nothing new was stored.
            Assert.Single(_annotations.ReceivedCalls(), c => c.GetMethodInfo().Name == nameof(IAnnotationRepository.SaveAsync));
        }
    }

    // A bare note: no locator, so no file and no chapter to check.
    [Fact]
    public async Task SaveAsync_BareNoteInTheReadersBook_IsWrittenWithNoFile()
    {
        Accepts();

        var result = await Service.SaveAsync(User, Id, Highlight(locator: null, expectedRevision: null), Ct);

        var dto = Assert.IsType<AnnotationDto>(result.Body);
        Assert.Equal((201, (Guid?)null, (string?)null), (result.Status, dto.FileId, dto.Locator));
        _ = _annotations.Received(1).SaveAsync(User, Arg.Is<Annotation>(a => a.FileId == null && a.Locator == null), Arg.Is<long?>(r => r == null), Arg.Any<CancellationToken>());
        Assert.Empty(_chapters.ReceivedCalls());
    }

    [Theory]
    [InlineData(4L, true, "a note", SyncCodes.Deleted, 4L)]                      // deleted on the phone: no device brings it back
    [InlineData(3L, false, "another device's note", SyncCodes.StaleRevision, 3L)]
    [InlineData(3L, false, "a note", null, 3L)]                                   // its own write, whose response was lost
    [InlineData(null, false, "a note", SyncCodes.IdConflict, null)]               // the id is someone else's row
    public async Task SaveAsync_WriteThatLostTheRace_AnswersWhatItLostTo(long? storedRevision, bool deleted, string storedNote, string? code, long? revision)
    {
        Loses(storedRevision is { } r ? Stored(r, deleted ? DateTimeOffset.UtcNow : null, storedNote) : null);

        var result = await Service.SaveAsync(User, Id, Highlight(), Ct);

        if (code is null)
        {
            Assert.Equal((200, revision), (result.Status, (long?)Assert.IsType<AnnotationDto>(result.Body).Revision));
            return;
        }
        var error = V2Fakes.Error(result);
        Assert.Equal((409, code, revision), (result.Status, error.Code, error.Revision));
        if (storedRevision is null) Assert.Null(error.Current);
        else
        {
            var current = Assert.IsType<AnnotationDto>(error.Current);
            Assert.Equal((storedNote, deleted), (current.NoteText, current.DeletedAt is not null));
        }
    }

    [Fact]
    public async Task DeleteAsync_ReaderDeletesAHighlightTwice_AnswersTheTombstoneEachTime()
    {
        _annotations.DeleteAsync(User, Id, Arg.Any<CancellationToken>()).Returns(Stored(4, DateTimeOffset.UtcNow));

        var first = await Service.DeleteAsync(User, Id, Ct);
        var again = await Service.DeleteAsync(User, Id, Ct);
        var neverHad = await Service.DeleteAsync(User, Guid.NewGuid(), Ct);
        var bobs = await Service.DeleteAsync(Bob, Id, Ct);

        foreach (var tombstone in new[] { first, again })
        {
            var dto = Assert.IsType<AnnotationDto>(tombstone.Body);
            Assert.Equal((200, 4L, true), (tombstone.Status, dto.Revision, dto.DeletedAt is not null));
        }
        Assert.Equal((404, SyncCodes.NotFound), (neverHad.Status, V2Fakes.Error(neverHad).Code));
        Assert.Equal((404, SyncCodes.NotFound), (bobs.Status, V2Fakes.Error(bobs).Code));
    }

    [Fact]
    public async Task ChangesAsync_TheWebPulls_GetsTheEditAndTheTombstone()
    {
        IReadOnlyList<Annotation> changed = [Stored(3, note: "edited"), Stored(4, DateTimeOffset.UtcNow)];
        _annotations.ListChangedAsync(User, DateTimeOffset.UnixEpoch, Guid.Empty, Arg.Any<int>(), Arg.Any<CancellationToken>()).Returns(changed);

        var result = await Service.ChangesAsync(User, null, null, Ct);

        var feed = Assert.IsType<ChangeFeedDto<AnnotationDto>>(result.Body);
        Assert.Equal(new (string?, bool)[] { ("edited", false), ("a note", true) }, feed.Items.Select(a => (a.NoteText, a.DeletedAt is not null)));
        Assert.False(feed.HasMore);
    }
}
