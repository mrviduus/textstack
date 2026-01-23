using System.Text;
using System.Text.RegularExpressions;
using TextStack.Search.Abstractions;
using TextStack.Search.Enums;

namespace TextStack.Search.Providers.PostgresFts;

public sealed partial class TsQueryBuilder : IQueryBuilder
{
    // PostgreSQL tsquery special characters that need escaping
    private static readonly char[] SpecialChars = ['&', '|', '!', '(', ')', ':', '*', '<', '>'];

    public string BuildQuery(string userQuery, SearchLanguage language)
    {
        if (string.IsNullOrWhiteSpace(userQuery))
            return string.Empty;

        var normalized = NormalizeQuery(userQuery);
        if (string.IsNullOrEmpty(normalized))
            return string.Empty;

        var tokens = TokenizeQuery(normalized);
        if (tokens.Count == 0)
            return string.Empty;

        // Join tokens with AND logic (&), add prefix matching (:*) for partial words
        var escaped = tokens
            .Select(EscapeToken)
            .Where(t => !string.IsNullOrEmpty(t))
            .Select(t => t + ":*");
        return string.Join(" & ", escaped);
    }

    public string BuildPrefixQuery(string prefix)
    {
        if (string.IsNullOrWhiteSpace(prefix))
            return string.Empty;

        var normalized = NormalizeQuery(prefix);
        if (string.IsNullOrEmpty(normalized))
            return string.Empty;

        var tokens = TokenizeQuery(normalized);
        if (tokens.Count == 0)
            return string.Empty;

        // Escape and filter empty tokens
        var escapedTokens = tokens
            .Select(EscapeToken)
            .Where(t => !string.IsNullOrEmpty(t))
            .ToList();

        if (escapedTokens.Count == 0)
            return string.Empty;

        // Last token gets prefix matching (:*), others are exact
        var result = new StringBuilder();
        for (var i = 0; i < escapedTokens.Count; i++)
        {
            if (i > 0) result.Append(" & ");

            result.Append(escapedTokens[i]);

            // Add prefix operator to last token
            if (i == escapedTokens.Count - 1)
                result.Append(":*");
        }

        return result.ToString();
    }

    public string GetLanguageConfig(SearchLanguage language) => language switch
    {
        SearchLanguage.En => "english",
        SearchLanguage.Uk => "simple",  // Ukrainian uses 'simple' (no stemming)
        SearchLanguage.Auto => "simple",
        _ => "simple"
    };

    private static string NormalizeQuery(string query)
    {
        // Lowercase and trim
        var result = query.ToLowerInvariant().Trim();

        // Remove multiple spaces
        result = MultipleSpacesRegex().Replace(result, " ");

        return result;
    }

    private static List<string> TokenizeQuery(string query)
    {
        // Split by whitespace and filter empty
        return query
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length > 0)
            .ToList();
    }

    private static string EscapeToken(string token)
    {
        var sb = new StringBuilder(token.Length);

        foreach (var c in token)
        {
            // Skip special characters entirely
            if (SpecialChars.Contains(c))
                continue;

            sb.Append(c);
        }

        var result = sb.ToString();

        // If token became empty after escaping, return empty
        return string.IsNullOrWhiteSpace(result) ? string.Empty : result;
    }

    [GeneratedRegex(@"\s+")]
    private static partial Regex MultipleSpacesRegex();
}
