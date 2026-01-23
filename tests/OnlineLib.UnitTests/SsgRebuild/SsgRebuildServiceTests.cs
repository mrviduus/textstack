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

/// <summary>
/// Tests for SsgRebuildService - job management logic.
/// Route generation tests are in SsgRouteProviderTests.
/// </summary>
public class SsgRebuildServiceTests
{
    private readonly Mock<IAppDbContext> _mockDb;
    private readonly Mock<ISsgRouteProvider> _mockRouteProvider;
    private readonly SsgRebuildService _service;

    private static readonly Guid TestSiteId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    public SsgRebuildServiceTests()
    {
        _mockDb = new Mock<IAppDbContext>();
        _mockRouteProvider = new Mock<ISsgRouteProvider>();
        _service = new SsgRebuildService(_mockDb.Object, _mockRouteProvider.Object);
    }

    [Fact]
    public async Task GetPreviewAsync_ReturnsCorrectCounts()
    {
        // Arrange
        var routes = new List<SsgRoute>
        {
            new("/en", "static"),
            new("/en/books", "static"),
            new("/en/authors", "static"),
            new("/en/genres", "static"),
            new("/en/books/book-1", "book"),
            new("/en/books/book-2", "book"),
            new("/en/authors/author-1", "author"),
            new("/en/genres/genre-1", "genre")
        };

        _mockRouteProvider
            .Setup(p => p.GetRoutesAsync(TestSiteId, SsgRebuildMode.Full, null, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(routes);

        // Act
        var preview = await _service.GetPreviewAsync(TestSiteId, "Full", null, null, null, CancellationToken.None);

        // Assert
        Assert.Equal(8, preview.TotalRoutes);
        Assert.Equal(2, preview.BookCount);
        Assert.Equal(1, preview.AuthorCount);
        Assert.Equal(1, preview.GenreCount);
        Assert.Equal(4, preview.StaticCount);
    }

    [Fact]
    public async Task CreateJobAsync_CreatesQueuedJob()
    {
        // Arrange
        var sites = new List<Site> { new() { Id = TestSiteId, Code = "general", PrimaryDomain = "general.localhost", DefaultLanguage = "en" } }.AsQueryable();
        var jobs = new List<SsgRebuildJob>().AsQueryable();

        _mockDb.Setup(db => db.Sites).Returns(CreateMockDbSet(sites).Object);
        _mockDb.Setup(db => db.SsgRebuildJobs).Returns(CreateMockDbSet(jobs).Object);
        _mockDb.Setup(db => db.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(1);

        _mockRouteProvider
            .Setup(p => p.GetRoutesAsync(TestSiteId, SsgRebuildMode.Full, null, null, null, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new SsgRoute("/en", "static"), new SsgRoute("/en/books/book-1", "book")]);

        var request = new CreateSsgRebuildJobRequest(TestSiteId, "Full", 4, null, null, null);

        // Act
        var job = await _service.CreateJobAsync(request, CancellationToken.None);

        // Assert
        Assert.Equal(SsgRebuildJobStatus.Queued, job.Status);
        Assert.Equal(2, job.TotalRoutes);
        Assert.Equal(4, job.Concurrency);
    }

    [Fact]
    public async Task CreateJobAsync_SiteNotFound_ThrowsArgumentException()
    {
        // Arrange
        var sites = new List<Site>().AsQueryable();
        _mockDb.Setup(db => db.Sites).Returns(CreateMockDbSet(sites).Object);

        var request = new CreateSsgRebuildJobRequest(Guid.NewGuid(), "Full", 4, null, null, null);

        // Act & Assert
        await Assert.ThrowsAsync<ArgumentException>(() =>
            _service.CreateJobAsync(request, CancellationToken.None));
    }

    [Fact]
    public async Task StartJobAsync_QueuedJob_ReturnsTrue()
    {
        // Arrange
        var jobId = Guid.NewGuid();
        var job = new SsgRebuildJob { Id = jobId, Status = SsgRebuildJobStatus.Queued };
        var jobs = new List<SsgRebuildJob> { job }.AsQueryable();

        _mockDb.Setup(db => db.SsgRebuildJobs).Returns(CreateMockDbSet(jobs).Object);
        _mockDb.Setup(db => db.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(1);

        // Act
        var result = await _service.StartJobAsync(jobId, CancellationToken.None);

        // Assert
        Assert.True(result);
        Assert.Equal(SsgRebuildJobStatus.Running, job.Status);
        Assert.NotNull(job.StartedAt);
    }

    [Fact]
    public async Task StartJobAsync_RunningJob_ReturnsFalse()
    {
        // Arrange
        var jobId = Guid.NewGuid();
        var job = new SsgRebuildJob { Id = jobId, Status = SsgRebuildJobStatus.Running };
        var jobs = new List<SsgRebuildJob> { job }.AsQueryable();

        _mockDb.Setup(db => db.SsgRebuildJobs).Returns(CreateMockDbSet(jobs).Object);

        // Act
        var result = await _service.StartJobAsync(jobId, CancellationToken.None);

        // Assert
        Assert.False(result);
    }

    [Fact]
    public async Task CancelJobAsync_RunningJob_ReturnsTrue()
    {
        // Arrange
        var jobId = Guid.NewGuid();
        var job = new SsgRebuildJob { Id = jobId, Status = SsgRebuildJobStatus.Running };
        var jobs = new List<SsgRebuildJob> { job }.AsQueryable();

        _mockDb.Setup(db => db.SsgRebuildJobs).Returns(CreateMockDbSet(jobs).Object);
        _mockDb.Setup(db => db.SaveChangesAsync(It.IsAny<CancellationToken>())).ReturnsAsync(1);

        // Act
        var result = await _service.CancelJobAsync(jobId, CancellationToken.None);

        // Assert
        Assert.True(result);
        Assert.Equal(SsgRebuildJobStatus.Cancelled, job.Status);
    }

    [Fact]
    public async Task CancelJobAsync_CompletedJob_ReturnsFalse()
    {
        // Arrange
        var jobId = Guid.NewGuid();
        var job = new SsgRebuildJob { Id = jobId, Status = SsgRebuildJobStatus.Completed };
        var jobs = new List<SsgRebuildJob> { job }.AsQueryable();

        _mockDb.Setup(db => db.SsgRebuildJobs).Returns(CreateMockDbSet(jobs).Object);

        // Act
        var result = await _service.CancelJobAsync(jobId, CancellationToken.None);

        // Assert
        Assert.False(result);
    }

    #region Helpers

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
