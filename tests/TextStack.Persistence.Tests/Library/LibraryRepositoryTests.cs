using Dapper;
using Domain.Library;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Library;

public class LibraryRepositoryTests(V2PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private readonly ReadingStateRepository _reading = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Another book in an existing user's library.</summary>
    private async Task<Book> ImportAsync(Guid userId, string? sha256 = null)
    {
        var book = new Book { Id = Guid.NewGuid(), UserId = userId, Title = "Another book" };
        return await _repo.ImportAsync(book, NewFile(userId, book.Id, sha256), Ct);
    }

    [Fact]
    public async Task ImportAsync_NewBook_StoresBookWithItsCurrentFile()
    {
        var user = await db.NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), UserId = user, Title = "A book", Tags = ["fiction"] };
        var file = NewFile(user, book.Id);

        var stored = await _repo.ImportAsync(book, file, Ct);

        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal((book.Id, "A book", (DateTimeOffset?)null), (read.Id, read.Title, read.RemovedAt));
        Assert.Equal(["fiction"], read.Tags);
        Assert.Equal((file.Id, user, book.Id, file.Sha256, true), (read.CurrentFile!.Id, read.CurrentFile.UserId,
            read.CurrentFile.BookId, read.CurrentFile.Sha256, read.CurrentFile.IsCurrent));
        Assert.Equal(stored.CurrentFile!.Id, read.CurrentFile.Id);
    }

    [Fact]
    public async Task ImportAsync_FileClaimingAnotherBook_Throws()
    {
        var user = await db.NewReaderAsync();
        var book = new Book { Id = Guid.NewGuid(), UserId = user, Title = "A book" };

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.ImportAsync(book, NewFile(user, Guid.NewGuid()), Ct));
        Assert.Null(await _repo.GetAsync(user, book.Id, Ct));
    }

    [Fact]
    public async Task ListAsync_OwnBooks_ReturnsNotRemovedNewestFirstWithCurrentFiles()
    {
        var older = await db.NewReaderWithBookAsync();
        var user = older.UserId;
        var removed = await ImportAsync(user);
        var newer = await ImportAsync(user);
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
        await ImportAsync(first.UserId, first.CurrentFile!.Sha256);

        Assert.Equal(first.Id, (await _repo.FindBySha256Async(first.UserId, first.CurrentFile.Sha256, Ct))!.Id);
    }

    [Fact]
    public async Task FindBySha256Async_HashOfAReplacedVersion_ReturnsNull()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), Ct);

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
    public async Task ReplaceFileAsync_BookWithAFile_FlipsIsCurrentAndKeepsTheOldRow()
    {
        var book = await db.NewReaderWithBookAsync();
        var replacement = NewFile(book.UserId, book.Id);

        var result = (await _repo.ReplaceFileAsync(book.UserId, book.Id, replacement, Ct))!;

        Assert.Equal((replacement.Id, true), (result.Current.Id, result.Current.IsCurrent));
        Assert.Equal((book.CurrentFile!.Id, false), (result.Superseded!.Id, result.Superseded.IsCurrent));
        var read = (await _repo.GetAsync(book.UserId, book.Id, Ct))!;
        Assert.Equal(replacement.Id, read.CurrentFile!.Id);
        Assert.True(read.UpdatedAt > book.UpdatedAt);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        Assert.Equal(2L, await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            "SELECT count(*) FROM book_files WHERE user_id = @UserId AND book_id = @Id", book, cancellationToken: Ct)));
    }

    [Fact]
    public async Task ReplaceFileAsync_FileOfAnotherBook_ThrowsAndChangesNothing()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<ArgumentException>(() =>
            _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, Guid.NewGuid()), Ct));
        Assert.Equal(book.CurrentFile!.Id, (await _repo.GetAsync(book.UserId, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task ReplaceFileAsync_FiveAtOnce_AllSucceedAsAChainWithOneCurrentFile()
    {
        var book = await db.NewReaderWithBookAsync();

        var results = await Task.WhenAll(Enumerable.Range(0, 5)
            .Select(_ => _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), Ct)));

        // Each replacement superseded a different version: none saw the same current row.
        Assert.Equal(5, results.Select(r => r!.Superseded!.Id).Distinct().Count());
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        Assert.Equal((6L, 1L), await conn.QuerySingleAsync<(long, long)>(new CommandDefinition(
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

        var result = (await _repo.ReplaceFileAsync(user, bookId, NewFile(user, bookId), Ct))!;

        Assert.Null(result.Superseded);
        Assert.True(result.Current.IsCurrent);
    }

    [Fact]
    public async Task ReplaceFileAsync_BookWithReadingState_ResetsIt()
    {
        var book = await db.NewReaderWithBookAsync();
        await _reading.AdvanceAsync(book.UserId, book.Id, new()
        {
            FileId = book.CurrentFile!.Id,
            CurrentLocator = """{"version":1,"scheme":"pdf-page","value":{"page":3}}""",
            BookFraction = 0.3m,
            ClientRecordedAt = DateTimeOffset.UtcNow,
        }, null, Ct);

        await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), Ct);

        Assert.Null(await _reading.GetAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_RemovedBook_ReturnsNull()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.RemoveAsync(book.UserId, book.Id, Ct);

        Assert.Null(await _repo.ReplaceFileAsync(book.UserId, book.Id, NewFile(book.UserId, book.Id), Ct));
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
    public async Task GetAsync_AlicesBookAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.GetAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task FindBySha256Async_AlicesBytesAsBob_ReturnsNull()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.FindBySha256Async(bob, alices.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task ImportAsync_AlicesBookIdAsBob_FailsAndLeavesAlicesBookIntact()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        // A client-generated id that is already taken is a broken invariant, not a takeover.
        await Assert.ThrowsAsync<Npgsql.PostgresException>(() => _repo.ImportAsync(
            new Book { Id = alices.Id, UserId = bob, Title = "bob's" }, NewFile(bob, alices.Id), Ct));

        var read = (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!;
        Assert.Equal(("A book", alices.CurrentFile!.Id), (read.Title, read.CurrentFile!.Id));
        Assert.Empty(await _repo.ListAsync(bob, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_AlicesBookAsBob_ReturnsNullAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();

        Assert.Null(await _repo.ReplaceFileAsync(bob, alices.Id, NewFile(bob, alices.Id), Ct));
        Assert.Equal(alices.CurrentFile!.Id, (await _repo.GetAsync(alices.UserId, alices.Id, Ct))!.CurrentFile!.Id);
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
