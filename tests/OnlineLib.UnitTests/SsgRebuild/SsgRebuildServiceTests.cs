using System.Linq.Expressions;
using Application.Common.Interfaces;
using Application.SsgRebuild;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Query;
using Moq;

namespace OnlineLib.UnitTests.SsgRebuild;

public class SsgRebuildServiceTests
{
    private readonly Mock<IAppDbContext> _mockDb;
    private readonly SsgRebuildService _service;

    private static readonly Guid TestSiteId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    public SsgRebuildServiceTests()
    {
        _mockDb = new Mock<IAppDbContext>();
        _service = new SsgRebuildService(_mockDb.Object);
    }

    [Fact]
    public async Task GetRoutesAsync_FullMode_ReturnsStaticAndContentRoutes()
    {
        // Arrange
        var site = new Site
        {
            Id = TestSiteId,
            Code = "general",
            PrimaryDomain = "general.localhost",
            DefaultLanguage = "en"
        };

        var editions = new List<Edition>
        {
            new()
            {
                Id = Guid.NewGuid(),
                SiteId = TestSiteId,
                Slug = "book-1",
                Title = "Book 1",
                Language = "en",
                Status = EditionStatus.Published,
                Indexable = true
            }
        }.AsQueryable();

        var authors = new List<Author>
        {
            new()
            {
                Id = Guid.NewGuid(),
                SiteId = TestSiteId,
                Slug = "author-1",
                Name = "Author 1",
                Indexable = true,
                EditionAuthors = [new EditionAuthor { Edition = editions.First() }]
            }
        }.AsQueryable();

        var genres = new List<Genre>
        {
            new()
            {
                Id = Guid.NewGuid(),
                SiteId = TestSiteId,
                Slug = "genre-1",
                Name = "Genre 1",
                Indexable = true,
                Editions = [editions.First()]
            }
        }.AsQueryable();

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var routes = await _service.GetRoutesAsync(
            TestSiteId,
            SsgRebuildMode.Full,
            null, null, null,
            CancellationToken.None);

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
        var site = new Site
        {
            Id = TestSiteId,
            Code = "general",
            PrimaryDomain = "general.localhost",
            DefaultLanguage = "en"
        };

        var editions = new List<Edition>
        {
            new()
            {
                Id = Guid.NewGuid(),
                SiteId = TestSiteId,
                Slug = "book-1",
                Title = "Book 1",
                Language = "en",
                Status = EditionStatus.Published,
                Indexable = true
            },
            new()
            {
                Id = Guid.NewGuid(),
                SiteId = TestSiteId,
                Slug = "book-2",
                Title = "Book 2",
                Language = "en",
                Status = EditionStatus.Published,
                Indexable = true
            }
        }.AsQueryable();

        var authors = new List<Author>().AsQueryable();
        var genres = new List<Genre>().AsQueryable();

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var routes = await _service.GetRoutesAsync(
            TestSiteId,
            SsgRebuildMode.Specific,
            ["book-1"], null, null,
            CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("book-1"));
        Assert.DoesNotContain(bookRoutes, r => r.Route.Contains("book-2"));
    }

    [Fact]
    public async Task GetPreviewAsync_ReturnsCorrectCounts()
    {
        // Arrange
        var site = new Site
        {
            Id = TestSiteId,
            Code = "general",
            PrimaryDomain = "general.localhost",
            DefaultLanguage = "en"
        };

        var editions = new List<Edition>
        {
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "book-1", Title = "Book 1", Language = "en", Status = EditionStatus.Published, Indexable = true },
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "book-2", Title = "Book 2", Language = "en", Status = EditionStatus.Published, Indexable = true }
        }.AsQueryable();

        var authors = new List<Author>
        {
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "author-1", Name = "Author 1", Indexable = true, EditionAuthors = [new EditionAuthor { Edition = editions.First() }] }
        }.AsQueryable();

        var genres = new List<Genre>
        {
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "genre-1", Name = "Genre 1", Indexable = true, Editions = [editions.First()] }
        }.AsQueryable();

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var preview = await _service.GetPreviewAsync(TestSiteId, "Full", null, null, null, CancellationToken.None);

        // Assert
        Assert.Equal(2, preview.BookCount);
        Assert.Equal(1, preview.AuthorCount);
        Assert.Equal(1, preview.GenreCount);
        Assert.Equal(4, preview.StaticCount); // /, /books, /authors, /genres
    }

    [Fact]
    public async Task GetRoutesAsync_ExcludesNonIndexableContent()
    {
        // Arrange
        var site = new Site
        {
            Id = TestSiteId,
            Code = "general",
            PrimaryDomain = "general.localhost",
            DefaultLanguage = "en"
        };

        var editions = new List<Edition>
        {
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "indexable-book", Title = "Indexable Book", Language = "en", Status = EditionStatus.Published, Indexable = true },
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "non-indexable-book", Title = "Non-Indexable Book", Language = "en", Status = EditionStatus.Published, Indexable = false }
        }.AsQueryable();

        var authors = new List<Author>().AsQueryable();
        var genres = new List<Genre>().AsQueryable();

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var routes = await _service.GetRoutesAsync(TestSiteId, SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("indexable-book"));
        Assert.DoesNotContain(bookRoutes, r => r.Route.Contains("non-indexable-book"));
    }

    [Fact]
    public async Task GetRoutesAsync_ExcludesDraftEditions()
    {
        // Arrange
        var site = new Site
        {
            Id = TestSiteId,
            Code = "general",
            PrimaryDomain = "general.localhost",
            DefaultLanguage = "en"
        };

        var editions = new List<Edition>
        {
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "published-book", Title = "Published Book", Language = "en", Status = EditionStatus.Published, Indexable = true },
            new() { Id = Guid.NewGuid(), SiteId = TestSiteId, Slug = "draft-book", Title = "Draft Book", Language = "en", Status = EditionStatus.Draft, Indexable = true }
        }.AsQueryable();

        var authors = new List<Author>().AsQueryable();
        var genres = new List<Genre>().AsQueryable();

        SetupMockDbSets(site, editions, authors, genres);

        // Act
        var routes = await _service.GetRoutesAsync(TestSiteId, SsgRebuildMode.Full, null, null, null, CancellationToken.None);

        // Assert
        var bookRoutes = routes.Where(r => r.RouteType == "book").ToList();
        Assert.Single(bookRoutes);
        Assert.Contains(bookRoutes, r => r.Route.Contains("published-book"));
        Assert.DoesNotContain(bookRoutes, r => r.Route.Contains("draft-book"));
    }

    [Fact]
    public async Task GetRoutesAsync_SiteNotFound_ReturnsEmpty()
    {
        // Arrange
        var sites = new List<Site>().AsQueryable();
        var mockSitesSet = CreateMockDbSet(sites);
        _mockDb.Setup(db => db.Sites).Returns(mockSitesSet.Object);

        // Act
        var routes = await _service.GetRoutesAsync(
            Guid.NewGuid(), // Non-existent site
            SsgRebuildMode.Full,
            null, null, null,
            CancellationToken.None);

        // Assert
        Assert.Empty(routes);
    }

    private void SetupMockDbSets(Site site, IQueryable<Edition> editions, IQueryable<Author> authors, IQueryable<Genre> genres)
    {
        var sites = new List<Site> { site }.AsQueryable();

        var mockSitesSet = CreateMockDbSet(sites);
        var mockEditionsSet = CreateMockDbSet(editions);
        var mockAuthorsSet = CreateMockDbSet(authors);
        var mockGenresSet = CreateMockDbSet(genres);

        _mockDb.Setup(db => db.Sites).Returns(mockSitesSet.Object);
        _mockDb.Setup(db => db.Editions).Returns(mockEditionsSet.Object);
        _mockDb.Setup(db => db.Authors).Returns(mockAuthorsSet.Object);
        _mockDb.Setup(db => db.Genres).Returns(mockGenresSet.Object);
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
}

// Async query helpers for EF Core mocking
internal class TestAsyncEnumerator<T> : IAsyncEnumerator<T>
{
    private readonly IEnumerator<T> _inner;
    public TestAsyncEnumerator(IEnumerator<T> inner) => _inner = inner;
    public T Current => _inner.Current;
    public ValueTask<bool> MoveNextAsync() => new(_inner.MoveNext());
    public ValueTask DisposeAsync()
    {
        _inner.Dispose();
        return default;
    }
}

internal class TestAsyncQueryProvider<TEntity> : IAsyncQueryProvider
{
    private readonly IQueryProvider _inner;
    public TestAsyncQueryProvider(IQueryProvider inner) => _inner = inner;
    public IQueryable CreateQuery(Expression expression) => new TestAsyncEnumerable<TEntity>(expression);
    public IQueryable<TElement> CreateQuery<TElement>(Expression expression) => new TestAsyncEnumerable<TElement>(expression);
    public object? Execute(Expression expression) => _inner.Execute(expression);
    public TResult Execute<TResult>(Expression expression) => _inner.Execute<TResult>(expression);
    public TResult ExecuteAsync<TResult>(Expression expression, CancellationToken cancellationToken = default)
    {
        var resultType = typeof(TResult).GetGenericArguments()[0];
        var executeMethod = typeof(IQueryProvider).GetMethod(nameof(IQueryProvider.Execute), 1, [typeof(Expression)]);
        var result = executeMethod!.MakeGenericMethod(resultType).Invoke(_inner, [expression]);
        return (TResult)typeof(Task).GetMethod(nameof(Task.FromResult))!.MakeGenericMethod(resultType).Invoke(null, [result])!;
    }
}

internal class TestAsyncEnumerable<T> : EnumerableQuery<T>, IAsyncEnumerable<T>, IQueryable<T>
{
    public TestAsyncEnumerable(IEnumerable<T> enumerable) : base(enumerable) { }
    public TestAsyncEnumerable(Expression expression) : base(expression) { }
    public IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken cancellationToken = default)
        => new TestAsyncEnumerator<T>(this.AsEnumerable().GetEnumerator());
    IQueryProvider IQueryable.Provider => new TestAsyncQueryProvider<T>(this);
}
