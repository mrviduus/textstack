using Application.Ingestion;
using Domain.Utilities;
using static Application.Ingestion.ChapterReconciler;

namespace TextStack.UnitTests;

/// <summary>
/// The matching half of re-ingestion (2026-10 reader audit, C1/H1): which existing chapter
/// keeps its Id, and where the readers of a chapter that disappears go.
/// </summary>
public class ChapterReconcilerTests
{
    private static Key K(int number, string title) =>
        new(number, SlugGenerator.GenerateChapterSlug(title, number), title);

    private static List<Key> Book(params string[] titles) =>
        titles.Select((t, i) => K(i, t)).ToList();

    [Fact]
    public void Plan_SameContent_EveryChapterKeepsItsRowAndNothingIsRemoved()
    {
        var book = Book("Preface", "Chapter One", "Chapter Two");

        var plan = Plan(book, Book("Preface", "Chapter One", "Chapter Two"));

        Assert.Equal([0, 1, 2], plan.Matches);
        Assert.Empty(plan.Successors);
    }

    [Fact]
    public void Plan_FrontMatterDropped_ChaptersFollowTheirTitlesNotTheirNumbers()
    {
        // Extractor learned to drop the TOC page: every number and slug shifted by one.
        var plan = Plan(Book("Contents", "Chapter One", "Chapter Two"), Book("Chapter One", "Chapter Two"));

        Assert.Equal([1, 2], plan.Matches);
        // The vanished TOC has nothing before it, so its readers go to the next survivor.
        Assert.Equal([(0, 0)], plan.Successors);
    }

    [Fact]
    public void Plan_ChapterRetitledInPlace_MatchedByNumber()
    {
        var plan = Plan(Book("Chapter One", "Chapter  Tw0"), Book("Chapter One", "Chapter Two"));

        Assert.Equal([0, 1], plan.Matches);
        Assert.Empty(plan.Successors);
    }

    [Fact]
    public void Plan_ChaptersMerged_RemovedOneHandsReadersToThePreviousChapter()
    {
        // Old 1 and 2 merged into new 1 ("Part A"): old 2's text lives there now.
        var plan = Plan(
            Book("Intro", "Part A", "Part A continued", "Part B"),
            Book("Intro", "Part A", "Part B"));

        Assert.Equal([0, 1, 3], plan.Matches);
        Assert.Equal([(2, 1)], plan.Successors);
    }

    [Fact]
    public void Plan_ChapterAdded_InsertedAsNew()
    {
        var plan = Plan(Book("One", "Two"), Book("One", "Interlude", "Two"));

        Assert.Equal(0, plan.Matches[0]);
        Assert.Equal(1, plan.Matches[2]);
        // "Interlude" has number 1, which the title pass already gave to "Two".
        Assert.Equal(-1, plan.Matches[1]);
        Assert.Empty(plan.Successors);
    }

    [Fact]
    public void Plan_NothingMatches_ReadersGoToTheSamePositionClampedToTheNewBook()
    {
        var plan = Plan(Book("a1", "a2", "a3"), [K(10, "x"), K(11, "y")]);

        Assert.Equal([-1, -1], plan.Matches);
        Assert.Equal([(0, 0), (1, 1), (2, 1)], plan.Successors);
    }

    [Fact]
    public void Plan_DuplicateTitles_MatchedInOrderNotAllToTheFirst()
    {
        var plan = Plan(Book("Notes", "Body", "Notes"), Book("Notes", "Body", "Notes"));

        Assert.Equal([0, 1, 2], plan.Matches);
    }

    [Fact]
    public void Plan_ExistingUnsorted_NeighbourChosenByChapterNumberNotListOrder()
    {
        // Rows come back from the database in no particular order.
        List<Key> existing = [K(2, "Three"), K(0, "One"), K(1, "Gone")];

        var plan = Plan(existing, [K(0, "One"), K(1, "Three")]);

        Assert.Equal([1, 0], plan.Matches);
        Assert.Equal([(2, 0)], plan.Successors); // "Gone" (number 1) → "One", the chapter before it
    }

    [Fact]
    public void Plan_EmptyExistingBook_AllNew()
    {
        var plan = Plan([], Book("One"));

        Assert.Equal([-1], plan.Matches);
        Assert.Empty(plan.Successors);
    }
}
