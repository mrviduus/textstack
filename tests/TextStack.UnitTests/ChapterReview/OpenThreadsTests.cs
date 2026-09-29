using Application.ChapterReview;
using Contracts.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class OpenThreadsTests
{
    private static PlacedReview Review(string slug, int? number, ReviewThreadDto[] opened, params string[] closed) =>
        new(slug, number, slug.ToUpperInvariant(), new ChapterReviewDto(1, null, [], ["x"], opened, closed));

    private static ReviewThreadDto T(string slug, string text) => new(OpenThreads.ThreadId(slug, text), text);

    [Fact]
    public void Compute_EarlierChaptersOnly_InReadingOrder()
    {
        var a = T("one", "why logs?");
        var b = T("two", "what about clocks?");
        var later = T("five", "spoiler");
        var reviews = new[]
        {
            Review("two", 2, [b]),
            Review("five", 5, [later]),
            Review("one", 1, [a]),
        };

        var open = OpenThreads.Compute(reviews, targetNumber: 3);

        Assert.Equal([a.Id, b.Id], open.Select(t => t.Id));
        Assert.Equal("ONE", open[0].OpenedInChapter);
    }

    [Fact]
    public void Compute_ClosedInLaterEarlierChapter_Removed()
    {
        var a = T("one", "why logs?");
        var reviews = new[] { Review("one", 1, [a]), Review("two", 2, [], a.Id) };

        Assert.Empty(OpenThreads.Compute(reviews, 3));
        // Reviewing chapter two itself: its own close does not count yet, the thread is still open.
        Assert.Equal([a.Id], OpenThreads.Compute(reviews, 2).Select(t => t.Id));
    }

    [Fact]
    public void Compute_ReReviewEarlierChapter_SeesOnlyWhatCameBefore()
    {
        var a = T("one", "why logs?");
        var c = T("three", "later question");
        var reviews = new[] { Review("one", 1, [a]), Review("three", 3, [c]) };

        Assert.Equal([a.Id], OpenThreads.Compute(reviews, 2).Select(t => t.Id));
    }

    [Fact]
    public void Compute_DanglingCloseAndUnresolvedSlug_Ignored()
    {
        var a = T("one", "why logs?");
        var reviews = new[]
        {
            Review("one", 1, [a], "t_deadbeef"),
            Review("renamed", null, [T("renamed", "lost")]),
        };

        Assert.Equal([a.Id], OpenThreads.Compute(reviews, 5).Select(t => t.Id));
    }

    [Fact]
    public void ThreadId_Deterministic_NormalizedText_SlugScoped()
    {
        Assert.Equal(OpenThreads.ThreadId("one", "Why  logs?"), OpenThreads.ThreadId("one", " why logs? "));
        Assert.NotEqual(OpenThreads.ThreadId("one", "why logs?"), OpenThreads.ThreadId("two", "why logs?"));
        Assert.NotEqual(OpenThreads.ThreadId("one", "why logs?"), OpenThreads.ThreadId("one", "why logs, again?"));
        Assert.Matches("^t_[0-9a-f]{8}$", OpenThreads.ThreadId("one", "x"));
    }

    [Fact]
    public void PromptHash_SixteenHex_IgnoresCaseAndSpacing()
    {
        Assert.Matches("^[0-9a-f]{16}$", OpenThreads.PromptHash("Why?"));
        Assert.Equal(OpenThreads.PromptHash("Why  W+R > N?"), OpenThreads.PromptHash("why w+r > n?"));
    }
}
