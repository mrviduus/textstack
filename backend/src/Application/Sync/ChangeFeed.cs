using System.Buffers.Text;
using System.Globalization;
using System.Text;
using Contracts.V2;

namespace Application.Sync;

/// <summary>
/// The pull side of S2 (v2-sync-protocol.md "Pull and push"): one keyset-paged feed per aggregate,
/// ordered by <c>(updated_at, id)</c>. The cursor is opaque base64 of one of two positions: inside a
/// pull (<c>hasMore</c>), exactly after the last row sent; at its end, the watermark
/// <c>max(updated_at)</c>, which the next pull reads from minus <see cref="Overlap"/>, so a write
/// that took <c>now()</c> earlier but committed later is still delivered. Re-delivery is harmless:
/// a pulled row replaces the client's copy.
/// </summary>
public static class ChangeFeed
{
    public const int DefaultLimit = 200;
    public const int MaxLimit = 500;

    // ponytail: a write transaction longer than this can be missed until its row changes again; a
    // per-user change sequence if that ever happens (PDD "Pull and push").
    public static readonly TimeSpan Overlap = TimeSpan.FromSeconds(30);

    private const char PagePosition = 'p';
    private const char Watermark = 'w';

    /// <summary>
    /// One page: <paramref name="load"/> reads up to its <c>limit</c> rows after <c>(since, afterId)</c>;
    /// <paramref name="key"/> is a row's <c>(updated_at, id)</c>.
    /// </summary>
    public static async Task<SyncResult> PageAsync<TRow, TDto>(
        string? cursor, int? limit,
        Func<DateTimeOffset, Guid, int, Task<IReadOnlyList<TRow>>> load,
        Func<TRow, (DateTimeOffset UpdatedAt, Guid Id)> key,
        Func<TRow, TDto> toDto)
    {
        var take = limit ?? DefaultLimit;
        if (take is < 1 or > MaxLimit)
            return SyncResult.Invalid("limit", $"limit is 1-{MaxLimit}.");
        if (!TryReadFrom(cursor, out var since, out var afterId))
            return SyncResult.Invalid("cursor", "Not a cursor this server issued.");

        var rows = await load(since, afterId, take + 1);
        var hasMore = rows.Count > take;
        var page = rows.Take(take).ToList();
        // Nothing new: the caller keeps its position (none yet: still a full pull next time).
        var next = page.Count == 0 ? cursor
            : hasMore ? Encode(PagePosition, key(page[^1]))
            : Encode(Watermark, (key(page[^1]).UpdatedAt, Guid.Empty));
        return SyncResult.Ok(new ChangeFeedDto<TDto>(page.Select(toDto).ToList(), next, hasMore));
    }

    /// <summary>Where a read starts: the beginning (no cursor), after a page's last row, or a watermark minus the overlap.</summary>
    public static bool TryReadFrom(string? cursor, out DateTimeOffset since, out Guid afterId)
    {
        (since, afterId) = (DateTimeOffset.UnixEpoch, Guid.Empty);
        if (cursor is null) return true;
        try
        {
            var parts = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(cursor)).Split(':');
            var at = new DateTimeOffset(long.Parse(parts[1], CultureInfo.InvariantCulture), TimeSpan.Zero);
            switch (parts[0])
            {
                case [PagePosition] when parts.Length == 3:
                    (since, afterId) = (at, Guid.ParseExact(parts[2], "N"));
                    return true;
                case [Watermark] when parts.Length == 2:
                    since = at - Overlap;
                    return true;
                default:
                    return false;
            }
        }
        catch (Exception e) when (e is FormatException or OverflowException or IndexOutOfRangeException or ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static string Encode(char kind, (DateTimeOffset UpdatedAt, Guid Id) at)
    {
        var text = kind == PagePosition
            ? $"{kind}:{at.UpdatedAt.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{at.Id:N}"
            : $"{kind}:{at.UpdatedAt.UtcTicks.ToString(CultureInfo.InvariantCulture)}";
        return Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));
    }
}
