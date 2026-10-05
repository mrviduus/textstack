using Application.Collections;
using Application.Common.Interfaces;
using Application.UserBooks;
using Domain.Entities;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A collection holds only books the reader has (own uploads, saved catalog editions), and a book
/// that goes away leaves the collections — otherwise <see cref="CollectionService.ListAsync"/> counts it.
/// </summary>
public class CollectionMembershipTests
{
    private readonly Guid _userId = Guid.NewGuid();
    private readonly Guid _otherUserId = Guid.NewGuid();
    private readonly List<Collection> _collections = [];
    private readonly List<BookCollection> _bookCollections = [];
    private readonly List<UserBook> _userBooks = [];
    private readonly List<UserLibrary> _libraries = [];
    private readonly IAppDbContext _db;
    private readonly CollectionService _service;

    public CollectionMembershipTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Collections).Returns(() => new FakeDbSet<Collection>(_collections));
        db.Setup(x => x.BookCollections).Returns(() => new FakeDbSet<BookCollection>(_bookCollections));
        db.Setup(x => x.UserBooks).Returns(() => new FakeDbSet<UserBook>(_userBooks));
        db.Setup(x => x.UserLibraries).Returns(() => new FakeDbSet<UserLibrary>(_libraries));
        _db = db.Object;
        _service = new CollectionService(_db);
    }

    private Collection AddCollection(Guid userId)
    {
        var c = new Collection { Id = Guid.NewGuid(), UserId = userId, Name = "Shelf" };
        _collections.Add(c);
        return c;
    }

    private UserBook AddUserBook(Guid userId)
    {
        var b = new UserBook { Id = Guid.NewGuid(), UserId = userId, Title = "T", Slug = "t", Language = "en" };
        _userBooks.Add(b);
        return b;
    }

    [Fact]
    public async Task AddBookAsync_OwnUpload_Added()
    {
        var c = AddCollection(_userId);
        var book = AddUserBook(_userId);

        var (ok, _) = await _service.AddBookAsync(_userId, c.Id, book.Id, "userbook", CancellationToken.None);

        Assert.True(ok);
        Assert.Single(_bookCollections);
    }

    [Fact]
    public async Task AddBookAsync_SomeoneElsesUpload_Rejected()
    {
        var c = AddCollection(_userId);
        var book = AddUserBook(_otherUserId);

        var (ok, error) = await _service.AddBookAsync(_userId, c.Id, book.Id, "userbook", CancellationToken.None);

        Assert.False(ok);
        Assert.Equal("Book not found", error);
        Assert.Empty(_bookCollections);
    }

    [Fact]
    public async Task AddBookAsync_SavedEditionAddedUnsavedRejected_OnlySavedStored()
    {
        var c = AddCollection(_userId);
        var saved = Guid.NewGuid();
        _libraries.Add(new UserLibrary { Id = Guid.NewGuid(), UserId = _userId, EditionId = saved });

        var (savedOk, _) = await _service.AddBookAsync(_userId, c.Id, saved, "savedbook", CancellationToken.None);
        var (unsavedOk, _) = await _service.AddBookAsync(_userId, c.Id, Guid.NewGuid(), "savedbook", CancellationToken.None);

        Assert.True(savedOk);
        Assert.False(unsavedOk);
        Assert.Equal(saved, Assert.Single(_bookCollections).BookId);
    }

    [Fact]
    public async Task RemoveFromAllCollectionsAsync_UserScoped_LeavesOtherUsersRows()
    {
        var edition = Guid.NewGuid();
        var mine = AddCollection(_userId);
        var theirs = AddCollection(_otherUserId);
        _bookCollections.Add(new BookCollection { CollectionId = mine.Id, BookId = edition, BookType = "savedbook" });
        _bookCollections.Add(new BookCollection { CollectionId = theirs.Id, BookId = edition, BookType = "savedbook" });

        await CollectionService.RemoveFromAllCollectionsAsync(_db, _userId, edition, "savedbook", CancellationToken.None);

        Assert.Equal(theirs.Id, Assert.Single(_bookCollections).CollectionId);
    }

    [Fact]
    public async Task RemoveFromAllCollectionsAsync_AllUsers_RemovesOnlyThatBookAndType()
    {
        var bookId = Guid.NewGuid();
        var c = AddCollection(_userId);
        _bookCollections.Add(new BookCollection { CollectionId = c.Id, BookId = bookId, BookType = "userbook" });
        _bookCollections.Add(new BookCollection { CollectionId = c.Id, BookId = bookId, BookType = "savedbook" });
        _bookCollections.Add(new BookCollection { CollectionId = c.Id, BookId = Guid.NewGuid(), BookType = "userbook" });

        await CollectionService.RemoveFromAllCollectionsAsync(_db, null, bookId, "userbook", CancellationToken.None);

        Assert.Equal(2, _bookCollections.Count);
        Assert.DoesNotContain(_bookCollections, bc => bc.BookId == bookId && bc.BookType == "userbook");
    }

    [Fact]
    public async Task AddToCollectionAsync_DuplicateIds_AddedOnceAndReportedOnce()
    {
        var c = AddCollection(_userId);
        var book = AddUserBook(_userId);
        var bulk = new BulkActionService(_db, userBookService: null!);

        var result = await bulk.AddToCollectionAsync(
            _userId, c.Id, [book.Id, book.Id], "userbook", CancellationToken.None);

        Assert.Single(_bookCollections);
        Assert.Equal([book.Id], result.Succeeded);
        Assert.Empty(result.Failed);
    }
}
