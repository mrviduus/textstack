using Application.Common.Interfaces;
using Application.ReadingTracking;
using Application.UserBooks;
using Contracts.UserBooks;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Moq;

namespace TextStack.UnitTests;

// ADR-012 S2: user-book reading progress may be PAGE-based (PDF "Original layout",
// chapterless) or chapter-based (reflow/EPUB). These cover the upsert→GET round-trip
// for both, plus the >=0.99 auto-complete invariant. Sets are List<T>-backed Moq
// (production AppDbContext can't load on EF InMemory — see UserBookClipServiceTests).
public class UserBookProgressServiceTests
{
    private sealed class Harness
    {
        public List<User> Users { get; } = [];
        public List<UserBook> UserBooks { get; } = [];
        public UserBookService Service { get; }

        public Harness()
        {
            var db = new Mock<IAppDbContext>();
            db.Setup(x => x.Users).Returns(() => FakeSet(Users).Object);
            db.Setup(x => x.UserBooks).Returns(() => FakeSet(UserBooks).Object);
            db.Setup(x => x.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(0);

            Service = new UserBookService(db.Object, new Mock<IFileStorageService>().Object, TestEntitlements.Resolver);
        }

        public UserBook SeedBook(Guid userId)
        {
            var b = new UserBook
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                Title = "T",
                Slug = "t",
                Language = "en",
                Status = UserBookStatus.Ready,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            UserBooks.Add(b);
            return b;
        }
    }

    private static Mock<DbSet<T>> FakeSet<T>(List<T> data) where T : class
    {
        var q = new TestAsyncEnumerable<T>(data);
        var set = new Mock<DbSet<T>>();
        var iq = set.As<IQueryable<T>>();
        iq.Setup(m => m.Provider).Returns(((IQueryable<T>)q).Provider);
        iq.Setup(m => m.Expression).Returns(((IQueryable<T>)q).Expression);
        iq.Setup(m => m.ElementType).Returns(((IQueryable<T>)q).ElementType);
        iq.Setup(m => m.GetEnumerator()).Returns(() => data.GetEnumerator());
        set.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(() => new TestAsyncEnumerator<T>(data.GetEnumerator()));
        return set;
    }

    [Fact]
    public async Task UpsertProgressAsync_PageBasedNullChapter_PersistsAndRoundTrips()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:17", Percent: 0.16, UpdatedAt: null, PercentUnit: ProgressUnit.Book);

        var (success, error) = await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.True(success);
        Assert.Null(error);
        Assert.Null(book.ProgressChapterSlug);
        Assert.Equal("page:17", book.ProgressLocator);
        Assert.Equal(0.16, book.ProgressPercent);
        Assert.NotNull(book.ProgressUpdatedAt);
        Assert.Null(book.CompletedAt);

        // Round-trips via GET even with a null chapter (page-based progress must not 404).
        var got = await h.Service.GetProgressAsync(userId, book.Id, CancellationToken.None);
        Assert.NotNull(got);
        Assert.Null(got!.ChapterSlug);
        Assert.Equal("page:17", got.Locator);
        Assert.Equal(0.16, got.Percent);
    }

    [Fact]
    public async Task UpsertProgressAsync_ChapterBased_StillPersistsAndRoundTrips()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: "chapter-3", Locator: "word:42", Percent: 0.5, UpdatedAt: null, PercentUnit: ProgressUnit.Book);

        var (success, _) = await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.True(success);
        Assert.Equal("chapter-3", book.ProgressChapterSlug);

        var got = await h.Service.GetProgressAsync(userId, book.Id, CancellationToken.None);
        Assert.NotNull(got);
        Assert.Equal("chapter-3", got!.ChapterSlug);
        Assert.Equal("word:42", got.Locator);
        Assert.Equal(0.5, got.Percent);
    }

    [Fact]
    public async Task UpsertProgressAsync_PercentAtLeast099_SetsCompletedAt()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:200", Percent: 0.99, UpdatedAt: null, PercentUnit: ProgressUnit.Book);

        await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.NotNull(book.CompletedAt);
        Assert.True(book.IsRead);
        Assert.NotNull(book.ReadAt);
    }

    [Fact]
    public async Task UpsertProgressAsync_NullPercent_KeepsStoredPercentAndStillMovesPosition()
    {
        // A null Percent means "I know where the reader is, but not how far through
        // the book" — the client could not compute a book-wide value because the
        // chapter list had not resolved. That happens on every save made offline.
        // Nulling the column there would erase real progress, and letting the client
        // substitute the chapter fraction would store a value that reaches 1.0 at the
        // bottom of every chapter.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-3", Locator: "scroll:ch-3:1200", Percent: 0.42, UpdatedAt: null, PercentUnit: ProgressUnit.Book),
            CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-4", Locator: "scroll:ch-4:300", Percent: null, UpdatedAt: null, PercentUnit: ProgressUnit.Book),
            CancellationToken.None);

        Assert.Equal(0.42, book.ProgressPercent);
        Assert.Equal("ch-4", book.ProgressChapterSlug);
        Assert.Equal("scroll:ch-4:300", book.ProgressLocator);
    }

    [Fact]
    public async Task UpsertProgressAsync_NullPercent_DoesNotCompleteTheBook()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-1", Locator: "scroll:ch-1:10", Percent: null, UpdatedAt: null, PercentUnit: ProgressUnit.Book),
            CancellationToken.None);

        Assert.Null(book.CompletedAt);
        Assert.False(book.IsRead);
    }

    [Fact]
    public async Task GetProgressAsync_NoProgressRecorded_ReturnsNull()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        // Neither chapter nor locator set → nothing to resume.
        var got = await h.Service.GetProgressAsync(userId, book.Id, CancellationToken.None);

        Assert.Null(got);
    }

    [Fact]
    public async Task UpsertProgressAsync_UndeclaredUnit_KeepsStoredPercentButMovesPosition()
    {
        // Same rule as catalog books: an old build's percentage is of unknown
        // scale, so the position it reports is honoured and the number is not.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-1", Locator: "scroll:ch-1:10", Percent: 0.30, UpdatedAt: null, PercentUnit: ProgressUnit.Book),
            CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-9", Locator: "scroll:ch-9:640", Percent: 0.98, UpdatedAt: null),
            CancellationToken.None);

        Assert.Equal(0.30, book.ProgressPercent);
        Assert.Equal("ch-9", book.ProgressChapterSlug);
        Assert.Equal("scroll:ch-9:640", book.ProgressLocator);
        Assert.Null(book.CompletedAt);
    }

    [Fact]
    public async Task UpsertProgressAsync_ScrollWriteWithoutKind_DoesNotReplaceAPageLocator()
    {
        // The 2026-08-27 retest, in one test. A reader opened an uploaded PDF,
        // read to page 16, and the reflow path's close-flush — which fires on
        // every reader close regardless of what is on screen — arrived carrying
        // "top of the chapter named in the URL".
        //
        // Before the guard this stored scroll:2-the-mom-test:0 at 4% and the book
        // reopened ten pages early. The client no longer sends it, but every
        // installed build still does.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:16", Percent: 0.139, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Page), CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "2-the-mom-test", Locator: "scroll:2-the-mom-test:0", Percent: 0.038,
            UpdatedAt: null, PercentUnit: ProgressUnit.Book), CancellationToken.None);

        Assert.Equal("page:16", book.ProgressLocator);
        Assert.Equal(0.139, book.ProgressPercent);
        Assert.Null(book.ProgressChapterSlug);
    }

    [Fact]
    public async Task UpsertProgressAsync_DeclaredScrollWrite_ReplacesAPageLocator()
    {
        // The read-as-text fallback for a PDF that will not render. That reader is
        // legitimately in scroll space, which is why the rule is not a ranking.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:16", Percent: 0.139, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Page), CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-2", Locator: "scroll:ch-2:900", Percent: 0.42, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Scroll), CancellationToken.None);

        Assert.Equal("scroll:ch-2:900", book.ProgressLocator);
        Assert.Equal(0.42, book.ProgressPercent);
    }

    [Fact]
    public async Task UpsertProgressAsync_SameSpaceWithoutKind_IsStillStored()
    {
        // The compatibility case. Every installed build writes scroll-over-scroll
        // for an EPUB and declares nothing; an over-tight guard would freeze all
        // of their reading positions.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-1", Locator: "scroll:ch-1:10", Percent: 0.1, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book), CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-4", Locator: "scroll:ch-4:2400", Percent: 0.6, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book), CancellationToken.None);

        Assert.Equal("scroll:ch-4:2400", book.ProgressLocator);
        Assert.Equal(0.6, book.ProgressPercent);
    }

    [Fact]
    public async Task UpsertProgressAsync_NullLocator_LeavesTheStoredPositionAlone()
    {
        // The fourth corruption vector, found while tracing the third: the web
        // client's locator field is optional and JSON.stringify drops undefined,
        // so "I have no position to report" arrived as "erase the position".
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:16", Percent: 0.139, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Page), CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: null, Percent: 0.5, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book), CancellationToken.None);

        Assert.Equal("page:16", book.ProgressLocator);
        Assert.Equal(0.139, book.ProgressPercent);
    }

    [Fact]
    public async Task UpsertProgressAsync_LaterWriteWithAnEarlierClientClock_IsStored()
    {
        // The column used to hold whichever clock the client happened to send, and
        // the stale-write gate compared a client timestamp against it. A PDF write
        // arriving after a reflow write, from a device a second behind the server,
        // was silently dropped. One clock per column, and the gate is gone with it.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-1", Locator: "scroll:ch-1:10", Percent: 0.1,
            UpdatedAt: DateTimeOffset.UtcNow.AddMinutes(5),
            PercentUnit: ProgressUnit.Book), CancellationToken.None);

        await h.Service.UpsertProgressAsync(userId, book.Id, new UpsertUserBookProgressRequest(
            ChapterSlug: "ch-2", Locator: "scroll:ch-2:20", Percent: 0.2,
            UpdatedAt: DateTimeOffset.UtcNow.AddMinutes(-5),
            PercentUnit: ProgressUnit.Book), CancellationToken.None);

        Assert.Equal("scroll:ch-2:20", book.ProgressLocator);
        Assert.Equal(0.2, book.ProgressPercent);
    }

    // --- PositionJson: the logical position, and the invariant that a row never
    // holds two positions that disagree. -----------------------------------------

    private const string Anchor =
        """{"v":1,"chapterSlug":"2-act-i","anchor":{"prefix":"and then ","exact":"the door opened","suffix":" onto a"},"charOffset":4120,"chapterFraction":0.31}""";

    [Fact]
    public async Task UpsertProgressAsync_ScrollWriteWithPosition_StoresAndRoundTrips()
    {
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: "2-act-i", Locator: "scroll:2-act-i:4200", Percent: 0.31, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Scroll, PositionJson: Anchor);

        var (success, _) = await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.True(success);
        Assert.Equal(Anchor, book.ProgressPositionJson);

        var got = await h.Service.GetProgressAsync(userId, book.Id, CancellationToken.None);
        Assert.Equal(Anchor, got!.PositionJson);
    }

    [Fact]
    public async Task UpsertProgressAsync_WriteWithoutPosition_ClearsTheStoredOne()
    {
        // The old-build case, and the reason this is an assignment rather than a merge.
        // A device that predates the column writes the locator and nothing else, so its
        // pixel offset is the only true statement on the row. Keeping the anchor would
        // leave the row contradicting itself for as long as that device kept reading.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);
        book.ProgressLocator = "scroll:2-act-i:4200";
        book.ProgressPositionJson = Anchor;

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: "2-act-i", Locator: "scroll:2-act-i:5000", Percent: 0.34, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book);

        await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.Equal("scroll:2-act-i:5000", book.ProgressLocator);
        Assert.Null(book.ProgressPositionJson);
    }

    [Fact]
    public async Task UpsertProgressAsync_PageWrite_ClearsThePosition()
    {
        // A PDF read in Original layout has no text anchor to give, and its page IS
        // its logical position. An anchor left beside page:17 would name a chapter the
        // reader is not in.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);
        book.ProgressLocator = "page:9";
        book.ProgressPositionJson = Anchor;

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: null, Locator: "page:17", Percent: 0.16, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, LocatorKind: LocatorSpace.Page, PositionJson: Anchor);

        await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.Equal("page:17", book.ProgressLocator);
        Assert.Null(book.ProgressPositionJson);
    }

    [Fact]
    public async Task UpsertProgressAsync_RefusedWrite_LeavesThePositionAlone()
    {
        // A refusal drops the whole write (ADR-013 rule 5). The position is part of
        // the write, so it must not be the one field that leaks through.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);
        book.ProgressLocator = "page:16";
        book.ProgressPositionJson = null;

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: "1-intro", Locator: "scroll:1-intro:0", Percent: 0.04, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book, PositionJson: Anchor);   // undeclared cross-space

        var (success, _) = await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.True(success);                       // refusals are silent
        Assert.Equal("page:16", book.ProgressLocator);
        Assert.Null(book.ProgressPositionJson);
    }

    [Fact]
    public async Task UpsertProgressAsync_OversizedPosition_DropsOnlyThePosition()
    {
        // Unlike a foreign coordinate space, an oversized payload says nothing about
        // whether the rest of the snapshot is trustworthy — so the locator and the
        // percentage still land.
        var h = new Harness();
        var userId = Guid.NewGuid();
        var book = h.SeedBook(userId);

        var req = new UpsertUserBookProgressRequest(
            ChapterSlug: "2-act-i", Locator: "scroll:2-act-i:4200", Percent: 0.31, UpdatedAt: null,
            PercentUnit: ProgressUnit.Book,
            PositionJson: new string('x', ReaderPosition.MaxLength + 1));

        await h.Service.UpsertProgressAsync(userId, book.Id, req, CancellationToken.None);

        Assert.Equal("scroll:2-act-i:4200", book.ProgressLocator);
        Assert.Equal(0.31, book.ProgressPercent);
        Assert.Null(book.ProgressPositionJson);
    }
}
