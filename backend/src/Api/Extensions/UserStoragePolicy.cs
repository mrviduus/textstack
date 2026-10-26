namespace Api.Extensions;

/// <summary>
/// What of a reader's upload folder <c>/storage</c> may serve: only its cover.
///
/// <para>An upload lives at <c>users/{id[..2]}/{userId}/books/{userBookId}/</c> under the static root:
/// <c>original.&lt;ext&gt;</c>, <c>cover.&lt;ext&gt;</c> and <c>assets/{id}.&lt;ext&gt;</c>. Both ids leave
/// the API, so anyone holding them could download a private book (#913, ADR-024). The original's door
/// is <c>GET /me/books/{id}/file</c> and the images' is <c>GET /me/books/{id}/assets/{assetId}</c>, both
/// owner-checked. The cover stays public until it has an authenticated route: clients load it as an
/// <c>&lt;img&gt;</c>, which cannot send a bearer. An allowlist, so a file added to the folder later is
/// private by default. nginx carries the same rule (<c>infra/nginx/textstack.conf</c>).</para>
///
/// <para>Compared by non-empty segments, so <c>/storage//users/…</c> cannot slip past: Kestrel does
/// not merge slashes, and the static file provider would still find the file.</para>
/// </summary>
public static class UserStoragePolicy
{
    public static bool IsBlocked(PathString path)
    {
        var segments = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 2
            || !segments[0].Equals("storage", StringComparison.OrdinalIgnoreCase)
            || !segments[1].Equals("users", StringComparison.OrdinalIgnoreCase))
            return false;

        // users/{shard}/{userId}/books/{bookId}/cover.<ext> — nothing else under users/.
        var isCover = segments.Length == 7
            && segments[4].Equals("books", StringComparison.OrdinalIgnoreCase)
            && segments[6].StartsWith("cover.", StringComparison.OrdinalIgnoreCase);
        return !isCover;
    }
}
