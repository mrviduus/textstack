namespace Application.ReadingTracking;

/// <summary>
/// Last-write-wins for catalog reading progress, comparing the client's clock only with itself.
/// <para>
/// The stale-write guard used to compare the incoming CLIENT timestamp with the row's
/// <c>UpdatedAt</c>, which the server stamps from its own clock. A device running a minute behind
/// had every write it made within that minute of its previous one refused — answered 200 with the
/// old row, so it never knew. Now the client's timestamp is stored beside the server's
/// (<c>ReadingProgress.ClientUpdatedAt</c>) and compared only with that.
/// </para>
/// <para>
/// A client clock can also run AHEAD. Unclamped, one device set a day into the future would store
/// a timestamp that every honest write is "older" than, freezing the row for a day. Clamping to
/// server now + <see cref="MaxClientSkew"/> bounds that freeze to the skew.
/// </para>
/// </summary>
public static class ProgressClock
{
    /// <summary>How far ahead of the server a client timestamp may be before it is clamped.</summary>
    public static readonly TimeSpan MaxClientSkew = TimeSpan.FromMinutes(5);

    /// <summary>The client timestamp, never later than <paramref name="serverNow"/> + skew.</summary>
    public static DateTimeOffset? Clamp(DateTimeOffset? client, DateTimeOffset serverNow)
    {
        var ceiling = serverNow + MaxClientSkew;
        return client > ceiling ? ceiling : client;
    }

    /// <summary>
    /// The client stamp to store for an accepted write: the clamped client timestamp, or the server's
    /// now when the write carries none (mark finished/unread, MCP). Storing null there made the row
    /// "never stale", so a queued write recorded before the mark undid it on arrival. Cost: a device
    /// whose clock runs behind the server has its own writes refused for that lag after such a write.
    /// </summary>
    public static DateTimeOffset Stamp(DateTimeOffset? client, DateTimeOffset serverNow) =>
        Clamp(client, serverNow) ?? serverNow;

    /// <summary>
    /// True when the write is older than (or as old as) the one stored. A write without a
    /// timestamp, and a row that never received one (written before the column existed),
    /// always go through.
    /// </summary>
    public static bool IsStale(DateTimeOffset? incoming, DateTimeOffset? storedClient, DateTimeOffset serverNow)
    {
        var clamped = Clamp(incoming, serverNow);
        return clamped.HasValue && storedClient.HasValue && clamped.Value <= storedClient.Value;
    }
}
