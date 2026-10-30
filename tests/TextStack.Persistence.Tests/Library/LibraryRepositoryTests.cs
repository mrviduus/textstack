using System.Security.Cryptography;
using Dapper;
using Domain.Library;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests.Library;

public class LibraryRepositoryTests(V2PostgresFixture db)
{
    private readonly LibraryRepository _repo = new(db.DataSource);
    private readonly ReadingStateRepository _reading = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Book NewBook(Guid userId, string title = "A book") =>
        new() { Id = Guid.NewGuid(), UserId = userId, Title = title, Tags = ["fiction"] };

    private static BookFile NewFile(string? sha256 = null) => new()
    {
        Id = Guid.NewGuid(),
        Sha256 = sha256 ?? Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)),
        ByteSize = 1024,
        OriginalName = "book.epub",
        Format = "epub",
    };

    private async Task<Book> ImportAsync(Guid userId, string? sha256 = null) =>
        await _repo.ImportAsync(NewBook(userId), NewFile(sha256), Ct);

    [Fact]
    public async Task ImportAsync_NewBook_StoresBookWithItsCurrentFile()
    {
        var user = await db.NewReaderAsync();
        var book = NewBook(user);
        var file = NewFile();

        var stored = await _repo.ImportAsync(book, file, Ct);

        var read = (await _repo.GetAsync(user, book.Id, Ct))!;
        Assert.Equal((book.Id, "A book", (DateTimeOffset?)null), (read.Id, read.Title, read.RemovedAt));
        Assert.Equal(["fiction"], read.Tags);
        Assert.Equal((file.Id, user, book.Id, file.Sha256, true), (read.CurrentFile!.Id, read.CurrentFile.UserId,
            read.CurrentFile.BookId, read.CurrentFile.Sha256, read.CurrentFile.IsCurrent));
        Assert.Equal(stored.CurrentFile!.Id, read.CurrentFile.Id);
    }

    [Fact]
    public async Task ListAsync_OwnBooks_ReturnsNotRemovedNewestFirstWithCurrentFiles()
    {
        var user = await db.NewReaderAsync();
        var older = await ImportAsync(user);
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
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _repo.RemoveAsync(user, book.Id, Ct);

        Assert.NotNull((await _repo.GetAsync(user, book.Id, Ct))!.RemovedAt);
    }

    [Fact]
    public async Task FindBySha256Async_SameBytesInOwnLibrary_ReturnsTheOldestBook()
    {
        var user = await db.NewReaderAsync();
        var first = await ImportAsync(user);
        await ImportAsync(user, first.CurrentFile!.Sha256);

        Assert.Equal(first.Id, (await _repo.FindBySha256Async(user, first.CurrentFile.Sha256, Ct))!.Id);
    }

    [Fact]
    public async Task FindBySha256Async_HashOfAReplacedVersion_ReturnsNull()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _repo.ReplaceFileAsync(user, book.Id, NewFile(), Ct);

        Assert.Null(await _repo.FindBySha256Async(user, book.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task FindBySha256Async_RemovedBook_ReturnsNull()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _repo.RemoveAsync(user, book.Id, Ct);

        Assert.Null(await _repo.FindBySha256Async(user, book.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_BookWithAFile_FlipsIsCurrentAndKeepsTheOldRow()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        var replacement = NewFile();

        var result = (await _repo.ReplaceFileAsync(user, book.Id, replacement, Ct))!;

        Assert.Equal((replacement.Id, true), (result.Current.Id, result.Current.IsCurrent));
        Assert.Equal((book.CurrentFile!.Id, false), (result.Superseded!.Id, result.Superseded.IsCurrent));
        Assert.Equal(replacement.Id, (await _repo.GetAsync(user, book.Id, Ct))!.CurrentFile!.Id);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        Assert.Equal(2L, await conn.ExecuteScalarAsync<long>(new CommandDefinition(
            "SELECT count(*) FROM book_files WHERE user_id = @user AND book_id = @Id", new { user, book.Id }, cancellationToken: Ct)));
    }

    [Fact]
    public async Task ReplaceFileAsync_BookWithReadingState_ResetsIt()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _reading.AdvanceAsync(user, book.Id, new()
        {
            FileId = book.CurrentFile!.Id,
            CurrentLocator = """{"version":1,"scheme":"pdf-page","value":{"page":3}}""",
            BookFraction = 0.3m,
            ClientRecordedAt = DateTimeOffset.UtcNow,
        }, null, Ct);

        await _repo.ReplaceFileAsync(user, book.Id, NewFile(), Ct);

        Assert.Null(await _reading.GetAsync(user, book.Id, Ct));
    }

    [Fact]
    public async Task ReplaceFileAsync_RemovedBook_ReturnsNull()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _repo.RemoveAsync(user, book.Id, Ct);

        Assert.Null(await _repo.ReplaceFileAsync(user, book.Id, NewFile(), Ct));
        Assert.Equal(book.CurrentFile!.Id, (await _repo.GetAsync(user, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task RemoveAsync_OwnBook_HidesItFromTheList()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);

        Assert.True(await _repo.RemoveAsync(user, book.Id, Ct));
        Assert.Empty(await _repo.ListAsync(user, Ct));
        Assert.False(await _repo.RemoveAsync(user, book.Id, Ct));
    }

    [Fact]
    public async Task RestoreAsync_RemovedBook_ListsItAgain()
    {
        var user = await db.NewReaderAsync();
        var book = await ImportAsync(user);
        await _repo.RemoveAsync(user, book.Id, Ct);

        Assert.True(await _repo.RestoreAsync(user, book.Id, Ct));
        Assert.Equal(book.Id, Assert.Single(await _repo.ListAsync(user, Ct)).Id);
        Assert.False(await _repo.RestoreAsync(user, book.Id, Ct));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ListAsync_OtherUser_SeesNoneOfAlicesBooks()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        await ImportAsync(alice);

        Assert.Empty(await _repo.ListAsync(bob, Ct));
    }

    [Fact]
    public async Task GetAsync_AlicesBookAsBob_ReturnsNull()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);

        Assert.Null(await _repo.GetAsync(bob, book.Id, Ct));
    }

    [Fact]
    public async Task FindBySha256Async_AlicesBytesAsBob_ReturnsNull()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);

        Assert.Null(await _repo.FindBySha256Async(bob, book.CurrentFile!.Sha256, Ct));
    }

    [Fact]
    public async Task ImportAsync_AlicesBookIdAsBob_FailsAndLeavesAlicesBookIntact()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);

        // A client-generated id that is already taken is a broken invariant, not a takeover.
        await Assert.ThrowsAsync<Npgsql.PostgresException>(() =>
            _repo.ImportAsync(new Book { Id = book.Id, UserId = bob, Title = "bob's" }, NewFile(), Ct));

        var aliceBook = (await _repo.GetAsync(alice, book.Id, Ct))!;
        Assert.Equal(("A book", book.CurrentFile!.Id), (aliceBook.Title, aliceBook.CurrentFile!.Id));
        Assert.Empty(await _repo.ListAsync(bob, Ct));
    }

    [Fact]
    public async Task ImportAsync_FileClaimingAlicesBook_IsStoredUnderBobsBook()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var aliceBook = await ImportAsync(alice);
        var file = NewFile();
        file.UserId = alice;
        file.BookId = aliceBook.Id;

        var bobs = await _repo.ImportAsync(NewBook(bob), file, Ct);

        Assert.Equal((bob, bobs.Id), (bobs.CurrentFile!.UserId, bobs.CurrentFile.BookId));
        Assert.Equal(aliceBook.CurrentFile!.Id, (await _repo.GetAsync(alice, aliceBook.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task ReplaceFileAsync_AlicesBookAsBob_ReturnsNullAndChangesNothing()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);

        Assert.Null(await _repo.ReplaceFileAsync(bob, book.Id, NewFile(), Ct));
        Assert.Equal(book.CurrentFile!.Id, (await _repo.GetAsync(alice, book.Id, Ct))!.CurrentFile!.Id);
    }

    [Fact]
    public async Task RemoveAsync_AlicesBookAsBob_ReturnsFalseAndKeepsItListed()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);

        Assert.False(await _repo.RemoveAsync(bob, book.Id, Ct));
        Assert.Equal(book.Id, Assert.Single(await _repo.ListAsync(alice, Ct)).Id);
    }

    [Fact]
    public async Task RestoreAsync_AlicesRemovedBookAsBob_ReturnsFalseAndKeepsItRemoved()
    {
        var (alice, bob) = (await db.NewReaderAsync(), await db.NewReaderAsync());
        var book = await ImportAsync(alice);
        await _repo.RemoveAsync(alice, book.Id, Ct);

        Assert.False(await _repo.RestoreAsync(bob, book.Id, Ct));
        Assert.Empty(await _repo.ListAsync(alice, Ct));
    }
}
