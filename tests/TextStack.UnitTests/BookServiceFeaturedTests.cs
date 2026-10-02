using Application.Books;
using Application.Common.Interfaces;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Moq;

namespace TextStack.UnitTests;

// Popular shelf: GetBooksAsync ordering (featured by rank, then newest) and
// ReplaceFeaturedAsync (whole-shelf replace behind PUT /internal/featured).
public class BookServiceFeaturedTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private readonly List<Edition> _editions = [];
    private readonly Mock<IAppDbContext> _db = new();
    private readonly BookService _service;

    public BookServiceFeaturedTests()
    {
        _db.Setup(x => x.Editions).Returns(() => FakeSet(_editions).Object);
        _service = new BookService(_db.Object);
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

    private Edition Add(string slug, int daysAfterT0, int? rank = null,
        EditionStatus status = EditionStatus.Published)
    {
        var e = new Edition
        {
            Id = Guid.NewGuid(),
            Language = "en",
            Slug = slug,
            Title = slug,
            Status = status,
            CreatedAt = T0,
            PublishedAt = T0.AddDays(daysAfterT0),
            FeaturedRank = rank,
        };
        e.Chapters.Add(new Chapter { Title = "c", Html = "<p>x</p>", PlainText = "x" });
        _editions.Add(e);
        return e;
    }

    private async Task<List<string>> Slugs(string? sort) =>
        (await _service.GetBooksAsync(Guid.Empty, 0, 50, "en", null, null, sort, CancellationToken.None))
        .Items.Select(b => b.Slug).ToList();

    private void SeedMixed()
    {
        Add("old", 1);
        Add("newest", 10);
        Add("featured-2", 2, rank: 2);
        Add("featured-1", 3, rank: 1);
        Add("mid", 5);
    }

    [Fact]
    public async Task GetBooksAsync_Popular_FeaturedByRankThenNewest()
    {
        SeedMixed();
        Assert.Equal(["featured-1", "featured-2", "newest", "mid", "old"], await Slugs("popular"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("bogus")]
    public async Task GetBooksAsync_EmptyOrUnknownSort_DefaultsToPopular(string? sort)
    {
        SeedMixed();
        Assert.Equal(["featured-1", "featured-2", "newest", "mid", "old"], await Slugs(sort));
    }

    [Fact]
    public async Task GetBooksAsync_Recent_NewestFirstIgnoringRank()
    {
        SeedMixed();
        Assert.Equal(["newest", "mid", "featured-1", "featured-2", "old"], await Slugs("recent"));
    }

    [Fact]
    public async Task GetBooksAsync_Popular_ExposesFeaturedRank()
    {
        SeedMixed();
        var items = (await _service.GetBooksAsync(Guid.Empty, 0, 50, "en", null, null, "popular", CancellationToken.None)).Items;
        Assert.Equal(1, items[0].FeaturedRank);
        Assert.Null(items[^1].FeaturedRank);
    }

    [Fact]
    public async Task ReplaceFeaturedAsync_NewList_ClearsOldAndRanksInOrder()
    {
        var oldFeatured = Add("was-featured", 1, rank: 1);
        var b = Add("b", 2);
        var a = Add("a", 3);

        var result = await _service.ReplaceFeaturedAsync(["b", "a"], CancellationToken.None);

        Assert.Equal(["b", "a"], result.Applied);
        Assert.Empty(result.NotFound);
        Assert.Null(oldFeatured.FeaturedRank);
        Assert.Equal(1, b.FeaturedRank);
        Assert.Equal(2, a.FeaturedRank);
        _db.Verify(x => x.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task ReplaceFeaturedAsync_UnknownAndDraftSlugs_ReportedNotFoundAndRanksStayContiguous()
    {
        var draft = Add("draft", 1, status: EditionStatus.Draft);
        var a = Add("a", 2);
        var b = Add("b", 3);

        var result = await _service.ReplaceFeaturedAsync(["a", "missing", "draft", "b"], CancellationToken.None);

        Assert.Equal(["a", "b"], result.Applied);
        Assert.Equal(["missing", "draft"], result.NotFound);
        Assert.Equal(1, a.FeaturedRank);
        Assert.Equal(2, b.FeaturedRank);
        Assert.Null(draft.FeaturedRank);
    }

    [Fact]
    public async Task ReplaceFeaturedAsync_DuplicatesAndBlanks_IgnoredFirstOccurrenceWins()
    {
        var a = Add("a", 1);
        var b = Add("b", 2);

        var result = await _service.ReplaceFeaturedAsync([" a ", "", "b", "a"], CancellationToken.None);

        Assert.Equal(["a", "b"], result.Applied);
        Assert.Equal(1, a.FeaturedRank);
        Assert.Equal(2, b.FeaturedRank);
    }
}
