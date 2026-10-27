using Application.Common.Interfaces;
using Application.UserBooks;
using Domain.Entities;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// A deleted upload's highlights and sessions find their way back when the same user uploads the
/// same file again (#983) — and only then, and only highlights whose chapter the new book has.
/// </summary>
public class DeletedUploadTrailTests
{
    private const string Sha = "abc123";
    private readonly Guid _userId = Guid.NewGuid();
    private readonly List<Highlight> _highlights = [];
    private readonly List<ReadingSession> _sessions = [];
    private readonly List<UserChapter> _chapters = [];
    private readonly IAppDbContext _db;
    private readonly UserBook _book;

    public DeletedUploadTrailTests()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.Highlights).Returns(() => new FakeDbSet<Highlight>(_highlights));
        db.Setup(x => x.ReadingSessions).Returns(() => new FakeDbSet<ReadingSession>(_sessions));
        db.Setup(x => x.UserChapters).Returns(() => new FakeDbSet<UserChapter>(_chapters));
        _db = db.Object;
        _book = new UserBook { Id = Guid.NewGuid(), UserId = _userId, Title = "Dune", Slug = "dune", Language = "en" };
        _chapters.Add(new UserChapter { Id = Guid.NewGuid(), UserBookId = _book.Id, Slug = "1-intro", Title = "Intro", Html = "", PlainText = "" });
    }

    private Highlight Ownerless(string? slug, Guid? userId = null, string sha = Sha)
    {
        var h = new Highlight
        {
            Id = Guid.NewGuid(), UserId = userId ?? _userId, AnchorJson = "{}", Color = "yellow",
            SelectedText = "x", DeletedBookSha256 = sha, DeletedChapterSlug = slug,
        };
        _highlights.Add(h);
        return h;
    }

    [Fact]
    public async Task ReattachAsync_SameFile_AttachesHighlightToChapterBySlug()
    {
        var h = Ownerless("1-intro");

        var (highlights, _) = await DeletedUploadTrail.ReattachAsync(_db, _book, Sha, default);

        Assert.Equal(1, highlights);
        Assert.Equal(_book.Id, h.UserBookId);
        Assert.Equal(_chapters[0].Id, h.UserChapterId);
        Assert.Null(h.DeletedBookSha256);
    }

    [Fact]
    public async Task ReattachAsync_ChapterlessPdfHighlight_AttachesWithoutChapter()
    {
        var h = Ownerless(slug: null);

        await DeletedUploadTrail.ReattachAsync(_db, _book, Sha, default);

        Assert.Equal(_book.Id, h.UserBookId);
        Assert.Null(h.UserChapterId);
    }

    [Fact]
    public async Task ReattachAsync_ChapterMissingInNewBook_StaysOwnerless()
    {
        var h = Ownerless("9-gone");

        await DeletedUploadTrail.ReattachAsync(_db, _book, Sha, default);

        Assert.Null(h.UserBookId);
        Assert.Equal(Sha, h.DeletedBookSha256);
    }

    [Fact]
    public async Task ReattachAsync_OtherUserOrOtherFile_Untouched()
    {
        var other = Ownerless("1-intro", userId: Guid.NewGuid());
        var otherFile = Ownerless("1-intro", sha: "different");

        await DeletedUploadTrail.ReattachAsync(_db, _book, Sha, default);

        Assert.Null(other.UserBookId);
        Assert.Null(otherFile.UserBookId);
    }

    [Fact]
    public async Task ReattachAsync_SameFile_AttachesSession()
    {
        var s = new ReadingSession { Id = Guid.NewGuid(), UserId = _userId, DeletedBookSha256 = Sha };
        _sessions.Add(s);

        var (_, sessions) = await DeletedUploadTrail.ReattachAsync(_db, _book, Sha, default);

        Assert.Equal(1, sessions);
        Assert.Equal(_book.Id, s.UserBookId);
        Assert.Null(s.DeletedBookSha256);
    }

    [Fact]
    public async Task Keep_WritesTitleShaAndChapterSlug()
    {
        _book.BookFiles = [new UserBookFile { Id = Guid.NewGuid(), Sha256 = Sha, OriginalFileName = "d.epub", StoragePath = "p" }];
        var h = new Highlight
        {
            Id = Guid.NewGuid(), UserId = _userId, UserBookId = _book.Id, UserChapter = _chapters[0],
            AnchorJson = "{}", Color = "yellow", SelectedText = "x",
        };
        _highlights.Add(h);
        var s = new ReadingSession { Id = Guid.NewGuid(), UserId = _userId, UserBookId = _book.Id };
        _sessions.Add(s);

        await DeletedUploadTrail.Keep(_db, _book, default);

        Assert.Equal(("Dune", Sha, "1-intro"), (h.BookTitle, h.DeletedBookSha256, h.DeletedChapterSlug));
        Assert.Equal(Sha, s.DeletedBookSha256);
    }
}
