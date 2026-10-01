namespace Application.Tools;

/// <summary>
/// How a chapter is named to a model, and through it to a reader.
///
/// Two things were wrong with handing over <c>Chapter.ChapterNumber</c>, and they stacked.
///
/// It is <b>0-based</b> — the parser starts at zero, and every reader-facing surface adds one
/// (the table of contents renders <c>chapterNumber + 1</c>, the reader footer renders
/// <c>index + 1</c>). A tool that passed the raw value made the model say "Chapter 7" about the
/// eighth chapter.
///
/// And it is renumbered by <b>splitting</b>. Long chapters are cut into parts and each part gets
/// its own sequential <c>ChapterNumber</c>, with the book's real number preserved in
/// <c>OriginalChapterNumber</c> and the position in <c>PartNumber</c>/<c>TotalParts</c>. On a split
/// book the number the model received was the chunk's index, not the chapter's.
///
/// A citation is the one thing in an AI answer a reader can check by hand, so it has to be right
/// or absent. This produces the label a person would recognise; the raw ordinal stays out of the
/// payload entirely, because there is nothing a model can correctly do with it.
/// </summary>
public static class ChapterLabel
{
    /// <summary>
    /// A human chapter reference: "Chapter 8", or "Chapter 5 (part 2 of 3)" for a split chapter.
    /// Returns null when there is no number to show, so callers omit the field rather than print
    /// a guess.
    /// </summary>
    public static string? For(
        int? chapterNumber,
        int? originalChapterNumber = null,
        int? partNumber = null,
        int? totalParts = null)
    {
        // The original number is already what the book calls it. The stored ordinal is 0-based and
        // needs the same +1 every reader-facing surface applies.
        var number = originalChapterNumber ?? (chapterNumber is { } n ? n + 1 : null);
        if (number is null) return null;

        if (partNumber is { } part && totalParts is { } total && total > 1)
            return $"Chapter {number} (part {part} of {total})";

        return $"Chapter {number}";
    }
}
