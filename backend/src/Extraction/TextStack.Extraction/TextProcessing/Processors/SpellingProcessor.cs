using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Modernizes archaic spellings to contemporary forms.
/// Loads patterns from embedded spellings.json resource.
/// </summary>
public class SpellingProcessor : ITextProcessor
{
    public string Name => "Spelling";
    public int Order => 400;

    private static readonly List<CompiledPattern> Patterns;

    static SpellingProcessor()
    {
        Patterns = LoadPatterns();
    }

    private static List<CompiledPattern> LoadPatterns()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = "TextStack.Extraction.TextProcessing.Data.spellings.json";

        using var stream = assembly.GetManifestResourceStream(resourceName);
        if (stream == null)
        {
            // Fallback to hardcoded patterns if resource not found
            return GetFallbackPatterns();
        }

        using var reader = new StreamReader(stream);
        var json = reader.ReadToEnd();
        var data = JsonSerializer.Deserialize<SpellingData>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });

        if (data?.Patterns == null)
            return GetFallbackPatterns();

        var result = new List<CompiledPattern>();
        foreach (var p in data.Patterns)
        {
            try
            {
                var pattern = BuildPattern(p);
                if (pattern != null)
                    result.Add(pattern);
            }
            catch
            {
                // Skip invalid patterns
            }
        }

        return result;
    }

    private static CompiledPattern? BuildPattern(SpellingPattern p)
    {
        if (string.IsNullOrEmpty(p.From) || string.IsNullOrEmpty(p.To))
            return null;

        string regexPattern;
        MatchEvaluator replacer;

        if (p.IsLiteral)
        {
            // Literal pattern (like &c.)
            regexPattern = p.From;
            var to = p.To;
            replacer = _ => to;
        }
        else if (!string.IsNullOrEmpty(p.Suffix))
        {
            // Pattern with suffix variations
            // Case-insensitive first letter + rest of word + optional suffix
            var firstChar = p.From[0];
            var rest = p.From.Substring(1);
            regexPattern = $@"\b([{char.ToUpper(firstChar)}{char.ToLower(firstChar)}]){Regex.Escape(rest)}({p.Suffix})?\b";

            var fromFirstLower = char.ToLowerInvariant(firstChar);
            var toFirstLower = char.ToLowerInvariant(p.To[0]);
            var toFirstUpper = char.ToUpperInvariant(p.To[0]);
            var toRest = p.To.Length > 1 ? p.To.Substring(1) : "";

            // Handle case where first letter changes
            if (fromFirstLower == toFirstLower)
            {
                // Same letter, preserve original case
                replacer = m => $"{m.Groups[1].Value}{toRest}{m.Groups[2].Value}";
            }
            else
            {
                // Different letter, map case
                replacer = m =>
                {
                    var origFirst = m.Groups[1].Value;
                    var newFirst = char.IsUpper(origFirst[0]) ? toFirstUpper : toFirstLower;
                    return $"{newFirst}{toRest}{m.Groups[2].Value}";
                };
            }
        }
        else
        {
            // Simple pattern without suffix
            var firstChar = p.From[0];
            var rest = p.From.Substring(1);
            regexPattern = $@"\b([{char.ToUpper(firstChar)}{char.ToLower(firstChar)}]){Regex.Escape(rest)}\b";

            var fromFirstLower = char.ToLowerInvariant(firstChar);
            var toFirstLower = char.ToLowerInvariant(p.To[0]);
            var toFirstUpper = char.ToUpperInvariant(p.To[0]);
            var toRest = p.To.Length > 1 ? p.To.Substring(1) : "";

            // Handle case where first letter changes
            if (fromFirstLower == toFirstLower)
            {
                // Same letter, preserve original case
                replacer = m => $"{m.Groups[1].Value}{toRest}";
            }
            else
            {
                // Different letter, map case
                replacer = m =>
                {
                    var origFirst = m.Groups[1].Value;
                    var newFirst = char.IsUpper(origFirst[0]) ? toFirstUpper : toFirstLower;
                    return $"{newFirst}{toRest}";
                };
            }
        }

        return new CompiledPattern(
            new Regex(regexPattern, RegexOptions.Compiled),
            replacer
        );
    }

    private static List<CompiledPattern> GetFallbackPatterns()
    {
        // Minimal fallback patterns
        return
        [
            new CompiledPattern(new Regex(@"\b&c\.", RegexOptions.Compiled), _ => "etc."),
            new CompiledPattern(new Regex(@"\b([Cc])onnexion(s?)\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}onnection{m.Groups[2].Value}"),
            new CompiledPattern(new Regex(@"\b([Tt])o-day\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}oday"),
            new CompiledPattern(new Regex(@"\b([Tt])o-morrow\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}omorrow"),
            new CompiledPattern(new Regex(@"\b([Tt])o-night\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}onight"),
            new CompiledPattern(new Regex(@"\b([Ss])hew(n|ed|ing|s)?\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}how{m.Groups[2].Value}"),
            new CompiledPattern(new Regex(@"\b([Gg])aol(er|s|ed)?\b", RegexOptions.Compiled), m => $"{(char.IsUpper(m.Groups[1].Value[0]) ? 'J' : 'j')}ail{m.Groups[2].Value}"),
            new CompiledPattern(new Regex(@"\b([Cc])olour(s|ed|ing|ful|less)?\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}olor{m.Groups[2].Value}"),
            new CompiledPattern(new Regex(@"\b([Ff])avour(s|ed|ing|able|ite|ites)?\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}avor{m.Groups[2].Value}"),
            new CompiledPattern(new Regex(@"\b([Hh])onour(s|ed|ing|able|ary)?\b", RegexOptions.Compiled), m => $"{m.Groups[1].Value}onor{m.Groups[2].Value}")
        ];
    }

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        // Only process English text
        if (!context.Language.StartsWith("en", StringComparison.OrdinalIgnoreCase))
            return input;

        var html = input;

        foreach (var pattern in Patterns)
        {
            html = pattern.Regex.Replace(html, pattern.Replacer);
        }

        return html;
    }

    private record CompiledPattern(Regex Regex, MatchEvaluator Replacer);

    private class SpellingData
    {
        public List<SpellingPattern>? Patterns { get; set; }
    }

    private class SpellingPattern
    {
        public string From { get; set; } = "";
        public string To { get; set; } = "";
        public string? Suffix { get; set; }
        public bool IsLiteral { get; set; }
    }
}
