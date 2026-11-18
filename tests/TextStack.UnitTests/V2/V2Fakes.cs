using System.Text.Json;
using Application.Common;
using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Discussion;
using Domain.Library;
using Microsoft.Extensions.Configuration;
using NSubstitute;

namespace TextStack.UnitTests.V2;

/// <summary>What the V2 service tests share: a user's one book on a mocked library, and reading a failure's body.</summary>
internal static class V2Fakes
{
    /// <summary>A library where <paramref name="user"/> has <paramref name="bookId"/>, whose current file is <paramref name="currentFile"/> and whose versions are <paramref name="versions"/> too.</summary>
    public static ILibraryRepository Library(Guid user, Guid bookId, Guid? currentFile, params Guid[] versions) =>
        Library(user, bookId,
            currentFile is { } id ? new BookFile { Id = id, BookId = bookId, Sha256 = new string('a', 64), Format = "epub", IsCurrent = true } : null,
            [.. versions.Select(v => new BookFile { Id = v, BookId = bookId, Format = "epub" })]);

    /// <summary>The same library on the test's own file rows, read live: a test that changes a row is read changed.</summary>
    public static ILibraryRepository Library(Guid user, Guid bookId, BookFile? current, params BookFile[] versions)
    {
        var library = Substitute.For<ILibraryRepository>();
        // NSubstitute answers "" for strings: a file is no version of a book, and nothing is removed, unless set up here.
        library.FileFormatAsync(default, default, default, default).ReturnsForAnyArgs((string?)null);
        library.RemoveContentAsync(default, default, default, default).ReturnsForAnyArgs((string?)null);
        library.ExistsAsync(user, bookId, Arg.Any<CancellationToken>()).Returns(true);
        library.GetAsync(user, bookId, Arg.Any<CancellationToken>()).Returns(_ => new Book { Id = bookId, UserId = user, CurrentFile = current });
        foreach (var file in versions.Prepend(current).OfType<BookFile>())
        {
            library.GetFileAsync(user, bookId, file.Id, Arg.Any<CancellationToken>()).Returns(_ => file);
            library.FileFormatAsync(user, bookId, file.Id, Arg.Any<CancellationToken>()).Returns(_ => file.Format);
        }
        return library;
    }

    public static V2Error Error(SyncResult result) => Assert.IsType<V2Error>(result.Body);

    /// <summary>Shares that answer every write with <paramref name="outcome"/> and <paramref name="stored"/>, else the share sent.</summary>
    public static ISharedChapterRepository Shares(WriteOutcome outcome = WriteOutcome.Created, SharedChapter? stored = null)
    {
        var shares = Substitute.For<ISharedChapterRepository>();
        shares.ShareAsync(Arg.Any<SharedChapter>(), Arg.Any<CancellationToken>())
            .Returns(call => new WriteResult<SharedChapter>(outcome, stored ?? call.Arg<SharedChapter>()));
        shares.ListForBookAsync(Arg.Any<Guid>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>()).Returns([]);
        return shares;
    }

    /// <summary>Checkpoints that answer every append with <paramref name="outcome"/> (no row on a share mismatch) and list nothing.</summary>
    public static ICheckpointRepository Checkpoints(WriteOutcome outcome = WriteOutcome.Created, DiscussionCheckpoint? stored = null)
    {
        var checkpoints = Substitute.For<ICheckpointRepository>();
        checkpoints.AppendAsync(Arg.Any<DiscussionCheckpoint>(), Arg.Any<CancellationToken>())
            .Returns(call => new WriteResult<DiscussionCheckpoint>(outcome, outcome == WriteOutcome.ShareMismatch ? null : stored ?? call.Arg<DiscussionCheckpoint>()));
        checkpoints.ListAsync(default, default, default, default, default, default).ReturnsForAnyArgs(new CheckpointPage([], null));
        return checkpoints;
    }

    /// <summary>A valid share of chapter <c>ch02.xhtml</c>; vary it with <c>with</c>.</summary>
    public static ShareChapterRequest NewShare(Guid? fileId = null) =>
        new(Guid.NewGuid(), fileId, "ch02.xhtml", "Chapter II", "It was the night.", JsonOf("""[{ "text": "night" }]"""), "en");

    /// <summary>A valid checkpoint on chapter <c>ch02.xhtml</c>, a thought and a question; vary it with <c>with</c>.</summary>
    public static CheckpointRequest NewCheckpoint(Guid? sharedChapterId = null) =>
        new(Guid.NewGuid(), "The letter", ["It reads like a confession."], [], [], ["Who wrote it?"], "en", "ch02.xhtml", null, sharedChapterId);

    public static JsonElement JsonOf(string json) => JsonDocument.Parse(json).RootElement;
}
