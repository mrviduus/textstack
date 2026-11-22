namespace Application.Reading;

/// <summary>
/// Whether a reading percentage a client sent means what this server thinks it means.
///
/// <para>
/// <c>ReadingProgress.Percent</c> and <c>UserBook.ProgressPercent</c> are BOOK-wide
/// fractions. For a long time nothing said so: mobile wrote the fraction of the
/// current chapter, web wrote the fraction of the book, and both landed in the same
/// column. A reader saw 10% on the resume card and 32% on the row below it, for the
/// same book, without scrolling.
/// </para>
/// <para>
/// The clients were fixed. The problem is that old ones keep running — an Android
/// build already installed goes on writing chapter fractions until its owner updates,
/// and there is no way to tell those writes apart from correct ones by looking at
/// the number. So the unit travels with the value: a client that knows the unit says
/// so, and a percentage that arrives without one is not trusted enough to store.
/// </para>
/// <para>
/// Untrusted writes are not rejected. The locator, the chapter and the timestamp are
/// still the reader's real position and are saved as usual — only the number is left
/// as it was. A stale client keeps working; it just stops corrupting the column.
/// </para>
/// </summary>
public static class ProgressUnit
{
    /// <summary>Fraction of the whole book, 0..1. The only unit this server stores.</summary>
    public const string Book = "book";

    /// <summary>True when the caller declared the unit this server stores.</summary>
    public static bool IsTrusted(string? percentUnit) =>
        string.Equals(percentUnit, Book, StringComparison.OrdinalIgnoreCase);
}
