namespace Domain.Utilities;

/// <summary>
/// Language code → English language name, for LLM prompts. A prompt that says "in uk"
/// gets English back from small local models; "in Ukrainian" does not. Mirrors
/// <c>packages/shared/src/languages.ts</c> (<c>englishName</c>) — LanguageNamesTests
/// fails when a code there has no entry here.
/// </summary>
public static class LanguageNames
{
    private static readonly Dictionary<string, string> Names = new(StringComparer.OrdinalIgnoreCase)
    {
        ["en"] = "English",
        ["pt-BR"] = "Portuguese (Brazil)",
        ["ru"] = "Russian",
        ["de"] = "German",
        ["fr"] = "French",
        ["es"] = "Spanish",
        ["pl"] = "Polish",
        ["uk"] = "Ukrainian",
        ["fa"] = "Persian",
        ["af"] = "Afrikaans",
        ["sq"] = "Albanian",
        ["am"] = "Amharic",
        ["ar"] = "Arabic",
        ["hy"] = "Armenian",
        ["az"] = "Azerbaijani",
        ["eu"] = "Basque",
        ["be"] = "Belarusian",
        ["bn"] = "Bengali",
        ["bs"] = "Bosnian",
        ["bg"] = "Bulgarian",
        ["my"] = "Burmese",
        ["ca"] = "Catalan",
        ["zh"] = "Chinese",
        ["zh-TW"] = "Chinese (Traditional)",
        ["hr"] = "Croatian",
        ["cs"] = "Czech",
        ["da"] = "Danish",
        ["nl"] = "Dutch",
        ["eo"] = "Esperanto",
        ["et"] = "Estonian",
        ["fo"] = "Faroese",
        ["tl"] = "Filipino",
        ["fi"] = "Finnish",
        ["gl"] = "Galician",
        ["ka"] = "Georgian",
        ["el"] = "Greek",
        ["gu"] = "Gujarati",
        ["ha"] = "Hausa",
        ["he"] = "Hebrew",
        ["hi"] = "Hindi",
        ["hu"] = "Hungarian",
        ["is"] = "Icelandic",
        ["ig"] = "Igbo",
        ["id"] = "Indonesian",
        ["ga"] = "Irish",
        ["it"] = "Italian",
        ["ja"] = "Japanese",
        ["kn"] = "Kannada",
        ["kk"] = "Kazakh",
        ["km"] = "Khmer",
        ["ko"] = "Korean",
        ["ky"] = "Kyrgyz",
        ["lo"] = "Lao",
        ["la"] = "Latin",
        ["lv"] = "Latvian",
        ["lt"] = "Lithuanian",
        ["lb"] = "Luxembourgish",
        ["mk"] = "Macedonian",
        ["ms"] = "Malay",
        ["ml"] = "Malayalam",
        ["mt"] = "Maltese",
        ["mr"] = "Marathi",
        ["mn"] = "Mongolian",
        ["ne"] = "Nepali",
        ["no"] = "Norwegian",
        ["ps"] = "Pashto",
        ["pt"] = "Portuguese",
        ["pa"] = "Punjabi",
        ["ro"] = "Romanian",
        ["sr"] = "Serbian",
        ["sd"] = "Sindhi",
        ["si"] = "Sinhala",
        ["sk"] = "Slovak",
        ["sl"] = "Slovenian",
        ["sw"] = "Swahili",
        ["sv"] = "Swedish",
        ["tg"] = "Tajik",
        ["ta"] = "Tamil",
        ["te"] = "Telugu",
        ["th"] = "Thai",
        ["tr"] = "Turkish",
        ["ur"] = "Urdu",
        ["uz"] = "Uzbek",
        ["vi"] = "Vietnamese",
        ["cy"] = "Welsh",
        ["xh"] = "Xhosa",
        ["yo"] = "Yoruba",
        ["zu"] = "Zulu",
    };

    /// <summary>
    /// English name for a code ("uk" → "Ukrainian"). A regional code the catalogue lacks
    /// falls back to its base ("en-US" → "English"); an unknown code comes back unchanged.
    /// </summary>
    public static string ToEnglishName(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return code;
        var trimmed = code.Trim();
        if (Names.TryGetValue(trimmed, out var name)) return name;
        var dash = trimmed.IndexOf('-');
        if (dash > 0 && Names.TryGetValue(trimmed[..dash], out var baseName)) return baseName;
        return trimmed;
    }
}
