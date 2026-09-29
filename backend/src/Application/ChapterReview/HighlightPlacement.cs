using System.Text.Json;

namespace Application.ChapterReview;

/// <summary>
/// A highlight as placement sees it. <paramref name="ChapterId"/> is <c>ChapterId ?? UserChapterId</c>;
/// a PDF highlight has none and carries its page inside <paramref name="AnchorJson"/>.
/// </summary>
public sealed record HighlightRef(Guid Id, Guid? ChapterId, string? AnchorJson);

/// <summary>
/// Which chapter a highlight belongs to. Reflow highlights say so by id; PDF highlights omit the
/// chapter and store <c>{kind:"pdf",page,…}</c>, so they are placed by page against the chapter's
/// <c>SourceStartPage..SourceEndPage</c>. Spec §6–§7.
/// </summary>
public static class HighlightPlacement
{
    /// <summary>True when the highlight is in <paramref name="target"/>.</summary>
    public static bool IsIn(HighlightRef h, ChapterRef target)
    {
        if (h.ChapterId is { } id) return id == target.Id;
        if (PdfPage(h.AnchorJson) is not { } page || target.StartPage is not { } start) return false;
        return page >= start && page <= (target.EndPage ?? start);
    }

    /// <summary>
    /// The chapter number a highlight sits in, or null when it cannot be placed (no chapter id, no
    /// page, or a page before the first chapter). A PDF page shared by two chapters resolves to the
    /// later one — callers treat the result as "at most", which is the lenient direction.
    /// </summary>
    public static int? ChapterNumberOf(HighlightRef h, IReadOnlyList<ChapterRef> chapters)
    {
        if (h.ChapterId is { } id) return chapters.FirstOrDefault(c => c.Id == id)?.Number;
        if (PdfPage(h.AnchorJson) is not { } page) return null;
        return chapters
            .Where(c => c.StartPage is not null && c.StartPage <= page)
            .OrderBy(c => c.Number)
            .LastOrDefault()?.Number;
    }

    /// <summary>The page of a <c>kind:"pdf"</c> anchor, or null for anything else.</summary>
    public static int? PdfPage(string? anchorJson)
    {
        if (string.IsNullOrWhiteSpace(anchorJson)) return null;
        try
        {
            using var doc = JsonDocument.Parse(anchorJson);
            var root = doc.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("kind", out var kind) && kind.ValueKind == JsonValueKind.String
                && kind.GetString() == "pdf"
                && root.TryGetProperty("page", out var page) && page.ValueKind == JsonValueKind.Number
                && page.TryGetInt32(out var n)
                ? n
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
