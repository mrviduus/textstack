namespace Application.ChapterReview;

/// <summary>
/// Splits a long chapter into parts a model can take in one tool result. Cuts at a paragraph break,
/// else a sentence end, else hard at the limit; the parts concatenate back to the input exactly, so
/// nothing is silently dropped. Spec §10.
/// </summary>
public static class ChapterParts
{
    /// <summary>
    /// Matches <c>get_my_chapter</c>'s cap. ChatGPT's real tool-output ceiling is unknown — this is
    /// the knob (owner decision 2026-09-29: keep 40k).
    /// </summary>
    public const int DefaultMaxChars = 40_000;

    private static readonly string[] SentenceEnds = [". ", "? ", "! ", ".\n", "?\n", "!\n"];

    public static IReadOnlyList<string> Split(string text, int maxChars = DefaultMaxChars)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(maxChars, 1);
        if (text.Length <= maxChars) return [text];

        var parts = new List<string>();
        var start = 0;
        while (text.Length - start > maxChars)
        {
            var cut = CutPoint(text, start, maxChars);
            parts.Add(text[start..cut]);
            start = cut;
        }
        parts.Add(text[start..]);
        return parts;
    }

    // End index (exclusive) of the part starting at `start`: just after the last separator that fits.
    private static int CutPoint(string text, int start, int maxChars)
    {
        var window = text.AsSpan(start, maxChars);

        var para = window.LastIndexOf("\n\n");
        if (para > 0) return start + para + 2;

        var best = -1;
        foreach (var end in SentenceEnds)
        {
            var i = window.LastIndexOf(end);
            if (i > 0) best = Math.Max(best, i + end.Length);
        }
        return best > 0 ? start + best : start + maxChars;
    }
}
