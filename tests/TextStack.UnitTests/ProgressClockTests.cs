using Api.Endpoints;
using Application.ReadingTracking;
using Domain.Entities;

namespace TextStack.UnitTests;

/// <summary>
/// Catalog progress last-write-wins compares the client's clock with itself, never with the
/// server-stamped UpdatedAt. See <see cref="ProgressClock"/>.
/// </summary>
public class ProgressClockTests
{
    private static readonly DateTimeOffset ServerNow = new(2026, 10, 4, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void IsStale_ClientClockBehindServer_NewerWriteAccepted()
    {
        // Device runs 10 min behind: its previous write was recorded at 11:49 device time, this one
        // at 11:50. Under the old rule (vs server UpdatedAt ~11:59) this was refused.
        var storedClient = ServerNow.AddMinutes(-11);
        var incoming = ServerNow.AddMinutes(-10);

        Assert.False(ProgressClock.IsStale(incoming, storedClient, ServerNow));
    }

    [Fact]
    public void IsStale_OlderClientTimestamp_Rejected()
    {
        Assert.True(ProgressClock.IsStale(ServerNow.AddMinutes(-2), ServerNow.AddMinutes(-1), ServerNow));
    }

    [Fact]
    public void IsStale_EqualTimestamp_Rejected()
    {
        var t = ServerNow.AddMinutes(-1);
        Assert.True(ProgressClock.IsStale(t, t, ServerNow));
    }

    [Fact]
    public void IsStale_NoStoredClientTimestamp_Accepted()
    {
        Assert.False(ProgressClock.IsStale(ServerNow.AddYears(-1), null, ServerNow));
    }

    [Fact]
    public void IsStale_NoIncomingTimestamp_Accepted()
    {
        Assert.False(ProgressClock.IsStale(null, ServerNow, ServerNow));
    }

    [Fact]
    public void Clamp_FarFutureClientClock_ClampedToSkew()
    {
        Assert.Equal(ServerNow + ProgressClock.MaxClientSkew, ProgressClock.Clamp(ServerNow.AddDays(1), ServerNow));
    }

    [Fact]
    public void Clamp_WithinSkew_Unchanged()
    {
        var t = ServerNow.AddMinutes(1);
        Assert.Equal(t, ProgressClock.Clamp(t, ServerNow));
    }

    [Fact]
    public void IsStale_AfterFarFutureWrite_HonestDeviceUnblockedOnceSkewPasses()
    {
        // A device a day ahead stores at most now+skew; an honest write made after that is accepted.
        var stored = ProgressClock.Clamp(ServerNow.AddDays(1), ServerNow);
        var later = ServerNow + ProgressClock.MaxClientSkew + TimeSpan.FromSeconds(1);

        Assert.False(ProgressClock.IsStale(later, stored, later));
    }

    [Fact]
    public void ApplyProgressUpdate_StoresClampedClientTimestamp_AndServerUpdatedAt()
    {
        var target = new ReadingProgress { Locator = "x", ClientUpdatedAt = ServerNow };
        var before = DateTimeOffset.UtcNow;

        UserDataEndpoints.ApplyProgressUpdate(
            target, new UpsertProgressRequest(Guid.NewGuid(), "scroll:a:0", 0.5, DateTimeOffset.UtcNow.AddDays(3), ProgressUnit.Book), 0);

        Assert.True(target.UpdatedAt >= before);
        Assert.Equal(target.UpdatedAt + ProgressClock.MaxClientSkew, target.ClientUpdatedAt);
    }

    [Fact]
    public void ApplyProgressUpdate_NoClientTimestamp_StampsServerNowSoOlderQueuedWriteIsStale()
    {
        // Mark finished / unread and MCP send no stamp. Storing null made the row "never stale", so a
        // queued write recorded BEFORE the mark (an offline flush) undid it on arrival.
        var target = new ReadingProgress { Locator = "x", ClientUpdatedAt = ServerNow };

        UserDataEndpoints.ApplyProgressUpdate(
            target, new UpsertProgressRequest(Guid.NewGuid(), "scroll:a:0", 1.0, null, ProgressUnit.Book), 0);

        Assert.Equal(target.UpdatedAt, target.ClientUpdatedAt);
        var queuedEarlier = target.UpdatedAt.AddSeconds(-30);
        Assert.True(ProgressClock.IsStale(queuedEarlier, target.ClientUpdatedAt, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void IsNewer_LateFlushedOlderReading_Loses()
    {
        // #942: the guest's offline position reached the server later, but was read earlier.
        var guest = new ReadingProgress { Locator = "g", UpdatedAt = ServerNow, ClientUpdatedAt = ServerNow.AddHours(-2) };
        var account = new ReadingProgress { Locator = "a", UpdatedAt = ServerNow.AddHours(-1), ClientUpdatedAt = ServerNow.AddHours(-1) };

        Assert.False(ProgressClock.IsNewer(guest, account));
        Assert.True(ProgressClock.IsNewer(account, guest));
    }

    [Fact]
    public void IsNewer_OneRowWithoutClientClock_ComparesServerStampsOnly()
    {
        // The guest's client clock says "later", but the legacy account row has no client clock:
        // mixing the two clocks is meaningless, so both are compared on the server stamp.
        var legacy = new ReadingProgress { Locator = "l", UpdatedAt = ServerNow };
        var guest = new ReadingProgress { Locator = "g", UpdatedAt = ServerNow.AddMinutes(-1), ClientUpdatedAt = ServerNow.AddMinutes(2) };

        Assert.False(ProgressClock.IsNewer(guest, legacy));
        Assert.True(ProgressClock.IsNewer(legacy, guest));
    }

    [Fact]
    public void IsNewer_BothLegacy_ComparesServerStamps()
    {
        var newer = new ReadingProgress { Locator = "n", UpdatedAt = ServerNow };
        var older = new ReadingProgress { Locator = "o", UpdatedAt = ServerNow.AddDays(-1) };

        Assert.True(ProgressClock.IsNewer(newer, older));
    }

    [Fact]
    public void IsNewer_Tie_GoesToSecondRow()
    {
        var a = new ReadingProgress { Locator = "a", UpdatedAt = ServerNow, ClientUpdatedAt = ServerNow };
        var b = new ReadingProgress { Locator = "b", UpdatedAt = ServerNow, ClientUpdatedAt = ServerNow };

        Assert.False(ProgressClock.IsNewer(a, b));
    }

    [Fact]
    public void MergeInto_LoserReachedFurther_KeepsHigherChapter()
    {
        var keep = new ReadingProgress { Locator = "k", MaxChapterNumber = 3 };
        ProgressClock.MergeInto(keep, new ReadingProgress { Locator = "d", MaxChapterNumber = 30 });
        Assert.Equal(30, keep.MaxChapterNumber);
    }

    [Fact]
    public void MergeInto_ChapterZeroAgainstNone_KeepsZero()
    {
        // Chapter numbers can start at 0: 0 is a reached chapter, not "none".
        var keep = new ReadingProgress { Locator = "k" };
        ProgressClock.MergeInto(keep, new ReadingProgress { Locator = "d", MaxChapterNumber = 0 });
        Assert.Equal(0, keep.MaxChapterNumber);
    }

    [Fact]
    public void MergeInto_BothNone_StaysNull()
    {
        var keep = new ReadingProgress { Locator = "k" };
        ProgressClock.MergeInto(keep, new ReadingProgress { Locator = "d" });
        Assert.Null(keep.MaxChapterNumber);
    }

    [Fact]
    public void MergeInto_LoserFinished_WinnerUnfinishedStaysUnfinished()
    {
        // The reader cleared the finish later (the winner): the older finish must not come back.
        var keep = new ReadingProgress { Locator = "k", CompletedAt = null };
        ProgressClock.MergeInto(keep, new ReadingProgress { Locator = "d", CompletedAt = ServerNow.AddDays(-1) });
        Assert.Null(keep.CompletedAt);
    }
}
