using System.Text.Json;
using Application.Annotations;
using Application.Common;
using Application.Library;
using Application.Sync;
using Application.Transitional;
using Contracts.V2;
using Domain.Annotations;
using Domain.Library;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>The annotation codes of v2-sync-protocol.md "M1.3 as merged", delta 1, derived on fakes.</summary>
public class AnnotationSyncServiceTests
{
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static readonly Guid Id = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly Mock<ILibraryRepository> _library = V2Fakes.Library(User, BookId, null, FileId);
    private readonly Mock<IAnnotationRepository> _annotations = new();
    private readonly Mock<IBookChapterRepository> _chapters = new();
    private AnnotationSyncService Service => new(_library.Object, _annotations.Object, _chapters.Object);

    private static string TextAnchor(string chapterKey) =>
        $$$"""{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"{{{chapterKey}}}","prefix":"It was a ","exact":"bright","suffix":" cold day","startOffset":9,"endOffset":15}}""";

    private static AnnotationRequest Highlight(string locator = """{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"bright"}""", Guid? fileId = null) =>
        new(2, BookId, fileId ?? FileId, "It was a bright cold day", "a note", JsonSerializer.Deserialize<JsonElement>(locator), null);

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

    private void Loses(Annotation? stored) =>
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(false, stored));


    [Fact]
    public async Task SaveAsync_EmptyId_IsInvalidPayloadAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Guid.Empty, Highlight(), Ct);

        Assert.Equal((400, "id"), (result.Status, V2Fakes.Error(result).Field));
        _annotations.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_BookThatIsNotTheUsers_IsBookNotFoundAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Id, Highlight() with { BookId = Guid.NewGuid() }, Ct);

        Assert.Equal((404, SyncCodes.BookNotFound), (result.Status, V2Fakes.Error(result).Code));
        _annotations.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_FileThatIsNoVersionOfTheBook_IsUnknownFileAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Id, Highlight(fileId: Guid.NewGuid()), Ct);

        Assert.Equal((409, SyncCodes.UnknownFile), (result.Status, V2Fakes.Error(result).Code));
        _annotations.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_LostToATombstone_IsDeletedWithIt()
    {
        Loses(Stored(4, DateTimeOffset.UtcNow));

        var error = V2Fakes.Error(await Service.SaveAsync(User, Id, Highlight(), Ct));

        Assert.Equal((SyncCodes.Deleted, (long?)4), (error.Code, error.Revision));
        Assert.NotNull(Assert.IsType<AnnotationDto>(error.Current).DeletedAt);
    }

    [Fact]
    public async Task SaveAsync_LostWithNothingStoredForTheUser_IsIdConflict()
    {
        Loses(null);

        Assert.Equal(SyncCodes.IdConflict, V2Fakes.Error(await Service.SaveAsync(User, Id, Highlight(), Ct)).Code);
    }

    [Fact]
    public async Task SaveAsync_LostToWhatItSent_IsItsOwnWriteAndOk()
    {
        Loses(Stored());

        var result = await Service.SaveAsync(User, Id, Highlight(), Ct);

        Assert.Equal((200, 3L), (result.Status, Assert.IsType<AnnotationDto>(result.Body).Revision));
    }

    [Fact]
    public async Task SaveAsync_LostToAnotherEdit_IsStaleRevision()
    {
        Loses(Stored(note: "another device's note"));

        var error = V2Fakes.Error(await Service.SaveAsync(User, Id, Highlight(), Ct));

        Assert.Equal((SyncCodes.StaleRevision, (long?)3), (error.Code, error.Revision));
    }

    [Fact]
    public async Task SaveAsync_AcceptedCreate_IsCreated()
    {
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(true, Stored(1)));

        Assert.Equal(201, (await Service.SaveAsync(User, Id, Highlight() with { ExpectedRevision = null }, Ct)).Status);
    }

    [Fact]
    public async Task SaveAsync_TextAnchorOnAChapterOfTheFile_IsWritten()
    {
        _chapters.Setup(c => c.ExistsAsync(User, FileId, "ch-1", It.IsAny<CancellationToken>())).ReturnsAsync(true);
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(true, Stored(1)));

        Assert.Equal(201, (await Service.SaveAsync(User, Id, Highlight(TextAnchor("ch-1")) with { ExpectedRevision = null }, Ct)).Status);
    }

    [Fact]
    public async Task SaveAsync_TextAnchorOnAChapterTheFileLacks_IsChapterNotFoundAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Id, Highlight(TextAnchor("no-such")), Ct);

        Assert.Equal((409, SyncCodes.ChapterNotFound), (result.Status, V2Fakes.Error(result).Code));
        _annotations.Verify(a => a.SaveAsync(It.IsAny<Guid>(), It.IsAny<Annotation>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    // A re-extraction renamed the chapter after the highlight landed: what keeps the stored locator still lands.
    [Fact]
    public async Task SaveAsync_EditKeepingAStoredAnchorWhoseChapterVanished_IsWritten()
    {
        var anchor = TextAnchor("renamed");
        _annotations.Setup(a => a.GetAsync(User, Id, It.IsAny<CancellationToken>())).ReturnsAsync(Stored(locator: anchor));
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), 2, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(true, Stored(3, note: "edited", locator: anchor)));

        var result = await Service.SaveAsync(User, Id, Highlight(anchor) with { NoteText = "edited" }, Ct);

        Assert.Equal(200, result.Status);
    }

    [Fact]
    public async Task SaveAsync_ReplayOfAStoredAnchorWhoseChapterVanished_IsItsOwnWrite()
    {
        var anchor = TextAnchor("renamed");
        Loses(Stored(locator: anchor));
        _annotations.Setup(a => a.GetAsync(User, Id, It.IsAny<CancellationToken>())).ReturnsAsync(Stored(locator: anchor));

        var result = await Service.SaveAsync(User, Id, Highlight(anchor), Ct);

        Assert.Equal((200, 3L), (result.Status, Assert.IsType<AnnotationDto>(result.Body).Revision));
    }

    [Fact]
    public async Task SaveAsync_EditMovingAnAnchorToAMissingChapter_IsChapterNotFound()
    {
        _annotations.Setup(a => a.GetAsync(User, Id, It.IsAny<CancellationToken>())).ReturnsAsync(Stored(locator: TextAnchor("ch-1")));

        var result = await Service.SaveAsync(User, Id, Highlight(TextAnchor("no-such")), Ct);

        Assert.Equal(SyncCodes.ChapterNotFound, V2Fakes.Error(result).Code);
        _annotations.Verify(a => a.SaveAsync(It.IsAny<Guid>(), It.IsAny<Annotation>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    // The file first: unknown_file keeps the write queued, chapter_not_found would drop it.
    [Fact]
    public async Task SaveAsync_TextAnchorOnAnUnknownFile_IsUnknownFile()
    {
        var result = await Service.SaveAsync(User, Id, Highlight(TextAnchor("no-such"), Guid.NewGuid()), Ct);

        Assert.Equal(SyncCodes.UnknownFile, V2Fakes.Error(result).Code);
    }

    [Fact]
    public async Task SaveAsync_SelectedTextOverItsCap_IsInvalidPayload()
    {
        var result = await Service.SaveAsync(User, Id, Highlight() with { SelectedText = new string('s', SyncLimits.MaxSelectedText + 1) }, Ct);

        Assert.Equal((400, "selectedText"), (result.Status, V2Fakes.Error(result).Field));
    }

    [Fact]
    public async Task SaveAsync_TextPositionAsAnAnnotation_IsInvalidPayload()
    {
        var result = await Service.SaveAsync(User, Id,
            Highlight("""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"ch-1","chapterFraction":0.5}}"""), Ct);

        Assert.Equal((400, "locator"), (result.Status, V2Fakes.Error(result).Field));
    }

    [Fact]
    public async Task SaveAsync_EpubCfiLocator_AsksNoChapter()
    {
        Loses(Stored());

        await Service.SaveAsync(User, Id, Highlight(), Ct);

        _chapters.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_LocatorWithoutAFile_IsInvalidPayload()
    {
        var error = V2Fakes.Error(await Service.SaveAsync(User, Id, Highlight() with { FileId = null }, Ct));

        Assert.Equal((SyncCodes.InvalidPayload, "fileId"), (error.Code, error.Field));
    }

    [Fact]
    public async Task DeleteAsync_AlreadyATombstone_IsOkWithIt()
    {
        _annotations.Setup(a => a.DeleteAsync(User, Id, It.IsAny<CancellationToken>())).ReturnsAsync(Stored(4, DateTimeOffset.UtcNow));

        Assert.Equal(200, (await Service.DeleteAsync(User, Id, Ct)).Status);
    }

    [Fact]
    public async Task DeleteAsync_IdTheServerNeverHad_IsNotFound() =>
        Assert.Equal(SyncCodes.NotFound, V2Fakes.Error(await Service.DeleteAsync(User, Id, Ct)).Code);
}
