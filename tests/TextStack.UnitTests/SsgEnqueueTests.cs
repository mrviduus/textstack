using Application.Admin;
using Application.Common.Interfaces;
using Application.SsgRebuild;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Moq;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// ADR-023: the SSG enqueue after an admin edit or publish is awaited, never fire-and-forget, and a
/// failed enqueue is logged rather than turning the committed edit into a 500. Production had zero
/// Specific jobs ever: the un-awaited enqueue ran on the request's DbContext after the request ended,
/// and an empty catch swallowed the result.
/// </summary>
public class SsgEnqueueTests
{
    private readonly Edition _edition = new()
    {
        Id = Guid.NewGuid(),
        SiteId = Guid.NewGuid(),
        Slug = "dracula",
        Title = "Dracula",
        Language = "en",
        Status = EditionStatus.Draft,
    };

    private readonly Mock<IAppDbContext> _db = new();
    private readonly Mock<ISsgJobService> _ssg = new();

    public SsgEnqueueTests()
    {
        _db.Setup(d => d.Editions).Returns(new FakeDbSet<Edition>([_edition]));
        _db.Setup(d => d.Chapters).Returns(new FakeDbSet<Chapter>([new Chapter { EditionId = _edition.Id, Title = "I", Html = "<p>x</p>", PlainText = "x" }]));
    }

    private AdminService Service() => new(_db.Object, null!, _ssg.Object, null!);

    [Fact]
    public async Task PublishEditionAsync_EnqueueStillRunning_DoesNotCompleteUntilEnqueueDoes()
    {
        var enqueue = new TaskCompletionSource();
        _ssg.Setup(s => s.TryEnqueueSsgRebuildAsync(It.IsAny<CreateSsgRebuildJobRequest>())).Returns(enqueue.Task);

        var publish = Service().PublishEditionAsync(_edition.Id, CancellationToken.None);

        Assert.False(publish.IsCompleted); // fire-and-forget would already have returned
        enqueue.SetResult();
        Assert.Equal((true, (string?)null), await publish);
    }

    [Fact]
    public async Task PublishEditionAsync_Published_EnqueuesSpecificRebuildOfThatBook()
    {
        CreateSsgRebuildJobRequest? sent = null;
        _ssg.Setup(s => s.TryEnqueueSsgRebuildAsync(It.IsAny<CreateSsgRebuildJobRequest>()))
            .Callback<CreateSsgRebuildJobRequest>(r => sent = r)
            .Returns(Task.CompletedTask);

        await Service().PublishEditionAsync(_edition.Id, CancellationToken.None);

        Assert.NotNull(sent);
        Assert.Equal("Specific", sent.Mode);
        Assert.Equal(_edition.SiteId, sent.SiteId);
        Assert.Equal(["dracula"], sent.BookSlugs!);
        _db.Verify(d => d.SaveChangesAsync(It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task UnpublishEditionAsync_EnqueueStillRunning_AwaitsFullRebuild()
    {
        _edition.Status = EditionStatus.Published;
        // UnpublishEditionAsync uses FindAsync, which the list-backed set does not implement.
        var editions = new Mock<DbSet<Edition>>();
        editions.Setup(e => e.FindAsync(It.IsAny<object?[]?>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(_edition);
        _db.Setup(d => d.Editions).Returns(editions.Object);
        var enqueue = new TaskCompletionSource();
        CreateSsgRebuildJobRequest? sent = null;
        _ssg.Setup(s => s.TryEnqueueSsgRebuildAsync(It.IsAny<CreateSsgRebuildJobRequest>()))
            .Callback<CreateSsgRebuildJobRequest>(r => sent = r)
            .Returns(enqueue.Task);

        var unpublish = Service().UnpublishEditionAsync(_edition.Id, CancellationToken.None);

        Assert.False(unpublish.IsCompleted);
        enqueue.SetResult();
        Assert.Equal((true, (string?)null), await unpublish);
        Assert.Equal("Full", sent!.Mode);
    }

    [Fact]
    public async Task TryEnqueueSsgRebuildAsync_EnqueueThrows_LogsErrorAndDoesNotThrow()
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(d => d.SsgRebuildJobs).Throws(new InvalidOperationException("context disposed"));
        var logger = new CapturingLogger();
        var service = new SsgRebuildService(db.Object, Mock.Of<ISsgRouteProvider>(), logger);

        await service.TryEnqueueSsgRebuildAsync(new CreateSsgRebuildJobRequest(Guid.NewGuid(), "Specific", BookSlugs: ["dracula"]));

        var (level, ex) = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Error, level);
        Assert.Equal("context disposed", ex!.Message);
    }

    private sealed class CapturingLogger : ILogger<SsgRebuildService>
    {
        public List<(LogLevel Level, Exception? Exception)> Entries { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Entries.Add((logLevel, exception));
    }
}
