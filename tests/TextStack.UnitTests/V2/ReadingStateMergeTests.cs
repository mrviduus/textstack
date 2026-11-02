using Domain.Reading;

namespace TextStack.UnitTests.V2;

/// <summary>The reading-state rule of v2-sync-protocol.md "Guest → account merge", and the offered-frontier rule it shares with a write.</summary>
public class ReadingStateMergeTests
{
    private static readonly DateTimeOffset Earlier = new(2026, 11, 1, 10, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Later = Earlier.AddMinutes(5);

    private static ReadingState State(decimal position, decimal? frontier, DateTimeOffset at, long revision, long? reset = null, DateTimeOffset? completed = null) => new()
    {
        CurrentLocator = $"p{position}",
        BookFraction = position,
        FrontierLocator = frontier is null ? null : $"f{frontier}",
        FrontierFraction = frontier,
        ClientRecordedAt = at,
        Revision = revision,
        ResetRevision = reset,
        CompletedAt = completed,
    };

    [Fact]
    public void Merge_GuestNewer_GuestsPositionAndCompletionAccountsResetRevisionPastBoth()
    {
        var merged = ReadingState.Merge(State(0.3m, 0.3m, Later, 2, completed: Later), State(0.2m, 0.8m, Earlier, 5, reset: 4));

        Assert.Equal(("p0.3", 0.3m, "f0.8", 0.8m, (DateTimeOffset?)Later, Later, 6L, (long?)4),
            (merged.CurrentLocator, merged.BookFraction, merged.FrontierLocator, merged.FrontierFraction, merged.CompletedAt, merged.ClientRecordedAt, merged.Revision, merged.ResetRevision));
    }

    [Fact]
    public void Merge_Tie_TheAccountWins()
    {
        var merged = ReadingState.Merge(State(0.3m, 0.3m, Earlier, 1), State(0.2m, 0.2m, Earlier, 1));

        Assert.Equal((0.2m, 0.3m, 2L), (merged.BookFraction, merged.FrontierFraction, merged.Revision));
    }

    [Fact]
    public void Merge_AccountNewerAfterAResetCompletionNull_FrontierIsItsPositionNotTheGuestsOlderOne()
    {
        var merged = ReadingState.Merge(State(0.3m, 0.3m, Earlier, 1, completed: Earlier), State(0.5m, null, Later, 3, reset: 3));

        Assert.Equal(("p0.5", 0.5m, (DateTimeOffset?)null), (merged.FrontierLocator, merged.FrontierFraction, merged.CompletedAt));
    }

    [Theory]
    [InlineData("f", 0.5, 0.5, "f", 0.5)]   // a frontier level with the position is the frontier
    [InlineData("f", 0.4, 0.5, "p", 0.5)]   // behind the position: the position
    [InlineData(null, 0.9, 0.5, "p", 0.5)]  // half a frontier: the position
    [InlineData("f", null, 0.5, "p", 0.5)]
    [InlineData("f", 0.9, 0.5, "f", 0.9)]
    public void Furthest_FrontierAndPosition_TheFurthestCompletePairFirstOnATie(
        string? frontierLocator, double? frontierFraction, double position, string locator, double fraction)
    {
        var furthest = ReadingState.Furthest((frontierLocator, (decimal?)frontierFraction), ("p", (decimal)position));

        Assert.Equal((locator, (decimal)fraction), furthest);
    }
}
