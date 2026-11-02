using System.Buffers.Text;
using System.Globalization;
using System.Text;
using Contracts.V2;

namespace Application.Sync;

/// <summary>
/// The pull side of S2 (v2-sync-protocol.md "Pull and push"): one keyset-paged feed per aggregate,
/// ordered by <c>(updated_at, id)</c>. The cursor is opaque base64 of one position, and a read starts
/// exactly after it. Inside a pull (<c>hasMore</c>) it is the last row sent; at the end of a pull it is
/// the last row too, or pull time minus <see cref="Overlap"/> when that row is younger: a write that
/// took <c>now()</c> earlier but committed later is still delivered, and the overlap is paid once, not
/// on every poll. Re-delivery is harmless: a pulled row replaces the client's copy.
/// </summary>
public static class ChangeFeed
{
    private const int DefaultLimit = 200;
    private const int MaxLimit = 500;

    // ponytail: a write transaction longer than this (or a database clock ahead of the api's by more)
    // can be missed until its row changes again; a per-user change sequence if that ever happens
    // (PDD "Pull and push").
    public static readonly TimeSpan Overlap = TimeSpan.FromSeconds(30);

    // ponytail: no (user_id, updated_at, id) index on books, reading_state or annotations, so a page
    // scans the user's rows; fine for a library of tens, an index in a V2 migration otherwise (#1047).

    /// <summary>
    /// One page: <paramref name="load"/> reads up to its <c>limit</c> rows after <c>(since, afterId)</c>;
    /// <paramref name="key"/> is a row's <c>(updated_at, id)</c>. Both query values arrive as text: an
    /// empty one is absent (the PDD writes <c>?cursor=&amp;limit=</c>), which an <c>int?</c> parameter
    /// would refuse at binding.
    /// </summary>
    public static async Task<SyncResult> PageAsync<TRow, TDto>(
        string? cursor, string? limit,
        Func<DateTimeOffset, Guid, int, Task<IReadOnlyList<TRow>>> load,
        Func<TRow, (DateTimeOffset UpdatedAt, Guid Id)> key,
        Func<TRow, TDto> toDto,
        DateTimeOffset? now = null)
    {
        if (Limit(limit, out var take) is { } invalid) return invalid;
        if (string.IsNullOrEmpty(cursor)) cursor = null;
        if (!TryReadFrom(cursor, out var after))
            return SyncResult.Invalid("cursor", "Not a cursor this server issued.");

        var rows = await load(after.UpdatedAt, after.Id, take + 1);
        var hasMore = rows.Count > take;
        var page = rows.Take(take).Select(toDto).ToList();
        if (page.Count == 0) return SyncResult.Ok(new ChangeFeedDto<TDto>(page, cursor, false)); // nothing new: the caller keeps its position

        var last = key(rows[page.Count - 1]);
        // At the end of a pull: the last row, or pull time minus the overlap if that is earlier.
        (DateTimeOffset UpdatedAt, Guid Id) settled = ((now ?? DateTimeOffset.UtcNow) - Overlap, Guid.Empty);
        return SyncResult.Ok(new ChangeFeedDto<TDto>(page, Encode(hasMore || last.UpdatedAt < settled.UpdatedAt ? last : settled), hasMore));
    }

    /// <summary>A page size as the query sends it: absent or empty is the default, else 1 to the max; any list shares it.</summary>
    public static SyncResult? Limit(string? limit, out int take)
    {
        take = DefaultLimit;
        return !string.IsNullOrEmpty(limit) && !int.TryParse(limit, NumberStyles.None, CultureInfo.InvariantCulture, out take) || take is < 1 or > MaxLimit
            ? SyncResult.Invalid("limit", $"limit is 1-{MaxLimit}.")
            : null;
    }

    private static bool TryReadFrom(string? cursor, out (DateTimeOffset UpdatedAt, Guid Id) after)
    {
        after = (DateTimeOffset.UnixEpoch, Guid.Empty);
        if (cursor is null) return true;
        try
        {
            var parts = Encoding.UTF8.GetString(Base64Url.DecodeFromChars(cursor)).Split(':');
            if (parts.Length != 2) return false;
            after = (new DateTimeOffset(long.Parse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture), TimeSpan.Zero), Guid.ParseExact(parts[1], "N"));
            return true;
        }
        catch (Exception e) when (e is FormatException or OverflowException or ArgumentOutOfRangeException)
        {
            return false;
        }
    }

    private static string Encode((DateTimeOffset UpdatedAt, Guid Id) at) =>
        Base64Url.EncodeToString(Encoding.UTF8.GetBytes($"{at.UpdatedAt.UtcTicks.ToString(CultureInfo.InvariantCulture)}:{at.Id:N}"));
}
