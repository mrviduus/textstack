using System.Text.RegularExpressions;

namespace Application.Ai;

/// <summary>
/// The lexical book-tool signals a passage can carry (AI-039). A self-contained passage matches
/// <see cref="None"/> — the common case — so the run offers no tools and the model physically cannot
/// over-call; a passage that genuinely references a numbered chapter or the reader's own highlights
/// matches the corresponding flag(s), and only the matching tool(s) get offered.
/// </summary>
[Flags]
public enum BookToolSignal
{
    None = 0,
    ChapterNumber = 1,
    UserHighlights = 2,
}

/// <summary>
/// Shared deterministic detector for the book-tool lexical signals (AI-039). Generalizes the same
/// insight as the Explain pre-router (AI-033): gpt-4.1-nano can't hold both directions of the tool
/// decision at once, so the LEXICAL part of "does this passage even reference a tool-worthy signal?"
/// moves into code, while the model only decides the (now near-trivial) remainder. Pure; unit-tested
/// over the golden set. Compiled regexes, not [GeneratedRegex] (repo ARM64 SIGILL caveat).
/// </summary>
public static class BookToolTriggers
{
    // "Chapter 5", "chapter 11" — a numbered chapter reference.
    private static readonly Regex ChapterRef =
        new(@"\bchapters?\s+\d+\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // "my highlights", "I highlighted/marked/saved", "my notes".
    private static readonly Regex HighlightsRef = new(
        @"\bmy\s+(saved\s+)?(highlights?|notes?)\b|\bI\s+(highlighted|marked|saved|noted)\b",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// ORs together every lexical signal the <paramref name="text"/> matches. Returns
    /// <see cref="BookToolSignal.None"/> when the text carries no tool-worthy wording.
    /// </summary>
    public static BookToolSignal Detect(string text)
    {
        var signal = BookToolSignal.None;
        if (ChapterRef.IsMatch(text))
            signal |= BookToolSignal.ChapterNumber;
        if (HighlightsRef.IsMatch(text))
            signal |= BookToolSignal.UserHighlights;
        return signal;
    }
}
