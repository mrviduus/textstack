namespace Domain.Reading;

/// <summary>
/// Where one user is in one book (V2 table <c>reading_state</c>), in one file version
/// (<see cref="FileId"/>): the current position, and the frontier, the furthest point reached, which
/// moving back does not lower. Locators are opaque envelope JSON (ADR-031 "Locator schemes"); CFIs do
/// not sort, so each carries a fraction (0..1) that is compared instead.
/// </summary>
public class ReadingState
{
    /// <summary>Set by the server from the row's key; ignored on write.</summary>
    public Guid BookId { get; set; }

    public Guid FileId { get; set; }
    public string CurrentLocator { get; set; } = "";
    public decimal BookFraction { get; set; }
    public string? FrontierLocator { get; set; }
    public decimal? FrontierFraction { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }

    /// <summary>When the client recorded this state, by its clock.</summary>
    public DateTimeOffset ClientRecordedAt { get; set; }

    /// <summary>Set by the server when it accepts a state; ignored on write.</summary>
    public DateTimeOffset UpdatedAt { get; set; }

    /// <summary>Set by the server: 1 on the first write, +1 on each accepted one; ignored on write.</summary>
    public long Revision { get; set; }

    /// <summary>
    /// Set by the server: the revision the last reset produced, null until one. A stale writer whose
    /// expected revision is below it lost to a reset, not to another device moving on; ignored on write.
    /// </summary>
    public long? ResetRevision { get; set; }

    /// <summary>
    /// The furthest of <paramref name="candidates"/> by fraction, locator and fraction as a pair; a
    /// candidate missing either is skipped, and of equal fractions the first wins. The frontier a write
    /// offers is <c>Furthest((frontier), (position))</c>: a client that sends none, half of one, or one
    /// behind its position never leaves the frontier trailing.
    /// </summary>
    public static (string Locator, decimal Fraction) Furthest(params ReadOnlySpan<(string? Locator, decimal? Fraction)> candidates)
    {
        (string Locator, decimal Fraction)? furthest = null;
        foreach (var (locator, fraction) in candidates)
            if (locator is not null && fraction is { } f && (furthest is null || f > furthest.Value.Fraction))
                furthest = (locator, f);
        return furthest ?? throw new ArgumentException("No candidate has both a locator and a fraction.", nameof(candidates));
    }

    /// <summary>
    /// A guest's state of one book merged with the account's, both taken in files with the same bytes
    /// (v2-sync-protocol.md "Guest → account merge"): the newer <see cref="ClientRecordedAt"/> wins (a
    /// tie: the account's) with its position and its <see cref="CompletedAt"/> as they are; the
    /// frontier is the furthest of both frontiers and the winner's position; the account's
    /// <see cref="ResetRevision"/> is kept (a reset is never lost); the revision passes both. The
    /// caller sets <see cref="BookId"/> and <see cref="FileId"/>.
    /// </summary>
    public static ReadingState Merge(ReadingState guest, ReadingState account)
    {
        var winner = guest.ClientRecordedAt > account.ClientRecordedAt ? guest : account;
        var (frontierLocator, frontierFraction) = Furthest(
            (account.FrontierLocator, account.FrontierFraction), (guest.FrontierLocator, guest.FrontierFraction),
            (winner.CurrentLocator, winner.BookFraction));
        return new ReadingState
        {
            CurrentLocator = winner.CurrentLocator,
            BookFraction = winner.BookFraction,
            FrontierLocator = frontierLocator,
            FrontierFraction = frontierFraction,
            CompletedAt = winner.CompletedAt,
            ClientRecordedAt = winner.ClientRecordedAt,
            Revision = Math.Max(guest.Revision, account.Revision) + 1,
            ResetRevision = account.ResetRevision,
        };
    }
}
