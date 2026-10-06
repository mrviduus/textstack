using System.Text.Json;
using Domain.Entities;
using Domain.Utilities;
using static Application.Ingestion.ChapterReconciler;

namespace TextStack.UnitTests;

/// <summary>
/// Re-ingestion keeps chapter Ids (#715), but positions also name the chapter by SLUG — the progress
/// locator (<c>scroll:&lt;slug&gt;:&lt;px&gt;</c>), the text-anchor position JSON (<c>chapterSlug</c>),
/// bookmark locators (<c>chapter:&lt;slug&gt;</c>) and insights. A slug that changed, or a chapter
/// whose readers went to a neighbour, left those strings pointing at a chapter that no longer exists.
/// </summary>
public class ChapterPositionRemapTests
{
    private static Key K(int number, string title) =>
        new(number, SlugGenerator.GenerateChapterSlug(title, number), title);

    private static List<Key> Book(params string[] titles) => titles.Select((t, i) => K(i, t)).ToList();

    private static IReadOnlyDictionary<string, SlugMove> MovesFor(List<Key> before, List<Key> after) =>
        SlugMoves(Plan(before, after), before.Select(k => k.Slug).ToList(), after.Select(k => k.Slug).ToList());

    private static readonly List<Key> Before = Book("Contents", "Chapter One", "Chapter Two");
    // TOC dropped: every survivor's slug shifts by one, the TOC's readers go to Chapter One.
    private static readonly List<Key> After = Book("Chapter One", "Chapter Two");

    private static string S(List<Key> book, int i) => book[i].Slug!;

    /// <summary>A shift where one chapter takes another's old slug: a→b, b→c.</summary>
    private static readonly Dictionary<string, SlugMove> Chain = new()
    {
        ["a"] = new("b", Reset: false),
        ["b"] = new("c", Reset: false),
    };

    [Fact]
    public void SlugMoves_FrontMatterDropped_MatchedMoveKeepOffsetRemovedReset()
    {
        var moves = MovesFor(Before, After);

        Assert.Equal(3, moves.Count);
        Assert.Equal(new SlugMove(S(After, 0), Reset: false), moves[S(Before, 1)]);
        Assert.Equal(new SlugMove(S(After, 1), Reset: false), moves[S(Before, 2)]);
        Assert.Equal(new SlugMove(S(After, 0), Reset: true), moves[S(Before, 0)]);
    }

    [Fact]
    public void SlugMoves_SameContent_Empty()
    {
        Assert.Empty(MovesFor(Before, Book("Contents", "Chapter One", "Chapter Two")));
    }

    [Fact]
    public void MoveLocator_MatchedChapterSlugChanged_KeepsOffset()
    {
        var moves = MovesFor(Before, After);

        Assert.Equal($"scroll:{S(After, 1)}:1234", MoveLocator($"scroll:{S(Before, 2)}:1234", moves));
        Assert.Equal($"chapter:{S(After, 1)}", MoveLocator($"chapter:{S(Before, 2)}", moves));
    }

    [Fact]
    public void MoveLocator_ChapterTakesAnotherOldSlug_EachMovedOnceNotChained()
    {
        Assert.Equal("scroll:b:5", MoveLocator("scroll:a:5", Chain));
        Assert.Equal("scroll:c:5", MoveLocator("scroll:b:5", Chain));
    }

    [Fact]
    public void MoveLocator_RepointedToNeighbour_ResetsToChapterStart()
    {
        var moves = MovesFor(Before, After);

        Assert.Equal($"scroll:{S(After, 0)}:0", MoveLocator($"scroll:{S(Before, 0)}:880", moves));
        Assert.Equal($"chapter:{S(After, 0)}", MoveLocator($"chapter:{S(Before, 0)}", moves));
    }

    [Theory]
    [InlineData("page:16")]
    [InlineData("""{"type":"end"}""")]
    [InlineData("""{"type":"start"}""")]
    [InlineData("scroll:unknown-slug:10")]
    [InlineData("chapter:unknown-slug")]
    [InlineData("epubcfi(/6/4!/4/2)")]
    public void MoveLocator_NotAMovedChapter_Unchanged(string locator)
    {
        Assert.Equal(locator, MoveLocator(locator, MovesFor(Before, After)));
    }

    private static string Position(string slug) => JsonSerializer.Serialize(new
    {
        v = 1,
        chapterSlug = slug,
        anchor = new { prefix = "a", exact = "real books", suffix = "b", startOffset = 40, endOffset = 50 },
        charOffset = 40,
        chapterFraction = 0.3,
    });

    [Fact]
    public void MovePosition_MatchedChapterSlugChanged_KeepsAnchor()
    {
        var moved = MovePosition(Position(S(Before, 2)), MovesFor(Before, After));

        var json = JsonDocument.Parse(moved!).RootElement;
        Assert.Equal(S(After, 1), json.GetProperty("chapterSlug").GetString());
        Assert.Equal("real books", json.GetProperty("anchor").GetProperty("exact").GetString());
        Assert.Equal(40, json.GetProperty("charOffset").GetInt32());
        Assert.Equal(0.3, json.GetProperty("chapterFraction").GetDouble());
    }

    [Fact]
    public void MovePosition_RepointedToNeighbour_Cleared()
    {
        // Different text — the anchor would point into nothing. The locator says "chapter start".
        Assert.Null(MovePosition(Position(S(Before, 0)), MovesFor(Before, After)));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not json")]
    [InlineData("""{"v":1,"chapterSlug":"unknown"}""")]
    [InlineData("""{"v":1,"chapterSlug":7}""")]
    [InlineData("[1,2]")]
    public void MovePosition_NothingToMove_Unchanged(string? json)
    {
        Assert.Equal(json, MovePosition(json, MovesFor(Before, After)));
    }

    private static BookInsight Insight(Guid userId, string? slug) =>
        new() { Id = Guid.NewGuid(), UserId = userId, ChapterSlug = slug };

    [Fact]
    public void InsightMoves_MatchedSlugChanged_Moved_RemovedGoesToFreeNeighbour_BookLevelLeft()
    {
        var user = Guid.NewGuid();
        var moved = Insight(user, S(Before, 2));
        var gone = Insight(user, S(Before, 0)); // TOC removed; its readers went to Chapter One
        var book = Insight(user, null);

        var result = InsightMoves([moved, gone, book], MovesFor(Before, After), (_, _) => { });

        Assert.Equal([(moved, S(After, 1)), (gone, S(After, 0))], result);
    }

    /// <summary>Positional slugs: chapter "2-chapter" removed, "3-chapter" moves into its slug.</summary>
    private static readonly Dictionary<string, SlugMove> Reuse = new()
    {
        ["2-chapter"] = new("1-chapter", Reset: true),
        ["3-chapter"] = new("2-chapter", Reset: false),
    };

    [Fact]
    public void InsightMoves_RemovedChapterSlugReused_GenuineMoveTakesIt_RemovedParkedWhenNeighbourTaken()
    {
        var user = Guid.NewGuid();
        var removed = Insight(user, "2-chapter");
        var genuine = Insight(user, "3-chapter");
        var neighbour = Insight(user, "1-chapter");
        var collided = new List<BookInsight>();

        var result = InsightMoves([removed, genuine, neighbour], Reuse, (i, _) => collided.Add(i));

        // The old insight must not show up on the chapter now called 2-chapter, nor block its move.
        Assert.Equal([(removed, "~orphan:2-chapter"), (genuine, "2-chapter")], result);
        Assert.Equal([removed], collided);
    }

    [Fact]
    public void InsightMoves_RemovedChapterSlugReused_NeighbourFree_RemovedMovesToNeighbour()
    {
        var user = Guid.NewGuid();
        var removed = Insight(user, "2-chapter");
        var genuine = Insight(user, "3-chapter");

        var result = InsightMoves([removed, genuine], Reuse, (_, _) => throw new InvalidOperationException());

        Assert.Equal([(removed, "1-chapter"), (genuine, "2-chapter")], result);
    }

    [Fact]
    public void InsightMoves_RemovedAndOrphanMarkerTaken_ParkedOnItsId()
    {
        var user = Guid.NewGuid();
        var removed = Insight(user, "2-chapter");
        var neighbour = Insight(user, "1-chapter");
        var earlierOrphan = Insight(user, "~orphan:2-chapter"); // left by a previous re-ingest

        var result = InsightMoves([removed, neighbour, earlierOrphan], Reuse, (_, _) => { });

        Assert.Equal([(removed, $"~orphan:{removed.Id:N}")], result);
    }

    [Fact]
    public void InsightMoves_TargetSlugAlreadyHeld_SkippedAndReported_OtherUsersUnaffected()
    {
        var user = Guid.NewGuid();
        var holder = Insight(user, S(After, 0)); // a stale insight already on Chapter One's new slug
        var blocked = Insight(user, S(Before, 1));
        var behind = Insight(user, S(Before, 2));
        var otherUsers = Insight(Guid.NewGuid(), S(Before, 1));
        var skipped = new List<BookInsight>();

        var result = InsightMoves([holder, blocked, behind, otherUsers], MovesFor(Before, After), (i, _) => skipped.Add(i));

        Assert.Equal([blocked], skipped);
        Assert.Equal([(behind, S(After, 1)), (otherUsers, S(After, 0))], result);
    }

    [Fact]
    public void InsightMoves_SkipCascadesIntoNextMove_AlsoSkipped()
    {
        // a→b, b→c, but the user already holds c: b is blocked and stays on b, which then blocks a.
        var user = Guid.NewGuid();
        var a = Insight(user, "a");
        var b = Insight(user, "b");
        var stale = Insight(user, "c");
        var skipped = new List<BookInsight>();

        var result = InsightMoves([a, b, stale], Chain, (i, _) => skipped.Add(i));

        Assert.Empty(result);
        Assert.Equal([b, a], skipped);
    }

    [Fact]
    public void InsightMoves_ChainWithoutCollision_AllMove()
    {
        var user = Guid.NewGuid();
        var a = Insight(user, "a");
        var b = Insight(user, "b");

        var result = InsightMoves([a, b], Chain, (_, _) => throw new InvalidOperationException("no collision"));

        Assert.Equal([(a, "b"), (b, "c")], result);
    }
}
