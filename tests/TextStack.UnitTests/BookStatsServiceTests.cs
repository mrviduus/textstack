using Application.Common.Interfaces;
using Application.UserBooks;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Moq;

namespace TextStack.UnitTests;

/// <summary>
/// Book stats: the displayed wpm is this book's MEASURED average; the estimate uses the one pace
/// rule (personal pace at ≥3 sessions, else 200).
/// </summary>
public class BookStatsServiceTests
{
    private static readonly Guid UserId = Guid.NewGuid();
    private static readonly Guid BookId = Guid.NewGuid();

    private static BookStatsService Service(List<ReadingSession> sessions)
    {
        var db = new Mock<IAppDbContext>();
        db.Setup(x => x.UserBooks).Returns(() => FakeSet(new List<UserBook>
        {
            new() { Id = BookId, UserId = UserId, Title = "T", Slug = "t", Language = "en", TotalWordCount = 10_000, ProgressPercent = 0.5 },
        }).Object);
        db.Setup(x => x.ReadingSessions).Returns(() => FakeSet(sessions).Object);
        db.Setup(x => x.VocabularyWords).Returns(() => FakeSet(new List<VocabularyWord>()).Object);
        db.Setup(x => x.Highlights).Returns(() => FakeSet(new List<Highlight>()).Object);
        return new BookStatsService(db.Object);
    }

    private static ReadingSession Session(Guid? userBookId, int seconds, int words) => new()
    {
        Id = Guid.NewGuid(),
        UserId = UserId,
        UserBookId = userBookId,
        DurationSeconds = seconds,
        WordsRead = words,
        StartedAt = DateTimeOffset.UtcNow,
        EndedAt = DateTimeOffset.UtcNow,
    };

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
    public async Task GetStatsAsync_WithSessions_ShowsPerBookWpmAndEstimatesFromOverallPace()
    {
        var svc = Service(
        [
            Session(BookId, 600, 2000),
            Session(BookId, 600, 1000),          // this book: 3000 words / 20 min = 150.0
            Session(Guid.NewGuid(), 60, 1000),   // overall: 4000 / 21 min = 190.48 → 190 wpm
        ]);

        var r = await svc.GetStatsAsync(UserId, BookId, CancellationToken.None);

        Assert.NotNull(r);
        Assert.Equal(2, r!.SessionsCount);
        Assert.Equal(150.0m, r.AverageWordsPerMinute);
        Assert.Equal(26, r.EstimatedMinutesRemaining); // 5000 / 190 = 26.3 → 26
    }

    [Fact]
    public async Task GetStatsAsync_NoSessions_ZeroWpmAndFallbackEstimate()
    {
        var r = await Service([]).GetStatsAsync(UserId, BookId, CancellationToken.None);

        Assert.NotNull(r);
        Assert.Equal(0m, r!.AverageWordsPerMinute);
        Assert.Equal(25, r.EstimatedMinutesRemaining); // 5000 / 200
    }
}
