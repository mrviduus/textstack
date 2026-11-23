using Application.Library;
using Application.Sync;
using NSubstitute;

namespace TextStack.UnitTests.Sync;

/// <summary>The one ownership check every other feature asks Library for.</summary>
public class BookAccessTests
{
    private static readonly Guid Alice = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();
    private static readonly Guid FileId = Guid.NewGuid();
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private readonly ILibraryRepository _library = SyncFakes.Library(Alice, BookId, FileId);

    [Fact]
    public async Task MissingBookOrFileAsync_OwnerAndAnotherReaderHoldingHerIds_OnlyTheOwnerPasses()
    {
        var access = new BookAccess(_library);

        // Alice's own file proves her book in one round trip.
        Assert.Null(await access.MissingBookOrFileAsync(Alice, BookId, FileId, Ct));
        await _library.DidNotReceiveWithAnyArgs().ExistsAsync(default, default, Ct);
        Assert.Null(await access.MissingBookOrFileAsync(Alice, BookId, null, Ct));
        Assert.Equal(SyncCodes.UnknownFile, SyncFakes.Error((await access.MissingBookOrFileAsync(Alice, BookId, Guid.NewGuid(), Ct))!).Code);

        // Another reader holding Alice's ids finds no book, with or without her file id.
        var bob = Guid.NewGuid();
        Assert.Equal(SyncCodes.BookNotFound, SyncFakes.Error((await access.MissingBookOrFileAsync(bob, BookId, FileId, Ct))!).Code);
        Assert.Equal(SyncCodes.BookNotFound, SyncFakes.Error((await access.MissingBookOrFileAsync(bob, BookId, null, Ct))!).Code);
    }
}
