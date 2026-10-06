using static Application.Ingestion.ChapterReconciler;

namespace TextStack.UnitTests;

/// <summary>
/// ADR-018 known limits. (1) Admin chapter delete and the quality pipeline's delete/merge re-pointed
/// Ids but left slug locators naming the removed chapter. (2) <c>MaxChapterNumber</c>, the review
/// frontier, was never remapped when chapters were renumbered, so it moved by the shift.
/// </summary>
public class ChapterRemovalRemapTests
{
    private static readonly Guid A = Guid.NewGuid(), B = Guid.NewGuid(), C = Guid.NewGuid(), D = Guid.NewGuid();

    [Fact]
    public void PlanFromIds_AdminDeleteMiddle_RemovedSlugResetToPreviousChapter()
    {
        // Delete B (number 1); C renumbers 2 → 1, slugs unchanged.
        var plan = PlanFromIds([A, B, C], [A, C], new Dictionary<Guid, Guid?> { [B] = A });

        var moves = SlugMoves(plan, ["1-a", "2-b", "3-c"], ["1-a", "3-c"]);

        Assert.Equal(new SlugMove("1-a", Reset: true), Assert.Single(moves).Value);
        Assert.Equal("scroll:1-a:0", MoveLocator("scroll:2-b:840", moves));
        Assert.Equal("chapter:1-a", MoveLocator("chapter:2-b", moves));
        Assert.Equal("scroll:3-c:120", MoveLocator("scroll:3-c:120", moves));
    }

    [Fact]
    public void PlanFromIds_MergeIntoFirst_EveryMergedSlugGoesToFirst()
    {
        var plan = PlanFromIds([A, B, C, D], [A, D], new Dictionary<Guid, Guid?> { [B] = A, [C] = A });

        var moves = SlugMoves(plan, ["a", "b", "c", "d"], ["a", "d"]);

        Assert.Equal(2, moves.Count);
        Assert.All(moves.Values, m => Assert.Equal(new SlugMove("a", Reset: true), m));
    }

    [Fact]
    public void PlanFromIds_LastChapterDeleted_NoSuccessorNoMove()
    {
        var plan = PlanFromIds([A], [], new Dictionary<Guid, Guid?> { [A] = null });

        Assert.Empty(plan.Successors);
        Assert.Empty(SlugMoves(plan, ["a"], []));
    }

    [Fact]
    public void NumberMoves_AdminDeleteMiddle_LaterChaptersShiftDown()
    {
        var plan = PlanFromIds([A, B, C], [A, C], new Dictionary<Guid, Guid?> { [B] = A });

        var numbers = NumberMoves(plan, [0, 1, 2], [0, 1]);

        Assert.Equal(new Dictionary<int, int> { [0] = 0, [1] = 0, [2] = 1 }, numbers);
    }

    [Theory]
    [InlineData(2, 1)] // reached C (old 2) → C is now 1
    [InlineData(1, 0)] // reached the deleted B → the frontier is A; C (now 1) was not reached
    [InlineData(0, 0)]
    public void RemapMaxChapterNumber_AdminDeleteMiddle_FollowsTheChapters(int oldMax, int expected)
    {
        var numbers = new Dictionary<int, int> { [0] = 0, [1] = 0, [2] = 1 };

        Assert.Equal(expected, RemapMaxChapterNumber(oldMax, numbers));
    }

    [Fact]
    public void RemapMaxChapterNumber_ChapterAddedInFront_FrontierMovesUp()
    {
        // Re-ingest: [X(new), A, B, C] — every old chapter shifted up by one.
        var plan = Plan(
            [new Key(0, "1-a", "A"), new Key(1, "2-b", "B"), new Key(2, "3-c", "C")],
            [new Key(0, "1-x", "X"), new Key(1, "2-a", "A"), new Key(2, "3-b", "B"), new Key(3, "4-c", "C")]);

        var numbers = NumberMoves(plan, [0, 1, 2], [0, 1, 2, 3]);

        Assert.Equal(2, RemapMaxChapterNumber(1, numbers));
    }

    [Fact]
    public void RemapMaxChapterNumber_NullOrNothingBelow_Unchanged()
    {
        var numbers = new Dictionary<int, int> { [3] = 2 };

        Assert.Null(RemapMaxChapterNumber(null, numbers));
        Assert.Equal(1, RemapMaxChapterNumber(1, numbers));
    }
}
