using TextStack.Search.Abstractions;
using TextStack.Search.Contracts;

namespace TextStack.Search.Providers.PostgresFts;

/// <summary>
/// PostgreSQL ts_headline highlighter.
/// Note: This implementation provides SQL building helpers.
/// Actual highlighting is done via ts_headline in SQL queries.
/// </summary>
public sealed class PostgresHighlighter : IHighlighter
{
    private readonly HighlightOptions _options;

    public PostgresHighlighter(HighlightOptions? options = null)
    {
        _options = options ?? HighlightOptions.Default;
    }

    /// <summary>
    /// In-memory highlighting fallback.
    /// For PostgreSQL, prefer using BuildTsHeadlineSql in the search query.
    /// </summary>
    public IReadOnlyList<Highlight> GetHighlights(
        string content,
        string query,
        string field = "content",
        int maxFragments = 3,
        int fragmentSize = 150)
    {
        if (string.IsNullOrWhiteSpace(content) || string.IsNullOrWhiteSpace(query))
            return [];

        // Simple in-memory fallback: find query terms and extract surrounding context
        var fragments = ExtractFragments(content, query, maxFragments, fragmentSize);

        if (fragments.Count == 0)
            return [];

        return [Highlight.Create(field, fragments.ToArray())];
    }

    /// <summary>
    /// Builds ts_headline SQL expression for use in SELECT clause.
    /// </summary>
    public static string BuildTsHeadlineSql(
        string ftsConfigParam,
        string contentColumn,
        string tsQueryParam,
        HighlightOptions? options = null)
    {
        var opts = options ?? HighlightOptions.Default;
        return $"ts_headline({ftsConfigParam}, {contentColumn}, {tsQueryParam}, '{opts.ToOptionsString()}')";
    }

    /// <summary>
    /// Parses ts_headline result into Highlight fragments.
    /// </summary>
    public static Highlight ParseTsHeadlineResult(string? headline, string field, string delimiter = " ... ")
    {
        if (string.IsNullOrWhiteSpace(headline))
            return Highlight.Create(field);

        var fragments = headline
            .Split(delimiter, StringSplitOptions.RemoveEmptyEntries)
            .Select(f => f.Trim())
            .Where(f => !string.IsNullOrEmpty(f))
            .ToArray();

        return Highlight.Create(field, fragments);
    }

    private List<string> ExtractFragments(string content, string query, int maxFragments, int fragmentSize)
    {
        var fragments = new List<string>();
        var terms = query.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var lowerContent = content.ToLowerInvariant();

        foreach (var term in terms)
        {
            if (fragments.Count >= maxFragments)
                break;

            var index = lowerContent.IndexOf(term, StringComparison.Ordinal);
            if (index < 0)
                continue;

            var start = Math.Max(0, index - fragmentSize / 2);
            var end = Math.Min(content.Length, index + term.Length + fragmentSize / 2);

            var fragment = content[start..end];

            // Add ellipsis if truncated
            if (start > 0)
                fragment = "..." + fragment;
            if (end < content.Length)
                fragment += "...";

            // Wrap matched term with highlight tags
            var termInFragment = content.Substring(index, term.Length);
            fragment = fragment.Replace(termInFragment, $"{_options.StartSel}{termInFragment}{_options.StopSel}");

            fragments.Add(fragment);
        }

        return fragments;
    }
}
