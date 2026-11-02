using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Library;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>What the V2 service tests share: a user's one book on a mocked library, and reading a failure's body.</summary>
internal static class V2Fakes
{
    /// <summary>A library where <paramref name="user"/> has <paramref name="bookId"/>, whose current file is <paramref name="currentFile"/> and whose versions are <paramref name="versions"/> too.</summary>
    public static Mock<ILibraryRepository> Library(Guid user, Guid bookId, Guid? currentFile, params Guid[] versions)
    {
        var library = new Mock<ILibraryRepository>();
        library.Setup(l => l.ExistsAsync(user, bookId, It.IsAny<CancellationToken>())).ReturnsAsync(true);
        library.Setup(l => l.GetAsync(user, bookId, It.IsAny<CancellationToken>())).ReturnsAsync(new Book
        {
            Id = bookId,
            UserId = user,
            CurrentFile = currentFile is { } id ? new BookFile { Id = id, BookId = bookId, Sha256 = new string('a', 64), Format = "epub", IsCurrent = true } : null,
        });
        foreach (var version in versions.Append(currentFile ?? Guid.Empty).Where(v => v != Guid.Empty))
            library.Setup(l => l.GetFileAsync(user, bookId, version, It.IsAny<CancellationToken>())).ReturnsAsync(new BookFile { Id = version, BookId = bookId });
        return library;
    }

    public static V2Error Error(SyncResult result) => Assert.IsType<V2Error>(result.Body);
}
