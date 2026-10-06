using System.Text;
using Domain.Utilities;

namespace Application.Ai;

/// <summary>
/// The Translate feature's system prompt, extracted from
/// <c>Api.Endpoints.TranslationEndpoints</c> so the eval harness exercises the SAME
/// prompt production serves (a copy would drift). User message = the text to
/// translate. Pure string building, no dependencies.
/// </summary>
public static class TranslatePrompt
{
    /// <summary>Part of the answer cache key. Bump on any prompt change that should reach cached answers.</summary>
    public const int Version = 2;

    /// <summary>
    /// Build the translation system prompt. Without genre/sentence we behave like
    /// the legacy engine. With them we bias the model toward the domain-specific
    /// reading and ask for a parenthetical clarifier when the word is genuinely
    /// ambiguous (the README's "увага (механізм у нейромережах)" pattern).
    /// </summary>
    public static string BuildSystemPrompt(string srcLang, string tgtLang, string? genre, string? sentence)
    {
        srcLang = LanguageNames.ToEnglishName(srcLang);
        tgtLang = LanguageNames.ToEnglishName(tgtLang);
        var sb = new StringBuilder();
        sb.Append("You are a translation engine for readers of books and articles. ");
        sb.Append($"Translate from {srcLang} to {tgtLang}. ");

        if (!string.IsNullOrWhiteSpace(genre))
        {
            sb.Append($"Domain hint: {genre.Trim()}. ");
            sb.Append("Prefer the domain-specific meaning over the everyday meaning when the word is ambiguous, ");
            sb.Append("but never force a technical reading on a clearly non-technical context. ");
        }

        if (!string.IsNullOrWhiteSpace(sentence))
        {
            // Quote the sentence and escape any internal double-quotes so the
            // prompt stays parseable for the model.
            var escaped = sentence.Trim().Replace("\"", "\\\"");
            sb.Append($"Sentence context: \"{escaped}\". ");
        }

        sb.Append("Output ONLY the translation. ");

        if (!string.IsNullOrWhiteSpace(genre) || !string.IsNullOrWhiteSpace(sentence))
        {
            sb.Append("If the word has a domain-specific meaning that differs materially ");
            sb.Append("from its everyday meaning, append a SHORT clarifier in ");
            sb.Append($"{tgtLang} parentheses, e.g. \"увага (механізм у нейромережах)\" ");
            sb.Append("or \"опитування (періодичний запит до сервера)\". ");
            sb.Append("Otherwise output just the translation. ");
        }

        sb.Append("No preface, no quotes, no markdown.");
        return sb.ToString();
    }
}
