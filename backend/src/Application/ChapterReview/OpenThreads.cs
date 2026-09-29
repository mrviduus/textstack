using System.Security.Cryptography;
using System.Text;
using Contracts.ChapterReview;

namespace Application.ChapterReview;

/// <summary>A saved review with the chapter it is about, resolved at read time.</summary>
public sealed record PlacedReview(string ChapterSlug, int? ChapterNumber, string ChapterTitle, ChapterReviewDto Review);

/// <summary>
/// Questions earlier chapters left open. Not a table (ADR-016 §5): computed at read time as threads
/// opened in earlier chapters' reviews minus thread ids closed in earlier chapters' reviews.
/// </summary>
public static class OpenThreads
{
    /// <summary>
    /// Threads open when the reader reaches chapter <paramref name="targetNumber"/>: only reviews of
    /// chapters strictly before it count (a later chapter's threads are a spoiler), in reading order.
    /// A review whose slug no longer resolves is skipped; a close naming an unknown id is ignored.
    /// </summary>
    public static IReadOnlyList<OpenThreadDto> Compute(IEnumerable<PlacedReview> reviews, int targetNumber)
    {
        var earlier = reviews
            .Where(r => r.ChapterNumber is { } n && n < targetNumber)
            .OrderBy(r => r.ChapterNumber)
            .ToList();

        var closed = earlier.SelectMany(r => r.Review.ClosedThreadIds).ToHashSet(StringComparer.Ordinal);
        var open = new List<OpenThreadDto>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var r in earlier)
        {
            foreach (var t in r.Review.OpenThreads)
            {
                if (!closed.Contains(t.Id) && seen.Add(t.Id))
                    open.Add(new OpenThreadDto(t.Id, t.Text, r.ChapterTitle));
            }
        }
        return open;
    }

    /// <summary>
    /// <c>"t_" + first 8 hex of sha256(chapterSlug + "|" + normalized text)</c>. Deterministic, so an
    /// identical re-save keeps its ids; an edited thread gets a new one.
    /// </summary>
    public static string ThreadId(string chapterSlug, string text) =>
        "t_" + Sha256Hex(chapterSlug + "|" + Normalize(text))[..8];

    /// <summary>First 16 hex of sha256(normalized prompt) — a question's identity across re-saves.</summary>
    public static string PromptHash(string prompt) => Sha256Hex(Normalize(prompt))[..16];

    /// <summary>Trimmed, whitespace-collapsed, lower-case.</summary>
    public static string Normalize(string s) =>
        string.Join(' ', s.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();

    private static string Sha256Hex(string s) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(s)));
}
