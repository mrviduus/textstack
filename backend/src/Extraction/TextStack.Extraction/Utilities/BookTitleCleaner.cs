using System.Text.RegularExpressions;

namespace TextStack.Extraction.Utilities;

/// <summary>
/// Cleans up book titles read from source-format metadata.
/// </summary>
/// <remarks>
/// Real-world EPUBs (notably O'Reilly Atlas Early Release editions) ship
/// titles like "Designing Data-Intensive Applications (for ${atlas.author_email})".
/// Some retail/Calibre pipelines strip the variable but leave the parens →
/// titles surface as "X (for  )" in the library, which looks broken to users.
///
/// We strip the parenthetical when it is empty, whitespace-only, or matches
/// a known template syntax (${var}, {{var}}, $var, %name). Parentheticals
/// with real content (e.g. "(for beginners)", "(2nd ed.)") are preserved.
/// </remarks>
public static class BookTitleCleaner
{
    // Class for "non-content" chars between `for` and `)` — regular whitespace
    // (\s = \p{Z} + tabs/CR/LF), Unicode format chars (\p{Cf} — covers ZWSP
    // U+200B, ZWJ U+200D, BOM U+FEFF, soft hyphen U+00AD, etc.). EPUB metadata
    // pipelines that strip variables sometimes leave these invisible chars
    // behind, so plain `\s*` misses them and the cleaner returns the title
    // unchanged.
    private const string Empty = @"[\s\p{Cf}]*";

    // Tail "(for ...)" where the inside is empty (incl. invisible chars) or
    // a known template placeholder syntax (${var} / {{var}} / $var / %var).
    private static readonly Regex EmptyForParens = new(
        @"[\s\p{Cf}]*\(" + Empty + @"for\b(?:" + Empty +
        @"(?:\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_][\w.]*|%\w+))?" + Empty + @"\)" + Empty + @"$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Generic empty parens at the tail (e.g. "Title ()" or "Title (   )").
    private static readonly Regex EmptyTailParens = new(
        Empty + @"\(" + Empty + @"\)" + Empty + @"$",
        RegexOptions.Compiled);

    // Standalone template placeholders anywhere in the title.
    private static readonly Regex TemplatePlaceholder = new(
        @"\$\{[^}]*\}|\{\{[^}]*\}\}|\$[A-Za-z_][\w.]*",
        RegexOptions.Compiled);

    // Leading "Microsoft Word - " that Word→PDF (Quartz) exports stamp onto the
    // document title from the source .docx filename.
    private static readonly Regex WordExportPrefix = new(
        @"^\s*microsoft\s+word\s*[-–—]\s*",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Trailing office/PDF file extension ("… FINAL.docx" → "… FINAL").
    private static readonly Regex FileExtensionSuffix = new(
        @"\.(docx?|pdf|rtf|pages|odt)\s*$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Trailing " copy" / " copy 5" duplicate marker (Finder / Save-As artifact),
    // optionally followed by a version-ish date token like "5.3.23".
    private static readonly Regex CopyVersionSuffix = new(
        @"\s+copy(\s+\d+(?:[.\-]\d+)*)?\s*$",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Trailing "(z-library.sk, 1lib.sk, z-lib.sk)" / "[libgen.rs]" — a group whose EVERY
    // comma-separated item is a lowercase domain. Shadow-library watermarks, stamped into
    // the filename and often the PDF title. Lowercase TLD of 2+ letters, and not a code
    // extension, so "(Node.js)", "(ASP.NET)", "(2nd Ed.)", "(Vol. 2)" survive.
    private const string Domain = @"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.(?!(?:js|ts|py|rb|cs|md)\b)[a-z]{2,}";
    private static readonly Regex DomainListTail = new(
        @"\s*[(\[]\s*" + Domain + @"(?:\s*,\s*" + Domain + @")*\s*[)\]]\s*$",
        RegexOptions.Compiled);

    /// <summary>
    /// Returns a cleaned title or the input unchanged. Null/empty pass through.
    /// </summary>
    public static string? Clean(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return title;

        var s = title;

        // Word→PDF (Quartz) titles surface as "Microsoft Word - X.docx copy 5".
        // Strip the export prefix, then the trailing extension, then the "copy"
        // marker — in that order so each rule sees the tail it expects.
        s = WordExportPrefix.Replace(s, string.Empty);
        s = FileExtensionSuffix.Replace(s, string.Empty);
        s = CopyVersionSuffix.Replace(s, string.Empty);
        s = DomainListTail.Replace(s, string.Empty);

        // Strip leftover template placeholders before re-checking parens —
        // catches "X (for ${var})" → "X (for )" → trailing-paren rule.
        s = TemplatePlaceholder.Replace(s, string.Empty);

        // Repeat to handle nested wrappers like "X (for ${a} ${b})" → "X ()".
        for (var i = 0; i < 3; i++)
        {
            var before = s;
            s = EmptyForParens.Replace(s, string.Empty);
            s = EmptyTailParens.Replace(s, string.Empty);
            if (s == before) break;
        }

        return s.Trim();
    }
}
