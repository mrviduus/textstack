namespace TextStack.Extraction.Toc;

/// <summary>
/// Represents a table of contents entry with hierarchical structure.
/// </summary>
public record TocEntry(
    string Title,
    int ChapterNumber,
    string? Anchor,          // #heading-id
    int Level,               // 1=h1, 2=h2, 3=h3
    List<TocEntry>? Children
);
