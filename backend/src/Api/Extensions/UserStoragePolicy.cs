namespace Api.Extensions;

/// <summary>
/// What <c>/storage</c> must never serve: anything under <c>users/</c>, <c>library/</c> or <c>uploads/</c>.
///
/// <para><c>users/{id[..2]}/{userId}/books/{userBookId}/</c> held the old per-upload files (original,
/// cover, assets). Nothing writes there any more: covers go through the owner-checked
/// <c>GET /me/v2/books/{id}/cover</c> (#956), and files left on disk must not be public (#913, ADR-024).
/// <c>/storage</c> keeps serving avatars. nginx carries the same rule (<c>infra/nginx/textstack.conf</c>).</para>
///
/// <para>Compared by non-empty segments, so <c>/storage//users/…</c> cannot slip past: Kestrel does
/// not merge slashes, and the static file provider would still find the file.</para>
/// </summary>
public static class UserStoragePolicy
{
    /// <summary>
    /// Headers for any stored reader file served on this origin (EPUB images include SVG): it must
    /// never run as a page — no scripts, unique origin. Used by <c>/storage</c> and the asset route.
    /// </summary>
    public const string StoredFileCsp =
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

    /// <summary>The headers of every stored reader file served on this origin: <c>/storage</c> and the V2 bytes routes.</summary>
    public static void ApplyStoredFileHeaders(IHeaderDictionary headers)
    {
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = StoredFileCsp;
    }

    public static bool IsBlocked(PathString path)
    {
        // Cheap exit for every non-storage request. "/storage//users" still starts with /storage.
        if (!path.StartsWithSegments("/storage", StringComparison.OrdinalIgnoreCase))
            return false;

        var segments = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 2 || !segments[0].Equals("storage", StringComparison.OrdinalIgnoreCase))
            return false;
        // users/: the old upload folders (#956). library/, uploads/: the V2 library's names, owner-only
        // through /me/v2; #1110 moved those bytes to their own volume, the rule stays so a misplaced file
        // (a symlink, a bind, a write after startup) is never public. Same rule: nginx.
        return segments[1].Equals("users", StringComparison.OrdinalIgnoreCase)
            || segments[1].Equals("library", StringComparison.OrdinalIgnoreCase)
            || segments[1].Equals("uploads", StringComparison.OrdinalIgnoreCase);
    }
}
