namespace Application.Vocabulary;

/// <summary>
/// The server's <c>wordKey</c> (v2-sync-protocol.md "Payloads → Vocabulary"): the one function the API
/// and the M3 ETL compute it with. A card is keyed by <c>(language, wordKey)</c>, so "Run" and "run"
/// in one language are one card and the same spelling in two languages is two.
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
}
