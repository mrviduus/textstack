namespace Api.Sites;

/// <summary>
/// Canonical site keys. Single source of truth for site identifiers.
/// </summary>
public static class SiteKeys
{
    public const string General = "general";

    public static readonly HashSet<string> Valid = [General];
}
