using System.Text.Json;
using Application.Common;
using Application.Discussion;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Discussion;
using Domain.Library;
using Microsoft.Extensions.Configuration;
using Moq;

namespace TextStack.UnitTests.V2;

/// <summary>What the V2 service tests share: a user's one book on a mocked library, and reading a failure's body.</summary>
internal static class V2Fakes
{
    /// <summary>A configuration with <c>Features:V2Api</c> = <paramref name="v2Api"/> and, when given, <c>ConnectionStrings:V2</c>.</summary>
    public static IConfiguration Config(bool v2Api, string? v2ConnectionString = null) => new ConfigurationBuilder()
        .AddInMemoryCollection(new Dictionary<string, string?> { ["Features:V2Api"] = v2Api.ToString(), ["ConnectionStrings:V2"] = v2ConnectionString }).Build();

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
        {
            library.Setup(l => l.GetFileAsync(user, bookId, version, It.IsAny<CancellationToken>())).ReturnsAsync(new BookFile { Id = version, BookId = bookId });
            library.Setup(l => l.FileIsVersionAsync(user, bookId, version, It.IsAny<CancellationToken>())).ReturnsAsync(true);
        }
        return library;
    }

    public static V2Error Error(SyncResult result) => Assert.IsType<V2Error>(result.Body);

    /// <summary>Shares that answer every write with <paramref name="outcome"/> and <paramref name="stored"/>, else the share sent.</summary>
    public static Mock<ISharedChapterRepository> Shares(WriteOutcome outcome = WriteOutcome.Created, SharedChapter? stored = null)
    {
        var shares = new Mock<ISharedChapterRepository>();
        shares.Setup(s => s.ShareAsync(It.IsAny<SharedChapter>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((SharedChapter sent, CancellationToken _) => new WriteResult<SharedChapter>(outcome, stored ?? sent));
        shares.Setup(s => s.ListForBookAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<CancellationToken>())).ReturnsAsync([]);
        return shares;
    }

    /// <summary>Checkpoints that answer every append with <paramref name="outcome"/> (no row on a share mismatch) and list nothing.</summary>
    public static Mock<ICheckpointRepository> Checkpoints(WriteOutcome outcome = WriteOutcome.Created, DiscussionCheckpoint? stored = null)
    {
        var checkpoints = new Mock<ICheckpointRepository>();
        checkpoints.Setup(c => c.AppendAsync(It.IsAny<DiscussionCheckpoint>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((DiscussionCheckpoint sent, CancellationToken _) =>
                new WriteResult<DiscussionCheckpoint>(outcome, outcome == WriteOutcome.ShareMismatch ? null : stored ?? sent));
        checkpoints.Setup(c => c.ListAsync(It.IsAny<Guid>(), It.IsAny<Guid>(), It.IsAny<string?>(), It.IsAny<int>(), It.IsAny<CheckpointCursor?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new CheckpointPage([], null));
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
