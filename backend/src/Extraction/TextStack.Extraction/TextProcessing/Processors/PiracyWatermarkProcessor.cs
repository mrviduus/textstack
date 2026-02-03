using System.Text.RegularExpressions;
using TextStack.Extraction.TextProcessing.Abstractions;

namespace TextStack.Extraction.TextProcessing.Processors;

/// <summary>
/// Detects and removes piracy site watermarks from extracted content.
/// Common sites: Royallib.com, Flibusta, Litres (pirated), etc.
/// </summary>
public partial class PiracyWatermarkProcessor : ITextProcessor
{
    public string Name => "PiracyWatermark";
    public int Order => 50; // Run early, before other processing

    // Known piracy domains and patterns
    private static readonly string[] PiracyDomains =
    [
        "royallib.com",
        "royallib.ru",
        "flibusta.is",
        "flibusta.net",
        "flibs.me",
        "lib.rus.ec",
        "litmir.me",
        "litmir.net",
        "coollib.com",
        "coollib.net",
        "loveread.ec",
        "loveread.me",
        "readli.net",
        "bookscafe.net",
        "aldebaran.ru",
        "litres.ru/download", // pirated litres links
        "fb2.top",
        "knigavuhe.org",
        "rulit.me",
        "e-reading.club",
        "e-reading-lib.com"
    ];

    // Russian piracy phrases
    private static readonly string[] RussianPiracyPhrases =
    [
        "Спасибо, что скачали",
        "скачали книгу",
        "бесплатной электронной библиотеке",
        "Все книги автора",
        "книга в других форматах",
        "Приятного чтения",
        "Оцените книгу",
        "Скачать бесплатно",
        "электронная библиотека",
        "Конвертация выполнена",
        "FictionBook Editor",
        "Эта же книга в других форматах"
    ];

    // English piracy phrases
    private static readonly string[] EnglishPiracyPhrases =
    [
        "Downloaded from",
        "Thanks for downloading",
        "free ebook library",
        "pirate library",
        "support the author by purchasing",
        "This ebook was created",
        "Converted by"
    ];

    public string Process(string input, IProcessingContext context)
    {
        if (string.IsNullOrEmpty(input))
            return input;

        // Check if this content looks like a piracy watermark
        if (!IsPiracyWatermark(input))
            return input;

        // Return empty - this chapter should be skipped
        return string.Empty;
    }

    /// <summary>
    /// Checks if entire chapter content is a piracy watermark.
    /// </summary>
    public static bool IsPiracyWatermark(string html)
    {
        if (string.IsNullOrEmpty(html))
            return false;

        // Short content is more likely to be a watermark
        var plainText = StripHtml(html);

        // Very short chapters with piracy indicators
        if (plainText.Length < 500)
        {
            // Check for piracy domains
            foreach (var domain in PiracyDomains)
            {
                if (html.Contains(domain, StringComparison.OrdinalIgnoreCase))
                    return true;
            }

            // Check for Russian piracy phrases
            var russianPhraseCount = RussianPiracyPhrases.Count(phrase =>
                plainText.Contains(phrase, StringComparison.OrdinalIgnoreCase));
            if (russianPhraseCount >= 2)
                return true;

            // Check for English piracy phrases
            var englishPhraseCount = EnglishPiracyPhrases.Count(phrase =>
                plainText.Contains(phrase, StringComparison.OrdinalIgnoreCase));
            if (englishPhraseCount >= 2)
                return true;
        }

        // Check for high Cyrillic content ratio in supposedly English books
        // (watermarks are often in Russian even for English books)
        var cyrillicCount = plainText.Count(c => c >= '\u0400' && c <= '\u04FF');
        var latinCount = plainText.Count(c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

        // If mostly Cyrillic in a short chapter with piracy domain
        if (cyrillicCount > latinCount && plainText.Length < 300)
        {
            foreach (var domain in PiracyDomains)
            {
                if (html.Contains(domain, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
        }

        return false;
    }

    private static string StripHtml(string html)
    {
        return HtmlTagRegex().Replace(html, " ");
    }

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex HtmlTagRegex();
}
