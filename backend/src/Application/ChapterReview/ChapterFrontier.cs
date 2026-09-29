namespace Application.ChapterReview;

/// <summary>A chapter as the review code sees it. <paramref name="Number"/> is an ordering key only.</summary>
public sealed record ChapterRef(
    Guid Id, string? Slug, int Number, string Title, int? StartPage = null, int? EndPage = null);

/// <summary>
/// Where the reader stands in one book. Catalog books fill the first three fields
/// (<c>ReadingProgress</c>); uploads fill the last four (<c>UserBook.Progress*</c>).
/// </summary>
public sealed record ProgressSnapshot(
    DateTimeOffset? CompletedAt,
    int? MaxChapterNumber = null,
    Guid? ChapterId = null,
    double? Percent = null,
    string? ChapterSlug = null,
    string? Locator = null,
    bool IsUpload = false);

/// <summary>
/// The spoiler rule for chapter review: the highest <c>chapter_number</c> the reader has reached.
/// A review of any chapter beyond it is refused. Spec §7.
/// </summary>
public static class ChapterFrontier
{
    /// <summary>
    /// Max allowed chapter number, or null when nothing is reached (every chapter refused).
    /// <paramref name="maxReviewedNumber"/> is the highest chapter this reader already has a review
    /// of — for an upload it is a floor, so re-reading chapter 2 does not lock them out of
    /// re-running chapter 7 (uploads keep no high-water mark; owner decision 2026-09-29).
    /// </summary>
    public static int? Resolve(
        ProgressSnapshot? progress, IReadOnlyList<ChapterRef> chapters, int? maxReviewedNumber)
    {
        if (chapters.Count == 0) return null;
        var ordered = chapters.OrderBy(c => c.Number).ToList();

        var reached = progress is null ? null
            : progress.IsUpload ? ResolveUpload(progress, ordered)
            : ResolveCatalog(progress, ordered);

        // Catalog progress keeps its own monotonic MaxChapterNumber; only uploads need the rescue.
        if (progress?.IsUpload == true && maxReviewedNumber is { } reviewed)
            reached = reached is { } r ? Math.Max(r, reviewed) : reviewed;

        return reached;
    }

    private static int? ResolveCatalog(ProgressSnapshot p, List<ChapterRef> ordered)
    {
        if (p.CompletedAt is not null) return ordered[^1].Number;
        if (p.MaxChapterNumber is { } max) return max;
        return ordered.FirstOrDefault(c => c.Id == p.ChapterId)?.Number;
    }

    private static int? ResolveUpload(ProgressSnapshot p, List<ChapterRef> ordered)
    {
        if (p.CompletedAt is not null || p.Percent is >= 0.99) return ordered[^1].Number;

        // PDF in Original layout: the position is a page, not a chapter.
        if (TryPage(p.Locator, out var page))
        {
            var ranged = ordered.Where(c => c.StartPage is not null).ToList();
            if (ranged.Count > 0)
                // Greatest start ≤ page. A page before the first chapter (front matter) reaches none.
                return ranged.LastOrDefault(c => c.StartPage <= page)?.Number;

            if (p.Percent is not { } pct || pct <= 0) return null;
            var index = Math.Clamp((int)Math.Ceiling(pct * ordered.Count), 1, ordered.Count);
            return ordered[index - 1].Number;
        }

        if (p.ChapterSlug is { } slug)
            return ordered.FirstOrDefault(c => c.Slug == slug)?.Number;

        return null;
    }

    /// <summary>Parses a PDF locator <c>page:N</c>.</summary>
    public static bool TryPage(string? locator, out int page)
    {
        page = 0;
        return locator is not null
            && locator.StartsWith("page:", StringComparison.Ordinal)
            && int.TryParse(locator.AsSpan(5), out page);
    }
}
