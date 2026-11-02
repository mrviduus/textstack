using System.Text.Json;
using Application.Annotations;
using Application.Common;
using Application.Library;
using Application.Sync;
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

    private readonly Mock<ILibraryRepository> _library = new();
    private readonly Mock<IAnnotationRepository> _annotations = new();
    private AnnotationSyncService Service => new(_library.Object, _annotations.Object, TimeProvider.System);

    public AnnotationSyncServiceTests()
    {
        _library.Setup(l => l.GetAsync(User, BookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book { Id = BookId, UserId = User });
        _library.Setup(l => l.GetFileAsync(User, BookId, FileId, It.IsAny<CancellationToken>())).ReturnsAsync(new BookFile { Id = FileId, BookId = BookId });
    }

    private static AnnotationRequest Highlight(string locator = """{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4!/4/2/1:0)","quote":"bright"}""", Guid? fileId = null) =>
        new(2, BookId, fileId ?? FileId, "It was a bright cold day", "a note", JsonSerializer.Deserialize<JsonElement>(locator), null);

    private static Annotation Stored(long revision = 3, DateTimeOffset? deletedAt = null, string note = "a note") => new()
    {
        Id = Id,
        UserId = User,
        BookId = BookId,
        FileId = FileId,
        SelectedText = "It was a bright cold day",
        NoteText = note,
        // Another key order, as jsonb gives it back.
        Locator = """{"quote":"bright","value":"epubcfi(/6/4!/4/2/1:0)","scheme":"epub-cfi","version":1}""",
        Color = "yellow",
        Revision = revision,
        DeletedAt = deletedAt,
    };

    private void Loses(Annotation? stored) =>
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), It.IsAny<long?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(false, stored));

    private static V2Error Error(SyncResult result) => Assert.IsType<V2Error>(result.Body);

    [Fact]
    public async Task SaveAsync_BookThatIsNotTheUsers_IsBookNotFoundAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Id, Highlight() with { BookId = Guid.NewGuid() }, Ct);

        Assert.Equal((SyncStatus.NotFound, SyncCodes.BookNotFound), (result.Status, Error(result).Code));
        _annotations.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_FileThatIsNoVersionOfTheBook_IsUnknownFileAndWritesNothing()
    {
        var result = await Service.SaveAsync(User, Id, Highlight(fileId: Guid.NewGuid()), Ct);

        Assert.Equal((SyncStatus.Conflict, SyncCodes.UnknownFile), (result.Status, Error(result).Code));
        _annotations.VerifyNoOtherCalls();
    }

    [Fact]
    public async Task SaveAsync_LostToATombstone_IsDeletedWithIt()
    {
        Loses(Stored(4, DateTimeOffset.UtcNow));

        var error = Error(await Service.SaveAsync(User, Id, Highlight(), Ct));

        Assert.Equal((SyncCodes.Deleted, (long?)4), (error.Code, error.Revision));
        Assert.NotNull(Assert.IsType<AnnotationDto>(error.Current).DeletedAt);
    }

    [Fact]
    public async Task SaveAsync_LostWithNothingStoredForTheUser_IsIdConflict()
    {
        Loses(null);

        Assert.Equal(SyncCodes.IdConflict, Error(await Service.SaveAsync(User, Id, Highlight(), Ct)).Code);
    }

    [Fact]
    public async Task SaveAsync_LostToWhatItSent_IsItsOwnWriteAndOk()
    {
        Loses(Stored());

        var result = await Service.SaveAsync(User, Id, Highlight(), Ct);

        Assert.Equal((SyncStatus.Ok, 3L), (result.Status, Assert.IsType<AnnotationDto>(result.Body).Revision));
    }

    [Fact]
    public async Task SaveAsync_LostToAnotherEdit_IsStaleRevision()
    {
        Loses(Stored(note: "another device's note"));

        var error = Error(await Service.SaveAsync(User, Id, Highlight(), Ct));

        Assert.Equal((SyncCodes.StaleRevision, (long?)3), (error.Code, error.Revision));
    }

    [Fact]
    public async Task SaveAsync_AcceptedCreate_IsCreated()
    {
        _annotations.Setup(a => a.SaveAsync(User, It.IsAny<Annotation>(), null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new RevisionedWrite<Annotation>(true, Stored(1)));

        Assert.Equal(SyncStatus.Created, (await Service.SaveAsync(User, Id, Highlight() with { ExpectedRevision = null }, Ct)).Status);
    }

    [Fact]
    public async Task SaveAsync_LocatorWithoutAFile_IsInvalidPayload()
    {
        var error = Error(await Service.SaveAsync(User, Id, Highlight() with { FileId = null }, Ct));

        Assert.Equal((SyncCodes.InvalidPayload, "fileId"), (error.Code, error.Field));
    }

    [Fact]
    public async Task DeleteAsync_AlreadyATombstone_IsOkWithIt()
    {
        _annotations.Setup(a => a.GetAsync(User, Id, It.IsAny<CancellationToken>())).ReturnsAsync(Stored(4, DateTimeOffset.UtcNow));

        Assert.Equal(SyncStatus.Ok, (await Service.DeleteAsync(User, Id, Ct)).Status);
    }

    [Fact]
    public async Task DeleteAsync_IdTheServerNeverHad_IsNotFound() =>
        Assert.Equal(SyncCodes.NotFound, Error(await Service.DeleteAsync(User, Id, Ct)).Code);
}
