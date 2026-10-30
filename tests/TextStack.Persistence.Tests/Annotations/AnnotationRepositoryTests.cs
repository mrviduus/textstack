using System.Text.Json.Nodes;
using Domain.Annotations;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Annotations;

public class AnnotationRepositoryTests(V2PostgresFixture db)
{
    private readonly AnnotationRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Page3 = """{"version":1,"scheme":"pdf-page","value":{"page":3,"rects":[],"exact":"quoted"}}""";

    /// <summary>A highlight on page 3 of the book's current file.</summary>
    private static Annotation Highlight(Book book, string note = "a note") => new()
    {
        Id = Guid.NewGuid(),
        UserId = book.UserId,
        BookId = book.Id,
        FileId = book.CurrentFile!.Id,
        SelectedText = "quoted",
        NoteText = note,
        Locator = Page3,
    };

    private async Task<(Book Book, Annotation Stored)> SavedHighlightAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        var result = await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct);
        return (book, result.Current!);
    }

    private static Annotation Edit(Annotation stored, string note) => new()
    {
        Id = stored.Id,
        UserId = stored.UserId,
        BookId = stored.BookId,
        FileId = stored.FileId,
        SelectedText = stored.SelectedText,
        NoteText = note,
        Locator = stored.Locator,
        Color = stored.Color,
    };

    [Fact]
    public async Task SaveAsync_FirstWrite_CreatesTheRowAtRevisionOne()
    {
        var book = await db.NewReaderWithBookAsync();
        var highlight = Highlight(book);

        var result = await _repo.SaveAsync(book.UserId, highlight, null, Ct);

        Assert.True(result.Accepted);
        var stored = (await _repo.GetAsync(book.UserId, highlight.Id, Ct))!;
        Assert.Equal((1L, book.Id, book.CurrentFile!.Id, "quoted", "a note", "yellow", (DateTimeOffset?)null),
            (stored.Revision, stored.BookId, stored.FileId, stored.SelectedText, stored.NoteText, stored.Color, stored.DeletedAt));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(Page3), JsonNode.Parse(stored.Locator!)));
    }

    [Fact]
    public async Task SaveAsync_FirstWriteWhenTheIdExists_LosesAndReturnsTheRow()
    {
        var (book, stored) = await SavedHighlightAsync();

        var result = await _repo.SaveAsync(book.UserId, Edit(stored, "another"), null, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((1L, "a note"), (result.Current!.Revision, result.Current.NoteText));
    }

    [Fact]
    public async Task SaveAsync_MatchingRevision_WinsAndIncrementsTheRevision()
    {
        var (book, stored) = await SavedHighlightAsync();

        var result = await _repo.SaveAsync(book.UserId, Edit(stored, "edited"), 1, Ct);

        Assert.True(result.Accepted);
        Assert.Equal((2L, "edited"), (result.Current!.Revision, result.Current.NoteText));
        Assert.Equal("edited", (await _repo.GetAsync(book.UserId, stored.Id, Ct))!.NoteText);
    }

    [Fact]
    public async Task SaveAsync_StaleRevision_LosesAndReturnsTheWinnersRowIntact()
    {
        var (book, stored) = await SavedHighlightAsync();
        await _repo.SaveAsync(book.UserId, Edit(stored, "winner"), 1, Ct);

        var result = await _repo.SaveAsync(book.UserId, Edit(stored, "stale"), 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((2L, "winner"), (result.Current!.Revision, result.Current.NoteText));
        Assert.Equal("winner", (await _repo.GetAsync(book.UserId, stored.Id, Ct))!.NoteText);
    }

    [Fact]
    public async Task SaveAsync_DeletedAnnotationWithItsCurrentRevision_LosesAndStaysDeleted()
    {
        var (book, stored) = await SavedHighlightAsync();
        await _repo.DeleteAsync(book.UserId, stored.Id, Ct);

        var result = await _repo.SaveAsync(book.UserId, Edit(stored, "revived"), 2, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((2L, "a note"), (result.Current!.Revision, result.Current.NoteText));
        Assert.NotNull(result.Current.DeletedAt);
    }

    [Fact]
    public async Task SaveAsync_UnanchoredQuotation_IsStoredWithNoFileAndNoLocator()
    {
        var book = await db.NewReaderWithBookAsync();
        var quotation = Highlight(book);
        quotation.FileId = null;
        quotation.Locator = null;

        var result = await _repo.SaveAsync(book.UserId, quotation, null, Ct);

        Assert.True(result.Accepted);
        Assert.Equal(((Guid?)null, (string?)null, "quoted"), (result.Current!.FileId, result.Current.Locator, result.Current.SelectedText));
    }

    [Fact]
    public async Task SaveAsync_LocatorWithoutAFile_IsRefusedByTheCheck()
    {
        var book = await db.NewReaderWithBookAsync();
        var highlight = Highlight(book);
        highlight.FileId = null;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(book.UserId, highlight, null, Ct));

        Assert.Equal((PostgresErrorCodes.CheckViolation, "ck_annotations_locator_file"), (error.SqlState, error.ConstraintName));
        Assert.Null(await _repo.GetAsync(book.UserId, highlight.Id, Ct));
    }

    private async Task<Guid> FileOfAnotherBookAsync(Guid userId)
    {
        var other = new Book { Id = Guid.NewGuid(), UserId = userId, Title = "Another book" };
        return (await new LibraryRepository(db.DataSource).ImportAsync(other, NewFile(userId, other.Id), Ct)).CurrentFile!.Id;
    }

    [Fact]
    public async Task SaveAsync_FirstWriteOnAFileOfAnotherOwnBook_LosesAndCreatesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var highlight = Highlight(book);
        highlight.FileId = await FileOfAnotherBookAsync(book.UserId);

        var result = await _repo.SaveAsync(book.UserId, highlight, null, Ct);

        Assert.Equal((false, (Annotation?)null), (result.Accepted, result.Current));
        Assert.Null(await _repo.GetAsync(book.UserId, highlight.Id, Ct));
    }

    [Fact]
    public async Task SaveAsync_UpdateOntoAFileOfAnotherOwnBook_LosesAndKeepsTheStoredRow()
    {
        var (book, stored) = await SavedHighlightAsync();
        var moved = Edit(stored, "moved");
        moved.FileId = await FileOfAnotherBookAsync(book.UserId);

        var result = await _repo.SaveAsync(book.UserId, moved, 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal((1L, book.CurrentFile!.Id, "a note"), (result.Current!.Revision, result.Current.FileId, result.Current.NoteText));
    }

    [Fact]
    public async Task SaveAsync_AnnotationNamingAnotherUser_Throws()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.SaveAsync(Guid.NewGuid(), Highlight(book), null, Ct));
    }

    [Fact]
    public async Task ListForBookAsync_OwnBook_ReturnsLiveAnnotationsOldestFirst()
    {
        var (book, first) = await SavedHighlightAsync();
        var deleted = (await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct)).Current!;
        var last = (await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct)).Current!;
        await _repo.DeleteAsync(book.UserId, deleted.Id, Ct);

        var listed = await _repo.ListForBookAsync(book.UserId, book.Id, Ct);

        Assert.Equal([first.Id, last.Id], listed.Select(a => a.Id));
    }

    [Fact]
    public async Task GetAsync_DeletedAnnotation_ReturnsItWithDeletedAt()
    {
        var (book, stored) = await SavedHighlightAsync();
        await _repo.DeleteAsync(book.UserId, stored.Id, Ct);

        Assert.NotNull((await _repo.GetAsync(book.UserId, stored.Id, Ct))!.DeletedAt);
    }

    [Fact]
    public async Task DeleteAsync_LiveAnnotation_SetsDeletedAtAndBumpsTheRevisionOnce()
    {
        var (book, stored) = await SavedHighlightAsync();

        Assert.True(await _repo.DeleteAsync(book.UserId, stored.Id, Ct));
        Assert.False(await _repo.DeleteAsync(book.UserId, stored.Id, Ct));

        var read = (await _repo.GetAsync(book.UserId, stored.Id, Ct))!;
        Assert.Equal((2L, true), (read.Revision, read.DeletedAt is not null));
    }

    // updated_at is the sync feed's watermark: every revisioned write must move it.
    [Fact]
    public async Task SaveAndDelete_EachMoveUpdatedAt()
    {
        var (book, stored) = await SavedHighlightAsync();

        var edited = (await _repo.SaveAsync(book.UserId, Edit(stored, "edited"), 1, Ct)).Current!;
        await _repo.DeleteAsync(book.UserId, stored.Id, Ct);
        var deleted = (await _repo.GetAsync(book.UserId, stored.Id, Ct))!;

        Assert.True(edited.UpdatedAt > stored.UpdatedAt, "update");
        Assert.True(deleted.UpdatedAt > edited.UpdatedAt, "delete");
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ListForBookAsync_AlicesBookAsBob_ReturnsEmpty()
    {
        var (alices, _) = await SavedHighlightAsync();
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _repo.ListForBookAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task GetAsync_AlicesAnnotationAsBob_ReturnsNull()
    {
        var (_, alices) = await SavedHighlightAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.GetAsync(bob, alices.Id, Ct));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task SaveAsync_AlicesAnnotationAsBob_LosesAndChangesNothing(long? expectedRevision)
    {
        var (_, alices) = await SavedHighlightAsync();
        var bobsBook = await db.NewReaderWithBookAsync();
        var takeover = Edit(alices, "bob's");
        takeover.UserId = bobsBook.UserId;
        takeover.BookId = bobsBook.Id;
        takeover.FileId = bobsBook.CurrentFile!.Id;

        var result = await _repo.SaveAsync(bobsBook.UserId, takeover, expectedRevision, Ct);

        Assert.Equal((false, (Annotation?)null), (result.Accepted, result.Current));
        var read = (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal((1L, "a note", alices.BookId), (read.Revision, read.NoteText, read.BookId));
    }

    // Unanchored, so no file check can hide a missing owner filter in the update.
    [Fact]
    public async Task SaveAsync_UnanchoredEditOfAlicesAnnotationAsBob_LosesAndChangesNothing()
    {
        var (_, alices) = await SavedHighlightAsync();
        var bob = await db.NewReaderAsync();
        var takeover = Edit(alices, "bob's");
        takeover.UserId = bob;
        takeover.FileId = null;
        takeover.Locator = null;

        var result = await _repo.SaveAsync(bob, takeover, 1, Ct);

        Assert.Equal((false, (Annotation?)null), (result.Accepted, result.Current));
        var read = (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal((1L, "a note"), (read.Revision, read.NoteText));
    }

    [Fact]
    public async Task SaveAsync_FirstWriteOnAlicesBookAsBob_LosesAndCreatesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var intrusion = Highlight(alices);
        intrusion.UserId = bob;
        intrusion.FileId = null;
        intrusion.Locator = null;

        var result = await _repo.SaveAsync(bob, intrusion, null, Ct);

        Assert.Equal((false, (Annotation?)null), (result.Accepted, result.Current));
        Assert.Empty(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct));
    }

    [Fact]
    public async Task SaveAsync_AlicesFileOnBobsBook_LosesAndCreatesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bobsBook = await db.NewReaderWithBookAsync();
        var highlight = Highlight(bobsBook);
        highlight.FileId = alices.CurrentFile!.Id;

        var result = await _repo.SaveAsync(bobsBook.UserId, highlight, null, Ct);

        Assert.Equal((false, (Annotation?)null), (result.Accepted, result.Current));
        Assert.Null(await _repo.GetAsync(bobsBook.UserId, highlight.Id, Ct));
    }

    [Fact]
    public async Task DeleteAsync_AlicesAnnotationAsBob_ReturnsFalseAndKeepsItLive()
    {
        var (alices, stored) = await SavedHighlightAsync();
        var bob = await db.NewReaderAsync();

        Assert.False(await _repo.DeleteAsync(bob, stored.Id, Ct));
        Assert.Equal(stored.Id, Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct)).Id);
    }
}
