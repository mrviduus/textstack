namespace Domain.Vocabulary;

/// <summary>
/// The vocabulary card key (v2-sync-protocol.md "Payloads → Vocabulary"): one card per
/// <c>(Language(language), Of(word))</c>, <see cref="VocabularyWord.WordKey"/>. The one definition
/// the V2 API, legacy's word save and the M3 ETL all call.
/// </summary>
public static class WordKeys
{
    /// <summary>
    /// <see cref="string.Trim()"/> (Unicode white space), then <see cref="string.ToLowerInvariant"/>:
    /// exactly what legacy <c>POST /me/vocabulary/words</c> stores, so the ETL reproduces every legacy
    /// key and merges no two words legacy kept apart. Invariant, not the language's culture: a Turkish
    /// rule would map "I" to "ı" and split a word legacy keyed as "i" (and .NET's invariant mapping
    /// keeps a dotted "İ" as it is). No case folding either ("Straße" and "STRASSE" stay two keys, as
    /// in legacy) and no Unicode normalization.
    /// </summary>
    public static string Of(string word) => word.Trim().ToLowerInvariant();

    /// <summary>
    /// A language tag as stored: trimmed and lowercased, because BCP 47 tags are case-insensitive and
    /// "en" and "EN" must not be two cards. Legacy stored the tag as sent; the ETL normalises it the same way.
    /// </summary>
    public static string Language(string language) => language.Trim().ToLowerInvariant();
}
