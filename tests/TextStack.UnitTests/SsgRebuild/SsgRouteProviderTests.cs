using System.Linq.Expressions;
using Application.Common.Interfaces;
using Application.SsgRebuild;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Query;
using Moq;

namespace TextStack.UnitTests.SsgRebuild;

/// <summary>
/// Tests for SsgRouteProvider - route generation logic.
/// </summary>
public class SsgRouteProviderTests
{
    private readonly Mock<IAppDbContext> _mockDb;
    private readonly SsgRouteProvider _provider;

    private static readonly Guid TestSiteId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    public SsgRouteProviderTests()
    {
        _mockDb = new Mock<IAppDbContext>();
        _provider = new SsgRouteProvider(_mockDb.Object);
    }

    [Fact]
    public async Task GetRoutesAsync_FullMode_ReturnsStaticAndContentRoutes()
    {
        // Arrange
        var site = CreateSite();
        var editions = CreateEditions([("book-1", "Book 1", true, EditionStatus.Published)]);
        var authors = CreateAuthors([("author-1", "Author 1", true)], editions.First());
        var genres = CreateGenres([("genre-1", "Genre 1", true)], editions.First());

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var routes = await _provider.GetRoutesAsync(
            TestSiteId, SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        Assert.NotEmpty(routes);
        Assert.Contains(routes, r => r.RouteType == "static");
        Assert.Contains(routes, r => r.RouteType == "book");
        Assert.Contains(routes, r => r.RouteType == "author");
        Assert.Contains(routes, r => r.RouteType == "genre");
    }

    [Fact]
    public async Task GetRoutesAsync_SpecificMode_OnlyReturnsSpecifiedBooks()
    {
        // Arrange
        var site = CreateSite();
        var editions = CreateEditions([
            ("book-1", "Book 1", true, EditionStatus.Published),
            ("book-2", "Book 2", true, EditionStatus.Published)
        ]);

        SetupMockDbSets(site, editions, new List<Author>().AsQueryable(), new List<Genre>().AsQueryable());

        // Act
        var routes = await _provider.GetRoutesAsync(
            TestSiteId, SsgRebuildMode.Specific, ["book-1"], null, null, CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("book-1"));
        Assert.DoesNotContain(bookRoutes, r => r.Route.Contains("book-2"));
    }

    [Fact]
    public async Task GetRoutesAsync_ExcludesNonIndexableContent()
    {
        // Arrange
        var site = CreateSite();
        var editions = CreateEditions([
            ("indexable-book", "Indexable Book", true, EditionStatus.Published),
            ("non-indexable-book", "Non-Indexable Book", false, EditionStatus.Published)
        ]);

        SetupMockDbSets(site, editions, new List<Author>().AsQueryable(), new List<Genre>().AsQueryable());

        // Act
        var routes = await _provider.GetRoutesAsync(
            TestSiteId, SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("indexable-book"));
    }

    [Fact]
    public async Task GetRoutesAsync_ExcludesDraftEditions()
    {
        // Arrange
        var site = CreateSite();
        var editions = CreateEditions([
            ("published-book", "Published Book", true, EditionStatus.Published),
            ("draft-book", "Draft Book", true, EditionStatus.Draft)
        ]);

        SetupMockDbSets(site, editions, new List<Author>().AsQueryable(), new List<Genre>().AsQueryable());

        // Act
        var routes = await _provider.GetRoutesAsync(
            TestSiteId, SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("published-book"));
    }

    [Fact]
    public async Task GetRoutesAsync_SiteNotFound_ReturnsEmpty()
    {
        // Arrange
        var mockSitesSet = CreateMockDbSet(new List<Site>().AsQueryable());
        _mockDb.Setup(db => db.Sites).Returns(mockSitesSet.Object);

        // Act
        var routes = await _provider.GetRoutesAsync(
            Guid.NewGuid(), SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        Assert.Empty(routes);
    }

    #region Helpers

    private static Site CreateSite() => new()
    {
        Id = TestSiteId,
        Code = "general",
        PrimaryDomain = "general.localhost",
        DefaultLanguage = "en"
    };

    private static IQueryable<Edition> CreateEditions(
        (string slug, string title, bool indexable, EditionStatus status)[] items)
    {
        return items.Select(i => new Edition
        {
            Id = Guid.NewGuid(),
            SiteId = TestSiteId,
            Slug = i.slug,
            Title = i.title,
            Language = "en",
            Status = i.status,
            Indexable = i.indexable
        }).AsQueryable();
    }

    private static IQueryable<Author> CreateAuthors(
        (string slug, string name, bool indexable)[] items, Edition linkedEdition)
    {
        return items.Select(i => new Author
        {
            Id = Guid.NewGuid(),
            SiteId = TestSiteId,
            Slug = i.slug,
            Name = i.name,
            Indexable = i.indexable,
            EditionAuthors = [new EditionAuthor { Edition = linkedEdition }]
        }).AsQueryable();
    }

    private static IQueryable<Genre> CreateGenres(
        (string slug, string name, bool indexable)[] items, Edition linkedEdition)
    {
        return items.Select(i => new Genre
        {
            Id = Guid.NewGuid(),
            SiteId = TestSiteId,
            Slug = i.slug,
            Name = i.name,
            Indexable = i.indexable,
            Editions = [linkedEdition]
        }).AsQueryable();
    }

    private void SetupMockDbSets(Site site, IQueryable<Edition> editions,
        IQueryable<Author> authors, IQueryable<Genre> genres)
    {
        var sites = new List<Site> { site }.AsQueryable();

        _mockDb.Setup(db => db.Sites).Returns(CreateMockDbSet(sites).Object);
        _mockDb.Setup(db => db.Editions).Returns(CreateMockDbSet(editions).Object);
        _mockDb.Setup(db => db.Authors).Returns(CreateMockDbSet(authors).Object);
        _mockDb.Setup(db => db.Genres).Returns(CreateMockDbSet(genres).Object);
    }

    private static Mock<DbSet<T>> CreateMockDbSet<T>(IQueryable<T> data) where T : class
    {
        var mockSet = new Mock<DbSet<T>>();
        mockSet.As<IAsyncEnumerable<T>>()
            .Setup(m => m.GetAsyncEnumerator(It.IsAny<CancellationToken>()))
            .Returns(new TestAsyncEnumerator<T>(data.GetEnumerator()));
        mockSet.As<IQueryable<T>>().Setup(m => m.Provider).Returns(new TestAsyncQueryProvider<T>(data.Provider));
        mockSet.As<IQueryable<T>>().Setup(m => m.Expression).Returns(data.Expression);
        mockSet.As<IQueryable<T>>().Setup(m => m.ElementType).Returns(data.ElementType);
        mockSet.As<IQueryable<T>>().Setup(m => m.GetEnumerator()).Returns(data.GetEnumerator());
        return mockSet;
    }

    #endregion
}
