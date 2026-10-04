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
    public void ApplyProgressUpdate_NoClientTimestamp_ClearsStoredClientTimestamp()
    {
        var target = new ReadingProgress { Locator = "x", ClientUpdatedAt = ServerNow };

        UserDataEndpoints.ApplyProgressUpdate(
            target, new UpsertProgressRequest(Guid.NewGuid(), "scroll:a:0", 0.5, null, ProgressUnit.Book), 0);

        Assert.Null(target.ClientUpdatedAt);
    }
}
