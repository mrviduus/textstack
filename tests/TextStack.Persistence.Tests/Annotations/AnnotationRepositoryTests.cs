using Domain.Annotations;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.TestJson;

namespace TextStack.Persistence.Tests.Annotations;

public class AnnotationRepositoryTests(PostgresFixture db)
{
    private readonly AnnotationRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>A highlight on page 3 of the book's current file.</summary>
    private static Annotation Highlight(Book book, string note = "a note") => new()
    {
        Id = Guid.NewGuid(),
        UserId = book.UserId,
        BookId = book.Id,
        FileId = book.CurrentFile!.Id,
        SelectedText = "quoted",
        NoteText = note,
        Locator = Cfi(3),
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

    // A highlight's life on two devices: each write names the revision it read, and only that revision wins.
    [Fact]
    public async Task SaveAsync_AReaderHighlightsAndEditsOnTwoDevices_OnlyTheWriteNamingTheCurrentRevisionWins()
    {
        var book = await db.NewReaderWithBookAsync();
        var highlight = Highlight(book);

        var created = await _repo.SaveAsync(book.UserId, highlight, null, Ct);

        Assert.True(created.Accepted);
        var stored = (await _repo.GetAsync(book.UserId, highlight.Id, Ct))!;
        Assert.Equal((1L, book.Id, book.CurrentFile!.Id, "quoted", "a note", "yellow", (DateTimeOffset?)null),
            (stored.Revision, stored.BookId, stored.FileId, stored.SelectedText, stored.NoteText, stored.Color, stored.DeletedAt));
        AssertSameJson(Cfi(3), stored.Locator);

        // The second device replays the create: the id exists, so it loses and is shown the stored row.
        var replay = await _repo.SaveAsync(book.UserId, Edit(stored, "another"), null, Ct);
        Assert.False(replay.Accepted);
        Assert.Equal((1L, "a note"), (replay.Current!.Revision, replay.Current.NoteText));

        // The first device edits at revision 1 and wins; the edit moves updated_at, the sync feed's watermark.
        var winner = await _repo.SaveAsync(book.UserId, Edit(stored, "winner"), 1, Ct);
        Assert.True(winner.Accepted);
        Assert.Equal((2L, "winner"), (winner.Current!.Revision, winner.Current.NoteText));
        Assert.True(winner.Current.UpdatedAt > stored.UpdatedAt, "an edit moves updated_at");

        // The second device still holds revision 1: it loses and the winner's row stays intact.
        var stale = await _repo.SaveAsync(book.UserId, Edit(stored, "stale"), 1, Ct);
        Assert.False(stale.Accepted);
        Assert.Equal((2L, "winner"), (stale.Current!.Revision, stale.Current.NoteText));
        Assert.Equal("winner", (await _repo.GetAsync(book.UserId, stored.Id, Ct))!.NoteText);
    }

    // Erasing leaves a tombstone the sync feed carries; nothing brings it back.
    [Fact]
    public async Task DeleteAsync_AReaderErasesAHighlight_LeavesOneTombstoneThatNoEditRevives()
    {
        var (book, first) = await SavedHighlightAsync();
        var erased = (await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct)).Current!;
        var last = (await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct)).Current!;

        var tombstone = (await _repo.DeleteAsync(book.UserId, erased.Id, Ct))!;
        var again = (await _repo.DeleteAsync(book.UserId, erased.Id, Ct))!;

        // Deleted once: revision bumped once, the second delete returns the same tombstone.
        Assert.Equal((2L, true), (tombstone.Revision, tombstone.DeletedAt is not null));
        Assert.Equal((2L, tombstone.DeletedAt), (again.Revision, again.DeletedAt));
        Assert.True(tombstone.UpdatedAt > erased.UpdatedAt, "a delete moves updated_at");
        // The book's list shows the live ones, oldest first.
        Assert.Equal([first.Id, last.Id], (await _repo.ListForBookAsync(book.UserId, book.Id, Ct)).Select(a => a.Id));

        // An edit naming the tombstone's current revision loses; the row stays deleted and unedited.
        var revived = await _repo.SaveAsync(book.UserId, Edit(erased, "revived"), 2, Ct);
        Assert.False(revived.Accepted);
        Assert.Equal((2L, "a note"), (revived.Current!.Revision, revived.Current.NoteText));
        Assert.NotNull(revived.Current.DeletedAt);

        // An id the reader never had: nothing to erase.
        Assert.Null(await _repo.DeleteAsync(book.UserId, Guid.NewGuid(), Ct));
    }

    [Fact]
    public async Task ListChangedAsync_ADeviceCatchesUp_GetsLiveAndErasedHighlightsInUpdateOrderPageByPage()
    {
        var (book, erased) = await SavedHighlightAsync();
        var live = (await _repo.SaveAsync(book.UserId, Highlight(book), null, Ct)).Current!;
        await _repo.DeleteAsync(book.UserId, erased.Id, Ct); // now the later of the two

        var all = await _repo.ListChangedAsync(book.UserId, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct);
        var after = await _repo.ListChangedAsync(book.UserId, live.UpdatedAt, live.Id, 10, Ct);

        Assert.Equal([live.Id, erased.Id], all.Select(a => a.Id));
        Assert.NotNull(all[1].DeletedAt);
        Assert.Equal(erased.Id, Assert.Single(after).Id);
        Assert.Single(await _repo.ListChangedAsync(book.UserId, DateTimeOffset.UnixEpoch, Guid.Empty, 1, Ct));
    }

    // A highlight points at a file of its own book, or at no file at all; the schema refuses the rest.
    [Fact]
    public async Task SaveAsync_AHighlightsFileAndLocator_StayOnItsOwnBooksFile()
    {
        var (book, stored) = await SavedHighlightAsync();
        var otherBook = await db.NewBookAsync(book.UserId, "Another book");

        // A quotation with no position: no file, no locator, stored.
        var quotation = Highlight(book);
        quotation.FileId = null;
        quotation.Locator = null;
        var quoted = await _repo.SaveAsync(book.UserId, quotation, null, Ct);
        Assert.True(quoted.Accepted);
        Assert.Equal(((Guid?)null, (string?)null, "quoted"), (quoted.Current!.FileId, quoted.Current.Locator, quoted.Current.SelectedText));

        // A locator without a file: refused by the check.
        var unfiled = Highlight(book);
        unfiled.FileId = null;
        var check = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(book.UserId, unfiled, null, Ct));
        Assert.Equal((PostgresErrorCodes.CheckViolation, "ck_annotations_locator_file"), (check.SqlState, check.ConstraintName));
        Assert.Null(await _repo.GetAsync(book.UserId, unfiled.Id, Ct));

        // A first write on the other book's file: refused by the deferred foreign key.
        var misfiled = Highlight(book);
        misfiled.FileId = otherBook.CurrentFile!.Id;
        var onInsert = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(book.UserId, misfiled, null, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_annotations_book_files_user_id_book_id_file_id"),
            (onInsert.SqlState, onInsert.ConstraintName));
        Assert.Null(await _repo.GetAsync(book.UserId, misfiled.Id, Ct));

        // An edit moving the stored highlight onto the other book's file: refused the same way.
        var moved = Edit(stored, "moved");
        moved.FileId = otherBook.CurrentFile.Id;
        var onUpdate = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(book.UserId, moved, 1, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_annotations_book_files_user_id_book_id_file_id"),
            (onUpdate.SqlState, onUpdate.ConstraintName));

        // An edit naming the other book (no file): a highlight never changes book, so it loses.
        var rebooked = Edit(stored, "moved");
        rebooked.BookId = otherBook.Id;
        rebooked.FileId = null;
        rebooked.Locator = null;
        var lost = await _repo.SaveAsync(book.UserId, rebooked, 1, Ct);
        Assert.False(lost.Accepted);
        Assert.Equal((1L, book.Id, "a note"), (lost.Current!.Revision, lost.Current.BookId, lost.Current.NoteText));

        var read = (await _repo.GetAsync(book.UserId, stored.Id, Ct))!;
        Assert.Equal((1L, book.Id, book.CurrentFile!.Id, "a note"), (read.Revision, read.BookId, read.FileId, read.NoteText));
    }

    // Her id onto his own book and file, as a create (null) and as an edit (1): loses, he is shown nothing, hers is unchanged.
    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task SaveAsync_AlicesIdOnBobsOwnBook_LosesShowsNothingAndChangesNothing(long? expectedRevision)
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

    // Owner isolation: bob, holding alice's ids, never reads, changes or deletes her highlights, nor writes onto her book or file.
    [Fact]
    public async Task EveryMethod_AnotherReaderHoldingAlicesIds_NeverReadsChangesOrDeletesHerHighlights()
    {
        var (alicesBook, alices) = await SavedHighlightAsync();
        var bobsBook = await db.NewReaderWithBookAsync();
        var bob = bobsBook.UserId;

        Assert.Empty(await _repo.ListForBookAsync(bob, alicesBook.Id, Ct));
        Assert.Null(await _repo.GetAsync(bob, alices.Id, Ct));
        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));

        // An unanchored edit on her own book: only the owner filter stops it.
        var unanchored = Edit(alices, "bob's");
        unanchored.UserId = bob;
        unanchored.FileId = null;
        unanchored.Locator = null;
        var edit = await _repo.SaveAsync(bob, unanchored, 1, Ct);
        Assert.Equal((false, (Annotation?)null), (edit.Accepted, edit.Current));

        // A new highlight on her book: refused by the book's foreign key.
        var intrusion = Highlight(alicesBook);
        intrusion.UserId = bob;
        intrusion.FileId = null;
        intrusion.Locator = null;
        var onBook = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(bob, intrusion, null, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_annotations_books_user_id_book_id"), (onBook.SqlState, onBook.ConstraintName));

        // His book with her file: refused by the deferred file foreign key.
        var herFile = Highlight(bobsBook);
        herFile.FileId = alicesBook.CurrentFile!.Id;
        var onFile = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(bob, herFile, null, Ct));
        Assert.Equal((PostgresErrorCodes.ForeignKeyViolation, "fk_annotations_book_files_user_id_book_id_file_id"),
            (onFile.SqlState, onFile.ConstraintName));
        Assert.Null(await _repo.GetAsync(bob, herFile.Id, Ct));

        Assert.Null(await _repo.DeleteAsync(bob, alices.Id, Ct));

        // A highlight whose entity names alice is stored under the caller, bob.
        var misnamed = Highlight(bobsBook);
        misnamed.UserId = alicesBook.UserId;
        Assert.Equal(bob, (await _repo.SaveAsync(bob, misnamed, null, Ct)).Current!.UserId);
        Assert.Null(await _repo.GetAsync(alicesBook.UserId, misnamed.Id, Ct));

        // Alice's highlight is untouched and still her only one, live.
        var read = (await _repo.GetAsync(alicesBook.UserId, alices.Id, Ct))!;
        Assert.Equal((1L, "a note", alicesBook.Id), (read.Revision, read.NoteText, read.BookId));
        Assert.Equal(alices.Id, Assert.Single(await _repo.ListForBookAsync(alicesBook.UserId, alicesBook.Id, Ct)).Id);
        Assert.Equal(1L, await db.CountAsync("annotations", alicesBook.UserId));
    }

    private const string AnchorC1 = """{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"c1","prefix":"before ","exact":"Quoted","suffix":" after","startOffset":7,"endOffset":13}}""";

    /// <summary>A reader's book whose current file's synced TOC (ADR-033) has chapter <c>c1</c>, "Chapter One".</summary>
    private async Task<Book> BookWithChapterAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        await new LibraryRepository(db.DataSource).SetTocAsync(book.UserId, book.Id, book.CurrentFile!.Id,
            """[{"key":"c0","title":"Cover","depth":0,"fraction":0},{"key":"c1","title":"Chapter One","depth":0,"fraction":0.1}]""", Ct);
        return book;
    }

    private async Task<Annotation> SaveAsync(Book book, string text, string color = "yellow", string? note = null, string locator = AnchorC1) =>
        (await _repo.SaveAsync(book.UserId, new Annotation
        {
            Id = Guid.NewGuid(),
            UserId = book.UserId,
            BookId = book.Id,
            FileId = book.CurrentFile!.Id,
            SelectedText = text,
            NoteText = note,
            Locator = locator,
            Color = color,
        }, null, Ct)).Current!;

    // The highlights page (GET /me/highlights/all in v2 mode): one reader's highlights across their books.
    [Fact]
    public async Task ListAllAsync_AReadersHighlightsPage_ListsTheirLiveHighlightsWithBookChapterAndQuote()
    {
        var moby = await BookWithChapterAsync();
        var quoted = await SaveAsync(moby, "Quoted whale", "blue");
        var noted = await SaveAsync(moby, "Call me", "blue", note: "a WHALE of an opening", locator: Cfi(2));
        await SaveAsync(moby, "A yellow whale");
        await _repo.DeleteAsync(moby.UserId, (await SaveAsync(moby, "Erased whale", "blue")).Id, Ct);
        var trashed = await db.NewBookAsync(moby.UserId, "Trashed");
        await SaveAsync(trashed, "Whale in the trash", "blue", locator: Cfi(1));
        await db.ExecAsync("UPDATE books SET removed_at = now() WHERE id = @Id", new { trashed.Id });
        await SaveAsync(await BookWithChapterAsync(), "Someone else's whale", "blue");

        var page = await _repo.ListAllAsync(moby.UserId, null, null, false, 10, 0, Ct);
        var blueWhales = await _repo.ListAllAsync(moby.UserId, "whale", "blue", true, 1, 0, Ct);

        // Newest first; the deleted one and another reader's are not in it. The removed book's stays, marked (#982).
        Assert.Equal(4, page.TotalCount);
        Assert.Equal(("Trashed", true), (page.Items[0].BookTitle, page.Items[0].BookRemoved));
        Assert.Equal(noted.Id, page.Items[2].Id);
        var item = page.Items[3];
        Assert.Equal((quoted.Id, moby.Title, false, "Chapter One", "c1"), (item.Id, item.BookTitle, item.BookRemoved, item.ChapterTitle, item.ChapterKey));
        AssertSameJson("""{"chapterKey":"c1","prefix":"before ","exact":"Quoted","suffix":" after","startOffset":7,"endOffset":13}""", item.AnchorJson);
        // The V2 reader's epub-cfi highlight shows as its quote with its context.
        AssertSameJson("""{"prefix":"","exact":"Call me","suffix":""}""", page.Items[2].AnchorJson);
        // Searched in the text and the note, by colour, oldest first, a page of one: the total counts all three.
        Assert.Equal((3, quoted.Id), (blueWhales.TotalCount, Assert.Single(blueWhales.Items).Id));
        // A page past the end is empty yet still carries the total.
        var pastTheEnd = await _repo.ListAllAsync(moby.UserId, null, null, false, 10, 10, Ct);
        Assert.Equal((4, 0), (pastTheEnd.TotalCount, pastTheEnd.Items.Count));
        // A reader with no highlights gets an empty first page with a total of 0.
        var empty = await _repo.ListAllAsync(await db.NewReaderAsync(), null, null, false, 10, 0, Ct);
        Assert.Equal((0, 0), (empty.TotalCount, empty.Items.Count));
    }

    // ADR-033: a highlight under a key the TOC lacks (the server's old slug or ch-N), or on a book whose TOC has not
    // synced, stays listed, only without its chapter.
    [Fact]
    public async Task ListAllAsync_HighlightUnderAKeyNotInTheToc_ListedWithoutAChapter()
    {
        var synced = await BookWithChapterAsync();
        var oldKey = await SaveAsync(synced, "Old key", locator: AnchorC1.Replace("\"c1\"", "\"ch-7\""));
        var unsynced = await db.NewBookAsync(synced.UserId, "Never opened");
        var noToc = await SaveAsync(unsynced, "No TOC");

        var page = await _repo.ListAllAsync(synced.UserId, null, null, true, 10, 0, Ct);

        Assert.Equal([oldKey.Id, noToc.Id], page.Items.Select(i => i.Id));
        Assert.All(page.Items, i => Assert.Null(i.ChapterTitle ?? i.ChapterKey));
    }

    // #1573: the highlights page shows each book's cover. A book with one lists its version (the cover URL's cache key,
    // changing when the cover does); a book without lists none.
    [Fact]
    public async Task ListAllAsync_BooksWithAndWithoutACover_CarryTheCoversVersionOnlyWhereOneExists()
    {
        var covered = await db.NewReaderWithBookAsync();
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
        await using (var set = new NpgsqlCommand("UPDATE books SET cover_key = 'library/cover.png', updated_at = now() WHERE id = @id", conn))
        {
            set.Parameters.AddWithValue("id", covered.Id);
            await set.ExecuteNonQueryAsync(Ct);
        }
        await SaveAsync(covered, "On a covered book");
        var bare = await db.NewBookAsync(covered.UserId, "No cover");
        await SaveAsync(bare, "On a bare book");

        var page = await _repo.ListAllAsync(covered.UserId, null, null, true, 10, 0, Ct);

        Assert.NotNull(Assert.Single(page.Items, i => i.BookId == covered.Id).BookCoverVersion);
        Assert.Null(Assert.Single(page.Items, i => i.BookId == bare.Id).BookCoverVersion);
    }
}
