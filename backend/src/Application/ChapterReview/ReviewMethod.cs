namespace Application.ChapterReview;

/// <summary>
/// The TextStack review method — the instructions the reader's assistant follows. One file,
/// <c>ReviewMethod.md</c> beside this one, embedded in the assembly and served inside
/// <c>get_chapter_review</c>: changing it is an API deploy, not an MCP rebuild or a manifest change.
/// Every saved review is stamped with <see cref="Version"/>.
/// </summary>
public static class ReviewMethod
{
    /// <summary>Bump whenever <c>ReviewMethod.md</c> changes; <see cref="TextSha256"/> forces it.</summary>
    public const int Version = 2;

    /// <summary>
    /// sha256 of <see cref="Text"/>, pinned beside <see cref="Version"/>. A test compares them, so an
    /// edit to the method that forgets the version bump fails the build.
    /// </summary>
    public const string TextSha256 = "c19109e36ce370f2b6a135dcf742518d463e3d16d33f72f862fcad8d73cd7390";

    private const string ResourceName = "Application.ChapterReview.ReviewMethod.md";

    public static string Text { get; } = Load();

    private static string Load()
    {
        using var stream = typeof(ReviewMethod).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource '{ResourceName}' is missing.");
        using var reader = new StreamReader(stream);
        // Normalized so a CRLF checkout does not change the served text or the pinned hash.
        return reader.ReadToEnd().Replace("\r\n", "\n");
    }
}
