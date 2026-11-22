namespace Application.Reading;

/// <summary>
/// Which coordinate space a reading position is expressed in, and which write is
/// allowed to replace which.
///
/// <para>
/// An uploaded book can be read two ways and they do not share coordinates. The
/// reflow reader stores <c>scroll:&lt;chapterSlug&gt;:&lt;offset&gt;</c>; the
/// Original-layout PDF viewer stores <c>page:&lt;n&gt;</c>. Only one of them is on
/// screen at a time, and only that one has anything true to say about where the
/// reader is.
/// </para>
/// <para>
/// Nothing stopped the other one from writing. A reader who opened a PDF, read to
/// page 16 and closed the reader had <c>page:16</c> replaced by
/// <c>scroll:2-the-mom-test:0</c> — the reflow path's close-flush, built from refs
/// a PDF viewer never feeds. The stored progress fell from 14% to 4% and the book
/// reopened ten pages early. The client is fixed, but installed builds keep doing
/// it until their owners update, and the web reader has the same gap.
/// </para>
///
/// <para><b>Why the declaration is not just the locator's shape.</b>
/// <see cref="ProgressUnit"/> exists because <c>0.14</c> as a chapter fraction and
/// <c>0.14</c> as a book fraction are byte-identical — the server genuinely cannot
/// tell them apart. That is not true here: <c>page:16</c> and <c>scroll:x:0</c>
/// describe themselves, and <see cref="Derive"/> is a pair of prefixes. A field
/// that merely restated the string would carry no information.
/// </para>
/// <para>
/// So <c>LocatorKind</c> means something else: <b>this write came from a client
/// that knows coordinate spaces exist</b>. That is not derivable, and it is the
/// only thing missing.
/// </para>
///
/// <para><b>Why not simply rank the spaces.</b> "A page locator outranks a scroll
/// locator" would fix the reported case and break the one that matters more: a
/// reader whose PDF will not render falls back to reading it as text
/// (<c>forceReflow</c>), and that reader is legitimately in scroll space. Ranking
/// would make their position unsaveable forever. Time cannot arbitrate either —
/// the corrupting write happens on reader close, genuinely after the last good
/// one.
/// </para>
/// </summary>
public static class LocatorSpace
{
    /// <summary>A 1-based page in the original PDF: <c>page:&lt;n&gt;</c>.</summary>
    public const string Page = "page";

    /// <summary>A scroll offset within a chapter: <c>scroll:&lt;slug&gt;:&lt;offset&gt;</c>.</summary>
    public const string Scroll = "scroll";

    /// <summary>
    /// The space a locator is written in, or null if it is neither.
    ///
    /// <para>Mirrored in TypeScript by <c>locatorSpace()</c> in
    /// <c>packages/shared/src/reader/locatorSpace.ts</c>. Change one, change both.</para>
    ///
    /// <para>Deliberately absent: a <c>chapter</c> space. <c>chapter:&lt;slug&gt;</c>
    /// is a BOOKMARK locator and is never written as progress. Adding a value for a
    /// space nothing writes is how a taxonomy starts to rot.</para>
    /// </summary>
    public static string? Derive(string? locator)
    {
        if (string.IsNullOrWhiteSpace(locator)) return null;
        var s = locator.Trim();
        if (s.StartsWith("page:", StringComparison.Ordinal)) return Page;
        if (s.StartsWith("scroll:", StringComparison.Ordinal)) return Scroll;
        return null;
    }

    /// <summary>
    /// Whether an incoming write may replace the stored position.
    ///
    /// <list type="number">
    /// <item>Nothing stored, or stored in an unrecognised form — accept. There is
    /// nothing to protect.</item>
    /// <item>Incoming locator is null — refuse. "I do not know where the reader is"
    /// is not "erase where the reader was", and the web client can produce exactly
    /// that request.</item>
    /// <item>Same space — accept, declared or not. Every build already installed
    /// writes scroll-over-scroll for EPUBs and must keep working.</item>
    /// <item>Different space, and the declaration AGREES with the locator — accept.
    /// This is the read-as-text fallback, and any deliberate move between spaces.
    /// Agreement rather than mere presence: the field is an assertion the payload
    /// has to corroborate, not a token that waves a write through.</item>
    /// <item>Different space with no declaration, or one that disagrees — refuse.</item>
    /// </list>
    ///
    /// <para>A refusal drops the WHOLE write, unlike <see cref="ProgressUnit"/>,
    /// which saves the position and discards only the number. The difference is
    /// deliberate: there, one field of an otherwise trustworthy snapshot is
    /// ambiguous. Here the entire snapshot came from the wrong coordinate space, so
    /// the percentage derived from it is no more trustworthy than the locator —
    /// 4% was as wrong as <c>scroll:2-the-mom-test:0</c>.</para>
    /// </summary>
    public static bool MayReplace(string? storedLocator, string? incomingLocator, string? declaredKind)
    {
        var stored = Derive(storedLocator);
        if (stored is null) return true;

        var incoming = Derive(incomingLocator);
        if (incoming is null) return false;

        if (string.Equals(stored, incoming, StringComparison.OrdinalIgnoreCase)) return true;

        return string.Equals(declaredKind, incoming, StringComparison.OrdinalIgnoreCase);
    }
}
