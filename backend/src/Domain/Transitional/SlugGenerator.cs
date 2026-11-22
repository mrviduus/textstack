namespace Domain.Transitional;

public static class SlugGenerator
{
    /// <summary>
    /// Generate URL-friendly slug from title.
    /// E.g., "The Great Gatsby" -> "the-great-gatsby"
    /// </summary>
    public static string GenerateSlug(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return string.Empty;

        var slug = title.ToLowerInvariant()
            // Map unicode dash/hyphen variants to ASCII "-" BEFORE the
            // letter-or-digit filter strips them — otherwise ranges fuse
            // ("1–15" → "115" instead of "1-15"). Covers en-dash (U+2013),
            // em-dash (U+2014), figure/horizontal/minus/hyphen variants.
            .Replace('‐', '-')  // hyphen
            .Replace('‑', '-')  // non-breaking hyphen
            .Replace('‒', '-')  // figure dash
            .Replace('–', '-')  // en dash
            .Replace('—', '-')  // em dash
            .Replace('―', '-')  // horizontal bar
            .Replace('−', '-')  // minus sign
            .Replace(" ", "-")
            .Replace("'", "")
            .Replace("\"", "")
            .Replace(":", "")
            .Replace(";", "")
            .Replace(".", "")
            .Replace(",", "");

        // Remove non-ascii and collapse multiple dashes
        slug = new string(slug.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
        while (slug.Contains("--"))
            slug = slug.Replace("--", "-");
        slug = slug.Trim('-');

        return slug;
    }

    /// <summary>
    /// Generate SEO-friendly chapter slug from title.
    /// E.g., "Chapter 1" -> "chapter-1", "Letter 4" -> "letter-4"
    /// Falls back to "section-{order+1}" if title is empty/too short.
    /// Includes order prefix to ensure uniqueness within edition.
    /// </summary>
    public static string GenerateChapterSlug(string title, int order)
    {
        var slug = GenerateSlug(title);

        // If slug is empty or too short, use generic name
        if (string.IsNullOrEmpty(slug) || slug.Length < 2)
            slug = $"section-{order + 1}";
        else
            // Prefix with order to ensure uniqueness (e.g., "5-ii" instead of just "ii")
            slug = $"{order + 1}-{slug}";

        return slug;
    }
}
