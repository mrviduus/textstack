using Api.Middleware;

namespace TextStack.UnitTests;

/// <summary>
/// The debounce behind <c>users.LastActiveAt</c> for guests.
///
/// <para>This exists because the middleware it belongs to shipped inert: it read the guest flag from
/// <c>HttpContext.User</c>, which this API never populates, so it returned on its first line for
/// every request ever served and the column was only ever written at guest creation. It also had no
/// pure seam — nothing about it could be asserted without a live pipeline, which is part of why the
/// defect survived review. This is that seam.</para>
/// </summary>
public class GuestActivityDebounceTests
{
    private static readonly DateTimeOffset Now = new(2026, 9, 11, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ShouldWrite_FirstRequestOfThisProcess_Writes()
    {
        // Null means "not seen since startup", NOT "never active". A deploy empties the cache, and
        // the first request after one must write — otherwise a restart every few minutes would
        // starve the column forever.
        Assert.True(GuestActivityMiddleware.ShouldWrite(null, Now));
    }

    [Fact]
    public void ShouldWrite_ImmediatelyAfterAWrite_DoesNot()
    {
        // A reader's 30-second progress heartbeat would write this column 120 times an hour.
        Assert.False(GuestActivityMiddleware.ShouldWrite(Now.AddSeconds(-30), Now));
    }

    [Fact]
    public void ShouldWrite_AtExactlyTheInterval_Writes()
    {
        // The boundary is inclusive on purpose: with a cache entry that expires after exactly the
        // debounce, an exclusive comparison would make the two rules disagree at the one instant
        // they meet.
        Assert.True(GuestActivityMiddleware.ShouldWrite(
            Now - GuestActivityMiddleware.DebounceInterval, Now));
    }

    [Fact]
    public void ShouldWrite_AfterTheInterval_Writes()
    {
        Assert.True(GuestActivityMiddleware.ShouldWrite(Now.AddHours(-3), Now));
    }

    [Fact]
    public void DebounceInterval_IsSmallAgainstTheCleanupThreshold()
    {
        // GuestCleanupWorker deletes at 30 days. The debounce only has to be small against that; it
        // is sized for write traffic, not for accuracy. A debounce that ever approached the
        // threshold would delete readers who were active the whole time.
        Assert.True(GuestActivityMiddleware.DebounceInterval < TimeSpan.FromDays(1));
    }
}
