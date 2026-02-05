using System.Text.RegularExpressions;

namespace Api.Seo;

/// <summary>
/// Builds canonical URLs for sitemaps and SEO purposes.
/// Always produces https URLs without www prefix.
/// </summary>
public static partial class CanonicalUrlBuilder
{
    [GeneratedRegex(@"^www\.", RegexOptions.IgnoreCase)]
    private static partial Regex WwwPrefixRegex();

    /// <summary>
    /// Gets the canonical base URL from a primary domain.
    /// Always https, no www, no trailing slash.
    /// </summary>
    public static string GetCanonicalBase(string primaryDomain)
    {
        if (string.IsNullOrWhiteSpace(primaryDomain))
            throw new ArgumentException("Primary domain cannot be empty", nameof(primaryDomain));

        // Strip protocol if present
        var domain = primaryDomain;
        if (domain.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            domain = domain[8..];
        else if (domain.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            domain = domain[7..];

        // Strip www
        domain = WwwPrefixRegex().Replace(domain, "");

        // Strip trailing slash
        domain = domain.TrimEnd('/');

        return $"https://{domain}";
    }

    /// <summary>
    /// Builds a full canonical URL for sitemap entries.
    /// </summary>
    public static string BuildSitemapUrl(string primaryDomain, string path)
    {
        var baseUrl = GetCanonicalBase(primaryDomain);

        if (string.IsNullOrEmpty(path))
            return baseUrl;

        // Ensure path starts with /
        if (!path.StartsWith('/'))
            path = "/" + path;

        // Ensure trailing slash on path
        if (path.Length > 0 && !path.EndsWith('/'))
            path = path + "/";

        return baseUrl + path;
    }
}
