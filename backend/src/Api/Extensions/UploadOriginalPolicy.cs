namespace Api.Extensions;

/// <summary>
/// "Is this a reader's uploaded book file?" — such a file is never served from <c>/storage</c>.
///
/// <para>An upload's original lives at <c>users/{id[..2]}/{userId}/books/{userBookId}/original.&lt;ext&gt;</c>
/// under the static root, so anyone holding the two ids could download a private book (#913,
/// ADR-024). Its only door is <c>GET /me/books/{id}/file</c>, which checks the owner. The cover and
/// extracted images in the same folder stay public until they get an authenticated route: an
/// <c>&lt;img&gt;</c> cannot send a bearer. nginx carries the same rule (<c>infra/nginx/textstack.conf</c>).</para>
///
/// <para>Matched on the last segment, not a full-path pattern, so extra or doubled slashes cannot
/// slip past it.</para>
/// </summary>
public static class UploadOriginalPolicy
{
    public static bool IsBlocked(PathString path) =>
        path.StartsWithSegments("/storage/users", StringComparison.OrdinalIgnoreCase)
        && Path.GetFileName(path.Value ?? "").StartsWith("original.", StringComparison.OrdinalIgnoreCase);
}
