namespace TextStack.Extraction.Quality;

/// <summary>
/// A structural defect detected in extracted chapter HTML. These are the
/// recurring failure modes of PDF text extraction — the things a clean EPUB
/// never has.
/// </summary>
public enum ContentQualityIssue
{
    /// <summary>Many one/two-word &lt;p&gt; in a row — paragraph reconstruction failed.</summary>
    FragmentedParagraphs,

    /// <summary>Running headers/footers ("Title | 4") leaked into the body.</summary>
    RunningHeaderInBody,

    /// <summary>Line-wrap hyphens left unmerged ("chal&#x2010; lenges").</summary>
    HyphenationArtifacts,

    /// <summary>Bare page numbers / dividers surviving as their own paragraphs.</summary>
    OrphanPageNumbers,

    /// <summary>Footnote bodies ("1 In this book…") inlined into the flow.</summary>
    SuspectedFootnotes,
}

/// <summary>
/// Deterministic content-quality verdict for one chapter.
/// <see cref="Score"/> is 0-100, higher is cleaner. The caller decides the
/// flag threshold (default 60).
/// </summary>
public sealed record ContentQualityReport(
    int Score,
    IReadOnlyList<ContentQualityIssue> Issues)
{
    /// <summary>A chapter with no analyzable paragraphs — nothing to score against.</summary>
    public static ContentQualityReport Clean { get; } = new(100, []);
}
