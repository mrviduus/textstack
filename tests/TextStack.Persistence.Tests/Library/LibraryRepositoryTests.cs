using Application.Library;
using Dapper;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Library;

public class LibraryRepositoryTests(V2PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static BookMetadata Metadata(string title) => new(title, "An author", "en", "About it", "fiction", 1999, ["classic"]);

    [Fact]
    public async Task ImportAsync_NewBook_StoresBookWithItsCurrentFile()
    {
        var user = await db.NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), Title = "A book", Tags = ["fiction"] };
        var file = NewFile(user, book.Id);

        var result = await _repo.ImportAsync(user, book, file, Ct);

        Assert.Equal(ImportOutcome.Created, result.Outcome);
        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal((book.Id, "A book", (DateTimeOffset?)null, 1L), (read.Id, read.Title, read.RemovedAt, read.Revision));
        Assert.Equal(["fiction"], read.Tags);
        Assert.Equal((file.Id, user, book.Id, file.Sha256, true), (read.CurrentFile!.Id, read.CurrentFile.UserId,
            read.CurrentFile.BookId, read.CurrentFile.Sha256, read.CurrentFile.IsCurrent));
        Assert.Equal(result.Book!.CurrentFile!.Id, read.CurrentFile.Id);
    }

    [Fact]
    public async Task ImportAsync_FileClaimingAnotherBook_Throws()
    {
        var user = await db.NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), Title = "A book" };

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.ImportAsync(user, book, NewFile(user, Guid.NewGuid()), Ct));
        Assert.Null(await _repo.GetAsync(user, book.Id, Ct));
    }

    [Fact]
    public async Task ImportAsync_SameImportAgain_ReplaysTheStoredBook()
    {
        var book = await db.NewReaderWithBookAsync();

        var replay = await _repo.ImportAsync(book.UserId, new Book { Id = book.Id, Title = "renamed" }, book.CurrentFile!, Ct);

        Assert.Equal((ImportOutcome.Replayed, "A book"), (replay.Outcome, replay.Book!.Title));
        Assert.Equal(1L, await db.CountAsync("books", book.UserId));
    }

    [Fact]
    public async Task ImportAsync_ReplayAfterAReplacement_ReplaysTheStoredBook()
    {
        var book = await db.NewReaderWithBookAsync();
        var replaced = await db.ReplaceFileAsync(book);

        var replay = await _repo.ImportAsync(book.UserId, new Book { Id = book.Id, Title = "A book" }, book.CurrentFile!, Ct);

        // The superseded file is still a version of the book: not an id_conflict that would mint a duplicate book.
        Assert.Equal((ImportOutcome.Replayed, replaced.Current!.Id), (replay.Outcome, replay.Book!.CurrentFile!.Id));
    }

    [Fact]
    public async Task ImportAsync_OwnBookIdWithAFileThatIsNotItsVersion_IsIdConflict()
    {
        var book = await db.NewReaderWithBookAsync();

        var result = await _repo.ImportAsync(book.UserId, new Book { Id = book.Id, Title = "A book" }, NewFile(book.UserId, book.Id), Ct);

        Assert.Equal((ImportOutcome.IdConflict, (Book?)null), (result.Outcome, result.Book));
        Assert.Equal(1L, await db.CountAsync("book_files", book.UserId, book.Id));
    }

    [Fact]
    public async Task ImportAsync_FileIdOfAnotherBook_IsIdConflictAndStoresNothing()
    {
        var other = await db.NewReaderWithBookAsync();
        var bookId = Guid.NewGuid();
        var file = NewFile(other.UserId, bookId);
        file.Id = other.CurrentFile!.Id;

        var result = await _repo.ImportAsync(other.UserId, new Book { Id = bookId, Title = "A book" }, file, Ct);

        Assert.Equal(ImportOutcome.IdConflict, result.Outcome);
        Assert.Null(await _repo.GetAsync(other.UserId, bookId, Ct));
    }

    [Fact]
    public async Task ImportAsync_BytesOfALiveBook_IsDuplicateFileWithThatBook()
    {
        var first = await db.NewReaderWithBookAsync();
        var bookId = Guid.NewGuid();

        var result = await _repo.ImportAsync(first.UserId, new Book { Id = bookId, Title = "Again" }, NewFile(first.UserId, bookId, first.CurrentFile!.Sha256), Ct);

        Assert.Equal((ImportOutcome.DuplicateFile, first.Id), (result.Outcome, result.Book!.Id));
        Assert.Null(await _repo.GetAsync(first.UserId, bookId, Ct));
    }

    [Fact]
    public async Task ImportAsync_BytesOfARemovedBook_ImportsANewBook()
    {
        var removed = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(removed.UserId, removed.Id, Ct);
        var bookId = Guid.NewGuid();

        var result = await _repo.ImportAsync(removed.UserId, new Book { Id = bookId, Title = "Again" }, NewFile(removed.UserId, bookId, removed.CurrentFile!.Sha256), Ct);

        Assert.Equal(ImportOutcome.Created, result.Outcome);
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
    public async Task UpdateMetadataAsync_MatchingRevision_WritesEveryFieldAndBumpsRevisionAndUpdatedAt()
    {
        var book = await db.NewReaderWithBookAsync();

        var result = await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("Renamed"), 1, Ct);

        Assert.True(result.Accepted);
        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal(("Renamed", "An author", "en", "About it", "fiction", 1999, 2L),
            (read.Title, read.Author, read.Language, read.Description, read.Genre, read.PublishedYear, read.Revision));
        Assert.Equal(["classic"], read.Tags);
        Assert.True(read.UpdatedAt > book.UpdatedAt);
        Assert.Equal(book.CurrentFile!.Id, result.Current!.CurrentFile!.Id);
    }

    [Fact]
    public async Task UpdateMetadataAsync_StaleRevision_LosesAndReturnsTheStoredBook()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("First edit"), 1, Ct);

        var stale = await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("Second edit"), 1, Ct);

        Assert.False(stale.Accepted);
        Assert.Equal(("First edit", 2L), (stale.Current!.Title, stale.Current.Revision));
    }

    [Fact]
    public async Task SetCheckpointSavingAsync_OwnRemovedBook_FlipsItAndBumpsUpdatedAtNotRevision()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);
        var removed = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;

        Assert.True(await _repo.SetCheckpointSavingAsync(book.UserId, book.Id, true, Ct));

        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((true, 1L), (read.CheckpointSavingEnabled, read.Revision));
        Assert.True(read.UpdatedAt > removed.UpdatedAt);
    }

    [Fact]
    public async Task SetCheckpointSavingAsync_AnotherUsersBook_IsFalseAndChangesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = await db.NewReaderAsync();

        Assert.False(await _repo.SetCheckpointSavingAsync(other, book.Id, true, Ct));

        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal((false, book.UpdatedAt), (read.CheckpointSavingEnabled, read.UpdatedAt));
    }

    [Fact]
    public async Task ExistsAsync_RemovedBookAndAnUnknownId_AreTrueAndFalse()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        Assert.True(await _repo.ExistsAsync(book.UserId, book.Id, Ct));
        Assert.False(await _repo.ExistsAsync(book.UserId, Guid.NewGuid(), Ct));
    }

    [Fact]
    public async Task GetFileAsync_SupersededVersion_ReturnsIt()
    {
        var book = await db.NewReaderWithBookAsync();
        await db.ReplaceFileAsync(book);

        var old = await _repo.GetFileAsync(book.UserId, book.Id, book.CurrentFile!.Id, Ct);

        Assert.Equal((book.CurrentFile.Id, false), (old!.Id, old.IsCurrent));
    }

    [Fact]
    public async Task GetFileAsync_FileOfAnotherBook_ReturnsNull()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = await db.NewBookAsync(book.UserId);

        Assert.Null(await _repo.GetFileAsync(book.UserId, book.Id, other.CurrentFile!.Id, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_RemovedAndLiveBooks_ReturnsBothInUpdateOrderWithCurrentFiles()
    {
        var first = await db.NewReaderWithBookAsync();
        var second = await db.NewBookAsync(first.UserId);
        await _repo.RemoveAsync(first.UserId, first.Id, Ct); // now the later of the two

        var all = await _repo.ListChangedAsync(first.UserId, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct);
        var page = await _repo.ListChangedAsync(first.UserId, DateTimeOffset.UnixEpoch, Guid.Empty, 1, Ct);
        var after = await _repo.ListChangedAsync(first.UserId, all[0].UpdatedAt, all[0].Id, 10, Ct);

        Assert.Equal([second.Id, first.Id], all.Select(b => b.Id));
        Assert.NotNull(all[1].RemovedAt);
        Assert.All(all, b => Assert.NotNull(b.CurrentFile));
        Assert.Equal(second.Id, Assert.Single(page).Id);
        Assert.Equal(first.Id, Assert.Single(after).Id);
    }

    [Fact]
    public async Task ListAsync_OwnBooks_ReturnsNotRemovedNewestFirstWithCurrentFiles()
    {
        var older = await db.NewReaderWithBookAsync();
        var user = older.UserId;
        var removed = await db.NewBookAsync(user);
        var newer = await db.NewBookAsync(user);
        await _repo.RemoveAsync(user, removed.Id, Ct);

        var books = await _repo.ListAsync(user, Ct);

        Assert.Equal([newer.Id, older.Id], books.Select(b => b.Id));
        Assert.All(books, b => Assert.NotNull(b.CurrentFile));
    }

    [Fact]
    public async Task GetAsync_RemovedBook_ReturnsItWithRemovedAt()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        Assert.NotNull((await _repo.GetAsync(book.UserId, book.Id, Ct))!.RemovedAt);
    }

    [Fact]
    public async Task FindBySha256Async_SameBytesInOwnLibrary_ReturnsTheOldestBook()
    {
        var first = await db.NewReaderWithBookAsync();
        // Two books with the same bytes: only a replacement makes them (an import would be a duplicate).
        var second = await db.NewBookAsync(first.UserId);
        var sameBytes = NewFile(first.UserId, second.Id, first.CurrentFile!.Sha256);
        await _repo.ReplaceFileAsync(first.UserId, second.Id, sameBytes, second.CurrentFile!.Id, null, Ct);

        Assert.Equal(first.Id, (await _repo.FindBySha256Async(first.UserId, first.CurrentFile.Sha256, Ct))!.Id);
    }

    [Fact]
    public async Task FindBySha256Async_HashOfAReplacedVersion_ReturnsNull()
    {
        var book = await db.NewReaderWithBookAsync();
        await db.ReplaceFileAsync(book);

        Assert.Null(await _repo.FindBySha256Async(book.UserId, book.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task FindBySha256Async_RemovedBook_ReturnsNull()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        Assert.Null(await _repo.FindBySha256Async(book.UserId, book.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_CurrentFileNamed_FlipsIsCurrentKeepsTheOldRowAndBumpsTheBook()
    {
        var book = await db.NewReaderWithBookAsync();
        var replacement = NewFile(book.UserId, book.Id);

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, replacement, book.CurrentFile!.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.Replaced, replacement.Id, true), (result.Outcome, result.Current!.Id, result.Current.IsCurrent));
        Assert.Equal((book.CurrentFile.Id, false), (result.Superseded!.Id, result.Superseded.IsCurrent));
        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal(replacement.Id, read.CurrentFile!.Id);
        Assert.True(read.UpdatedAt > book.UpdatedAt);
        Assert.Equal(2L, await db.CountAsync("book_files", book.UserId, book.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_FileOfAnotherBook_ThrowsAndChangesNothing()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, Guid.NewGuid()), book.CurrentFile!.Id, null, Ct));
        Assert.Equal(book.CurrentFile!.Id, (await _repo.GetAsync(book.UserId, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task ReplaceFileAsync_StaleReplacesFileId_IsFileReplacedWithTheCurrentFile()
    {
        var book = await db.NewReaderWithBookAsync();
        var winner = await db.ReplaceFileAsync(book); // another device, offline, replaced it first

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), book.CurrentFile!.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.FileReplaced, winner.Current!.Id), (result.Outcome, result.Current!.Id));
        Assert.Equal(2L, await db.CountAsync("book_files", book.UserId, book.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_NoReplacesFileIdOnABookWithAFile_IsFileReplaced()
    {
        var book = await db.NewReaderWithBookAsync();

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), null, null, Ct);

        Assert.Equal((FileReplaceOutcome.FileReplaced, book.CurrentFile!.Id), (result.Outcome, result.Current!.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_SameReplacementAgain_ReplaysIt()
    {
        var book = await db.NewReaderWithBookAsync();
        var file = NewFile(book.UserId, book.Id);
        await _repo.ReplaceFileAsync(book.UserId, book.Id, file, book.CurrentFile!.Id, null, Ct);

        var replay = await _repo.ReplaceFileAsync(book.UserId, book.Id, file, book.CurrentFile.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.Replayed, file.Id), (replay.Outcome, replay.Current!.Id));
        Assert.Equal(2L, await db.CountAsync("book_files", book.UserId, book.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_ASupersededVersionAgain_IsFileReplaced()
    {
        var book = await db.NewReaderWithBookAsync();
        var newer = await db.ReplaceFileAsync(book);

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, book.CurrentFile!, newer.Current!.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.FileReplaced, newer.Current.Id), (result.Outcome, result.Current!.Id));
    }

    [Fact]
    public async Task ReplaceFileAsync_FileIdOfAnotherBook_IsIdConflict()
    {
        var book = await db.NewReaderWithBookAsync();
        var other = await db.NewBookAsync(book.UserId);
        var file = NewFile(book.UserId, book.Id);
        file.Id = other.CurrentFile!.Id;

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, file, book.CurrentFile!.Id, null, Ct);

        Assert.Equal(FileReplaceOutcome.IdConflict, result.Outcome);
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
    public async Task ReplaceFileAsync_RemovedBook_IsBookRemovedAndChangesNothing()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        var result = await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), book.CurrentFile!.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.BookRemoved, book.Id), (result.Outcome, result.Book!.Id));
        Assert.Equal(book.CurrentFile.Id, (await _repo.GetAsync(book.UserId, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task ReplaceFileAsync_ReplayOnABookRemovedSince_IsReplayed()
    {
        var book = await db.NewReaderWithBookAsync();
        var file = NewFile(book.UserId, book.Id);
        await _repo.ReplaceFileAsync(book.UserId, book.Id, file, book.CurrentFile!.Id, null, Ct);
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        var replay = await _repo.ReplaceFileAsync(book.UserId, book.Id, file, book.CurrentFile.Id, null, Ct);

        Assert.Equal((FileReplaceOutcome.Replayed, file.Id), (replay.Outcome, replay.Current!.Id));
    }

    [Fact]
    public async Task UpdateMetadataAsync_RemovedBook_LosesWithTheRemovedBook()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        var result = await _repo.UpdateMetadataAsync(book.UserId, book.Id, Metadata("Renamed"), 1, Ct);

        Assert.False(result.Accepted);
        Assert.Equal(("A book", 1L), (result.Current!.Title, result.Current.Revision));
        Assert.NotNull(result.Current.RemovedAt);
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
    public async Task RemoveAsync_OwnBook_HidesItFromTheList()
    {
        var book = await db.NewReaderWithBookAsync();

        Assert.True(await _repo.RemoveAsync(book.UserId, book.Id, Ct));
        Assert.Empty(await _repo.ListAsync(book.UserId, Ct));
        Assert.False(await _repo.RemoveAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task RestoreAsync_RemovedBook_ListsItAgain()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        Assert.True(await _repo.RestoreAsync(book.UserId, book.Id, Ct));
        Assert.Equal(book.Id, Assert.Single(await _repo.ListAsync(book.UserId, Ct)).Id);
        Assert.False(await _repo.RestoreAsync(book.UserId, book.Id, Ct));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ListAsync_OtherUser_SeesNoneOfAlicesBooks()
    {
        await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _repo.ListAsync(bob, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_OtherUser_SeesNoneOfAlicesBooks()
    {
        await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _repo.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));
    }

    [Fact]
    public async Task GetAsync_AlicesBookAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.GetAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task ExistsAsync_AlicesBookAsBob_IsFalse()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.False(await _repo.ExistsAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task GetFileAsync_AlicesFileAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.GetFileAsync(bob, alices.Id, alices.CurrentFile!.Id, Ct));
    }

    [Fact]
    public async Task FindBySha256Async_AlicesBytesAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.FindBySha256Async(bob, alices.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task ImportAsync_AlicesBookIdAsBob_IsIdConflictAndLeavesAlicesBookIntact()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        // Her file id too, so only the owner check stands between bob and a "replay" of her book.
        var file = NewFile(bob, alices.Id);
        file.Id = alices.CurrentFile!.Id;
        var result = await _repo.ImportAsync(bob, new Book { Id = alices.Id, Title = "bob's" }, file, Ct);

        Assert.Equal((ImportOutcome.IdConflict, (Book?)null), (result.Outcome, result.Book));
        var read = (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal(("A book", alices.CurrentFile.Id), (read.Title, read.CurrentFile!.Id));
        Assert.Empty(await _repo.ListAsync(bob, Ct));
    }

    [Fact]
    public async Task ImportAsync_AlicesBytesAsBob_IsNotADuplicate()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var bookId = Guid.NewGuid();

        var result = await _repo.ImportAsync(bob, new Book { Id = bookId, Title = "bob's" }, NewFile(bob, bookId, alices.CurrentFile!.Sha256), Ct);

        Assert.Equal(ImportOutcome.Created, result.Outcome);
    }

    [Fact]
    public async Task UpdateMetadataAsync_AlicesBookAsBob_LosesWithNoCurrentAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var result = await _repo.UpdateMetadataAsync(bob, alices.Id, Metadata("bob's"), 1, Ct);

        Assert.Equal((false, (Book?)null), (result.Accepted, result.Current));
        var read = (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal(("A book", 1L), (read.Title, read.Revision));
    }

    [Fact]
    public async Task ReplaceFileAsync_AlicesBookAsBob_IsNotFoundAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        var result = await _repo.ReplaceFileAsync(bob, alices.Id, NewFile(bob, alices.Id), alices.CurrentFile!.Id, null, Ct);

        Assert.Equal(FileReplaceOutcome.NotFound, result.Outcome);
        Assert.Equal(alices.CurrentFile.Id, (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task RemoveAsync_AlicesBookAsBob_ReturnsFalseAndKeepsItListed()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.False(await _repo.RemoveAsync(bob, alices.Id, Ct));
        Assert.Equal(alices.Id, Assert.Single(await _repo.ListAsync(alices.UserId, Ct)).Id);
    }

    [Fact]
    public async Task RestoreAsync_AlicesRemovedBookAsBob_ReturnsFalseAndKeepsItRemoved()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.RemoveAsync(alices.UserId, alices.Id, Ct);

        Assert.False(await _repo.RestoreAsync(bob, alices.Id, Ct));
        Assert.Empty(await _repo.ListAsync(alices.UserId, Ct));
    }
}
