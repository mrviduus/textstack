using Application.Library;
using Dapper;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.PostgresFixture;

namespace TextStack.Persistence.Tests.Library;

public class LibraryRepositoryTests(PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static BookMetadata Metadata(string title) => new(title, "An author", "en", "About it", "fiction", 1999, ["classic"]);

    [Fact]
    public async Task ImportAsync_ReaderImportsABookThenSendsTheImportAgain_GetsTheSameBookBack()
    {
        var user = await db.NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), Title = "A book", Tags = ["fiction"] };
        var file = NewFile(user, book.Id);

        var created = await _repo.ImportAsync(user, book, file, Ct);

        Assert.Equal(ImportOutcome.Created, created.Outcome);
        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal((book.Id, "A book", (DateTimeOffset?)null, 1L), (read.Id, read.Title, read.RemovedAt, read.Revision));
        Assert.Equal(["fiction"], read.Tags);
        Assert.Equal((file.Id, user, book.Id, file.Sha256, true), (read.CurrentFile!.Id, read.CurrentFile.UserId,
            read.CurrentFile.BookId, read.CurrentFile.Sha256, read.CurrentFile.IsCurrent));
        Assert.Equal(created.Book!.CurrentFile!.Id, read.CurrentFile.Id);

        // A retry replays the stored book; the retry's own fields do not overwrite it.
        var replay = await _repo.ImportAsync(user, new Book { Id = book.Id, Title = "renamed" }, file, Ct);
        Assert.Equal((ImportOutcome.Replayed, "A book"), (replay.Outcome, replay.Book!.Title));
        Assert.Equal(1L, await db.CountAsync("books", user));

        // The superseded file is still a version of the book: not an id_conflict that would mint a duplicate book.
        var replaced = await db.ReplaceFileAsync(read);
        var late = await _repo.ImportAsync(user, new Book { Id = book.Id, Title = "A book" }, file, Ct);
        Assert.Equal((ImportOutcome.Replayed, replaced.Current!.Id), (late.Outcome, late.Book!.CurrentFile!.Id));
    }

    [Fact]
    public async Task ImportAsync_IdsThatBelongToSomethingElse_AreRefusedAndStoreNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var user = book.UserId;

        // A file that claims another book is a caller bug.
        var orphan = new Book { Id = Guid.NewGuid(), Title = "A book" };
        await Assert.ThrowsAsync<ArgumentException>(() => _repo.ImportAsync(user, orphan, NewFile(user, Guid.NewGuid()), Ct));
        Assert.Null(await _repo.GetAsync(user, orphan.Id, Ct));

        // The reader's own book id with a file that is not one of its versions.
        var sameId = await _repo.ImportAsync(user, new Book { Id = book.Id, Title = "A book" }, NewFile(user, book.Id), Ct);
        Assert.Equal((ImportOutcome.IdConflict, (Book?)null), (sameId.Outcome, sameId.Book));
        Assert.Equal(1L, await db.CountAsync("book_files", user, book.Id));

        // A new book id with the file id of an existing book.
        var newId = Guid.NewGuid();
        var file = NewFile(user, newId);
        file.Id = book.CurrentFile!.Id;
        Assert.Equal(ImportOutcome.IdConflict, (await _repo.ImportAsync(user, new Book { Id = newId, Title = "A book" }, file, Ct)).Outcome);
        Assert.Null(await _repo.GetAsync(user, newId, Ct));
    }

    [Fact]
    public async Task ImportAsync_BytesAlreadyInTheLibrary_AreADuplicateUntilThatBookIsRemoved()
    {
        var first = await db.NewReaderWithBookAsync();
        var (user, sha256) = (first.UserId, first.CurrentFile!.Sha256);
        var again = Guid.NewGuid();

        var duplicate = await _repo.ImportAsync(user, new Book { Id = again, Title = "Again" }, NewFile(user, again, sha256), Ct);

        Assert.Equal((ImportOutcome.DuplicateFile, first.Id), (duplicate.Outcome, duplicate.Book!.Id));
        Assert.Null(await _repo.GetAsync(user, again, Ct));

        await _repo.RemoveAsync(user, first.Id, Ct);
        Assert.Null(await _repo.FindBySha256Async(user, sha256, Ct));
        Assert.Equal(ImportOutcome.Created, (await _repo.ImportAsync(user, new Book { Id = again, Title = "Again" }, NewFile(user, again, sha256), Ct)).Outcome);
    }

    [Fact]
    public async Task ImportAsync_SameBytesImportedConcurrently_WaitsForTheOtherImportThenIsADuplicate()
    {
        var user = await db.NewReaderAsync();
        var sha256 = PayloadSha256(Guid.NewGuid().ToString());
        // The other device's import, caught between its lock and its commit.
        await using var other = await db.DataSource.OpenConnectionAsync(Ct);
        await using var otherTx = await other.BeginTransactionAsync(Ct);
        var otherBook = Guid.NewGuid();
        await other.ExecuteAsync(new CommandDefinition("""
            SELECT pg_advisory_xact_lock(hashtext(@user::text || @sha256));
            INSERT INTO books (id, user_id, title) VALUES (@otherBook, @user, 'First');
            INSERT INTO book_files (id, user_id, book_id, sha256, byte_size, original_name, format) VALUES (gen_random_uuid(), @user, @otherBook, @sha256, 1, 'a.epub', 'epub');
            """, new { user, sha256, otherBook }, otherTx, cancellationToken: Ct));

        var bookId = Guid.NewGuid();
        var pending = _repo.ImportAsync(user, new Book { Id = bookId, Title = "Second" }, NewFile(user, bookId, sha256), Ct);
        await db.WaitUntilBlockedByAsync(other, pending);
        // Without the lock the import neither waits nor sees the uncommitted book, and stores a second copy.
        Assert.False(pending.IsCompleted);
        await otherTx.CommitAsync(Ct);

        var result = await pending;
        Assert.Equal((ImportOutcome.DuplicateFile, otherBook), (result.Outcome, result.Book!.Id));
    }

    [Fact]
    public async Task UpdateMetadataAsync_ReaderEditsTheBookFromTwoDevices_FirstEditWinsTheStaleOneGetsTheStoredBook()
    {
        var book = await db.NewReaderWithBookAsync();

        var first = await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("Renamed"), 1, Ct);

        Assert.True(first.Accepted);
        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal(("Renamed", "An author", "en", "About it", "fiction", 1999, 2L),
            (read.Title, read.Author, read.Language, read.Description, read.Genre, read.PublishedYear, read.Revision));
        Assert.Equal(["classic"], read.Tags);
        Assert.True(read.UpdatedAt > book.UpdatedAt);
        Assert.Equal(book.CurrentFile!.Id, first.Current!.CurrentFile!.Id);

        var stale = await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("Second edit"), 1, Ct);
        Assert.False(stale.Accepted);
        Assert.Equal(("Renamed", 2L), (stale.Current!.Title, stale.Current.Revision));

        // Saving checkpoints is a setting, not an edit: writing the stored value touches nothing.
        var setting = (await _repo.SetCheckpointSavingAsync(book.UserId, book.Id, false, Ct))!;
        Assert.Equal((false, read.UpdatedAt), (setting.CheckpointSavingEnabled, setting.UpdatedAt));
    }

    [Fact]
    public async Task RemoveAsync_ReaderRemovesABookThenRestoresIt_TheRemovedBookIsKeptButRefusesEdits()
    {
        var book = await db.NewReaderWithBookAsync();
        var user = book.UserId;

        Assert.True(await _repo.RemoveAsync(user, book.Id, Ct));
        Assert.False(await _repo.RemoveAsync(user, book.Id, Ct));
        Assert.Empty(await _repo.ListAsync(user, Ct));
        var removed = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.NotNull(removed.RemovedAt);
        Assert.True(await _repo.ExistsAsync(user, book.Id, Ct));
        Assert.False(await _repo.ExistsAsync(user, Guid.NewGuid(), Ct));

        var edit = await _repo.UpdateMetadataAsync(user, book.Id, Metadata("Renamed"), 1, Ct);
        Assert.False(edit.Accepted);
        Assert.Equal(("A book", 1L), (edit.Current!.Title, edit.Current.Revision));
        Assert.NotNull(edit.Current.RemovedAt);

        var replace = await _repo.ReplaceFileAsync(user, book.Id, NewFile(user, book.Id), book.CurrentFile!.Id, null, Ct);
        Assert.Equal((FileReplaceOutcome.BookRemoved, book.Id), (replace.Outcome, replace.Book!.Id));
        Assert.Equal(book.CurrentFile.Id, (await _repo.GetAsync(user, book.Id, Ct))!.CurrentFile!.Id);

        // The setting still flips on a removed book: UpdatedAt moves, the revision does not.
        var written = (await _repo.SetCheckpointSavingAsync(user, book.Id, true, Ct))!;
        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal((true, 1L, book.CurrentFile.Id), (read.CheckpointSavingEnabled, read.Revision, written.CurrentFile!.Id));
        Assert.Equal((true, read.UpdatedAt), (written.CheckpointSavingEnabled, written.UpdatedAt));
        Assert.True(read.UpdatedAt > removed.UpdatedAt);

        Assert.True(await _repo.RestoreAsync(user, book.Id, Ct));
        Assert.Equal(book.Id, Assert.Single(await _repo.ListAsync(user, Ct)).Id);
        Assert.False(await _repo.RestoreAsync(user, book.Id, Ct));
    }

    [Fact]
    public async Task ListAsync_LibraryAndChangeFeed_ListHidesRemovedBooksFeedPagesThemInUpdateOrder()
    {
        var older = await db.NewReaderWithBookAsync();
        var user = older.UserId;
        var removed = await db.NewBookAsync(user);
        var newer = await db.NewBookAsync(user);
        // Distinct times, so the order never rests on two inserts landing in the same microsecond.
        await db.ExecAsync("UPDATE books SET updated_at = now() - interval '2 minutes' WHERE id = @id", new { id = older.Id });
        await db.ExecAsync("UPDATE books SET updated_at = now() - interval '1 minute' WHERE id = @id", new { id = newer.Id });
        await _repo.RemoveAsync(user, removed.Id, Ct); // now the latest change

        var books = await _repo.ListAsync(user, Ct);
        Assert.Equal([newer.Id, older.Id], books.Select(b => b.Id));
        Assert.All(books, b => Assert.NotNull(b.CurrentFile));

        var all = await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct);
        var page = await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 2, Ct);
        var after = await _repo.ListChangedAsync(user, page[^1].UpdatedAt, page[^1].Id, 10, Ct);

        Assert.Equal([older.Id, newer.Id, removed.Id], all.Select(b => b.Id));
        Assert.NotNull(all[^1].RemovedAt);
        Assert.All(all, b => Assert.NotNull(b.CurrentFile));
        Assert.Equal([older.Id, newer.Id], page.Select(b => b.Id));
        Assert.Equal(removed.Id, Assert.Single(after).Id);
    }

    [Fact]
    public async Task ListChangedAsync_ReaderSyncsTheToc_FeedCarriesItsEntryCount()
    {
        var book = await db.NewReaderWithBookAsync();
        var (user, file) = (book.UserId, book.CurrentFile!.Id);

        var fresh = Assert.Single(await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct)).CurrentFile!;
        Assert.Null(fresh.ChapterCount);

        Assert.True(await _repo.SetTocAsync(user, book.Id, file,
            """[{"key":"a","title":"A","depth":0,"fraction":0},{"key":"b","title":"B","depth":1,"fraction":0.5}]""", Ct));
        var read = Assert.Single(await _repo.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct)).CurrentFile!;
        Assert.Equal(2, read.ChapterCount);

        // Only the feed reads the count.
        Assert.Null((await _repo.GetAsync(user, book.Id, Ct))!.CurrentFile!.ChapterCount);
    }

    [Fact]
    public async Task ReplaceFileAsync_ReaderReplacesTheFile_OldVersionStaysReadableAsSupersededAndTheReplayIsIdempotent()
    {
        var book = await db.NewReaderWithBookAsync();
        var (user, old) = (book.UserId, book.CurrentFile!);
        var other = await db.NewBookAsync(user, "Another book");
        var replacement = NewFile(user, book.Id);

        var result = await _repo.ReplaceFileAsync(user, book.Id, replacement, old.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.Replaced, replacement.Id, true), (result.Outcome, result.Current!.Id, result.Current.IsCurrent));
        Assert.Equal((old.Id, false), (result.Superseded!.Id, result.Superseded.IsCurrent));
        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal(replacement.Id, read.CurrentFile!.Id);
        Assert.True(read.UpdatedAt > book.UpdatedAt);

        var replay = await _repo.ReplaceFileAsync(user, book.Id, replacement, old.Id, null, Ct);
        Assert.Equal((FileReplaceOutcome.Replayed, replacement.Id), (replay.Outcome, replay.Current!.Id));
        Assert.Equal(2L, await db.CountAsync("book_files", user, book.Id));

        // The superseded version: readable under its book, never under another book or another reader.
        var superseded = await _repo.GetFileAsync(user, book.Id, old.Id, Ct);
        Assert.Equal((old.Id, false), (superseded!.Id, superseded.IsCurrent));
        Assert.Equal(old.Format, await _repo.FileFormatAsync(user, book.Id, old.Id, Ct));
        Assert.Null(await _repo.GetFileAsync(user, book.Id, other.CurrentFile!.Id, Ct));
        Assert.Null(await _repo.FileFormatAsync(user, book.Id, other.CurrentFile.Id, Ct));
        Assert.Null(await _repo.FileFormatAsync(await db.NewReaderAsync(), book.Id, old.Id, Ct));

        // Duplicate lookup sees current files only, and the oldest book when two share bytes.
        Assert.Null(await _repo.FindBySha256Async(user, old.Sha256, Ct));
        await _repo.ReplaceFileAsync(user, other.Id, NewFile(user, other.Id, replacement.Sha256), other.CurrentFile.Id, null, Ct);
        Assert.Equal(book.Id, (await _repo.FindBySha256Async(user, replacement.Sha256, Ct))!.Id);

        await _repo.RemoveAsync(user, book.Id, Ct);
        var replayAfterRemoval = await _repo.ReplaceFileAsync(user, book.Id, replacement, old.Id, null, Ct);
        Assert.Equal((FileReplaceOutcome.Replayed, replacement.Id), (replayAfterRemoval.Outcome, replayAfterRemoval.Current!.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_FromAStaleOrWrongView_IsRefusedWithTheCurrentFileAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var (user, first) = (book.UserId, book.CurrentFile!);
        var other = await db.NewBookAsync(user);

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _repo.ReplaceFileAsync(user, book.Id, NewFile(user, Guid.NewGuid()), first.Id, null, Ct));
        Assert.Equal(first.Id, (await _repo.GetAsync(user, book.Id, Ct))!.CurrentFile!.Id);

        var blind = await _repo.ReplaceFileAsync(user, book.Id, NewFile(user, book.Id), null, null, Ct);
        Assert.Equal((FileReplaceOutcome.FileReplaced, first.Id), (blind.Outcome, blind.Current!.Id));

        var borrowed = NewFile(user, book.Id);
        borrowed.Id = other.CurrentFile!.Id;
        Assert.Equal(FileReplaceOutcome.IdConflict, (await _repo.ReplaceFileAsync(user, book.Id, borrowed, first.Id, null, Ct)).Outcome);

        var winner = await db.ReplaceFileAsync(book); // another device, offline, replaced it first

        var stale = await _repo.ReplaceFileAsync(user, book.Id, NewFile(user, book.Id), first.Id, null, Ct);
        Assert.Equal((FileReplaceOutcome.FileReplaced, winner.Current!.Id), (stale.Outcome, stale.Current!.Id));

        var backToOld = await _repo.ReplaceFileAsync(user, book.Id, first, winner.Current.Id, null, Ct);
        Assert.Equal((FileReplaceOutcome.FileReplaced, winner.Current.Id), (backToOld.Outcome, backToOld.Current!.Id));
        Assert.Equal(2L, await db.CountAsync("book_files", user, book.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_FiveAtOnceFromTheSameView_OneWinsTheOthersAreFileReplaced()
    {
        var book = await db.NewReaderWithBookAsync();

        var results = await Task.WhenAll(Enumerable.Range(0, 5)
            .Select(_ => _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), book.CurrentFile!.Id, null, Ct)));

        var winner = Assert.Single(results, r => r.Outcome == FileReplaceOutcome.Replaced);
        Assert.All(results.Where(r => r != winner), r => Assert.Equal((FileReplaceOutcome.FileReplaced, winner.Current!.Id), (r.Outcome, r.Current!.Id)));
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        Assert.Equal((2L, 1L), await conn.QuerySingleAsync<(long, long)>(new CommandDefinition(
            "SELECT count(*), count(*) FILTER (WHERE is_current) FROM book_files WHERE user_id = @UserId AND book_id = @Id",
            book, cancellationToken: Ct)));
    }

    [Fact]
    public async Task ReplaceFileAsync_BookWithNoFileYet_ReadsAsNullFileThenGetsOneWithNothingSuperseded()
    {
        var user = await db.NewReaderAsync();
        var bookId = Guid.NewGuid();
        // A catalog book (D5) has no file, and no repository method makes one yet (ETL, M3): SQL does.
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition(
                """INSERT INTO books (id, user_id, title, origin) VALUES (@bookId, @user, 'A catalog book', '{"kind":"catalog"}')""",
                new { bookId, user }, cancellationToken: Ct));
        Assert.Null((await _repo.GetAsync(user, bookId, Ct))!.CurrentFile);
        Assert.Null(Assert.Single(await _repo.ListAsync(user, Ct)).CurrentFile);

        var result = await _repo.ReplaceFileAsync(user, bookId, NewFile(user, bookId), null, null, Ct);

        Assert.Equal((FileReplaceOutcome.Replaced, (BookFile?)null, true), (result.Outcome, result.Superseded, result.Current!.IsCurrent));
    }

    [Fact]
    public async Task ReplaceFileAsync_InACallersTransactionRolledBack_ChangesNothing()
    {
        var book = await db.NewReaderWithBookAsync();

        await using (var tx = await db.DataSource.BeginAsync(Ct))
            Assert.Equal(FileReplaceOutcome.Replaced, (await _repo.ReplaceFileAsync(
                book.UserId, book.Id, NewFile(book.UserId, book.Id), book.CurrentFile!.Id, tx.Transaction, Ct)).Outcome);

        Assert.Equal(book.CurrentFile!.Id, (await _repo.GetAsync(book.UserId, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task EveryMethod_AnotherReaderHoldingAlicesIds_ReadsAndChangesNoneOfHerBooks()
    {
        var alices = await db.NewReaderWithBookAsync();
        var (alice, file) = (alices.UserId, alices.CurrentFile!);
        var bob = await db.NewReaderAsync();

        // Reads.
        Assert.Empty(await _repo.ListAsync(bob, Ct));
        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));
        Assert.Null(await _repo.GetAsync(bob, alices.Id, Ct));
        Assert.False(await _repo.ExistsAsync(bob, alices.Id, Ct));
        Assert.Null(await _repo.GetFileAsync(bob, alices.Id, file.Id, Ct));
        Assert.Null(await _repo.FindBySha256Async(bob, file.Sha256, Ct));

        // Her book id and her file id: only the owner check stands between bob and a "replay" of her book.
        var hers = NewFile(bob, alices.Id);
        hers.Id = file.Id;
        var stolen = await _repo.ImportAsync(bob, new Book { Id = alices.Id, Title = "bob's" }, hers, Ct);
        Assert.Equal((ImportOutcome.IdConflict, (Book?)null), (stolen.Outcome, stolen.Book));
        Assert.Empty(await _repo.ListAsync(bob, Ct));

        // Her bytes, while her book is live, are not his duplicate.
        var bobsBook = Guid.NewGuid();
        Assert.Equal(ImportOutcome.Created, (await _repo.ImportAsync(bob, new Book { Id = bobsBook, Title = "bob's" }, NewFile(bob, bobsBook, file.Sha256), Ct)).Outcome);

        var edit = await _repo.UpdateMetadataAsync(bob, alices.Id, Metadata("bob's"), 1, Ct);
        Assert.Equal((false, (Book?)null), (edit.Accepted, edit.Current));

        Assert.Equal(FileReplaceOutcome.NotFound, (await _repo.ReplaceFileAsync(bob, alices.Id, NewFile(bob, alices.Id), file.Id, null, Ct)).Outcome);
        Assert.Null(await _repo.SetCheckpointSavingAsync(bob, alices.Id, true, Ct));
        Assert.False(await _repo.RemoveAsync(bob, alices.Id, Ct));

        var read = (await _repo.GetAsync(alice, alices.Id, Ct))!;
        Assert.Equal(("A book", 1L, file.Id, false, alices.UpdatedAt),
            (read.Title, read.Revision, read.CurrentFile!.Id, read.CheckpointSavingEnabled, read.UpdatedAt));
        Assert.Equal(alices.Id, Assert.Single(await _repo.ListAsync(alice, Ct)).Id);

        await _repo.RemoveAsync(alice, alices.Id, Ct);
        Assert.False(await _repo.RestoreAsync(bob, alices.Id, Ct));
        Assert.Empty(await _repo.ListAsync(alice, Ct));
    }
}
