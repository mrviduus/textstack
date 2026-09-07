namespace Application.ReadingTracking;

/// <summary>
/// What the server does with a logical reading position.
///
/// <para>The position itself is opaque here — the clients own the format, exactly as they own the
/// locator's. The server's whole job is one invariant: <b>a row never holds two positions that
/// disagree.</b> A stale anchor sitting beside a fresh pixel offset is the self-contradicting row
/// that <c>packages/shared/src/reader/resume.ts</c> exists to survive, and it is the shape every
/// resume defect of 2026 has taken. So the position is stored only when it can be believed, and
/// cleared whenever it cannot.</para>
///
/// <para>Mirrors <see cref="LocatorSpace"/> and <see cref="ProgressUnit"/> in shape: a tiny pure
/// decision, one place, tested against the strings the clients actually send.</para>
/// </summary>
public static class ReaderPosition
{
    /// <summary>
    /// Upper bound on the stored JSON, in characters.
    ///
    /// <para>A real position is about 200 bytes: a chapter slug, 30 characters of context either
    /// side of ~64 characters of quoted text, and two integers. 4096 is generous headroom for a
    /// format that grows, and small enough that a client bug — or a caller pasting a chapter into
    /// the field — cannot quietly turn a progress row into a blob. It is the only validation worth
    /// having on an opaque column: anything that inspects the contents would be the server owning a
    /// format it deliberately does not own.</para>
    /// </summary>
    public const int MaxLength = 4096;

    /// <summary>
    /// The value to store, given what the client sent and the locator that was accepted alongside it.
    ///
    /// <list type="number">
    /// <item>No position on the write — <c>null</c>. Not "keep what was there": an old build that
    /// does not know about this column writes the locator and nothing else, and its pixel offset is
    /// then the only true statement on the row. Keeping the previous anchor would leave the row
    /// contradicting itself for as long as that device kept reading.</item>
    /// <item>Accepted locator is not in scroll space — <c>null</c>. A <c>page:</c> write comes from
    /// the PDF viewer, which has no text anchor to give and whose page IS its logical position.
    /// Mark-as-read (<c>{"type":"end"}</c>) has no position at all.</item>
    /// <item>Longer than <see cref="MaxLength"/> — <c>null</c>. The position is dropped; the
    /// locator and percentage are not. Unlike a foreign coordinate space, an oversized payload says
    /// nothing about whether the rest of the snapshot is trustworthy.</item>
    /// <item>Otherwise — store it.</item>
    /// </list>
    ///
    /// <para>Whitespace-only is treated as absent, so a client sending <c>""</c> to mean "clear it"
    /// gets what it asked for rather than a row holding an empty string.</para>
    /// </summary>
    public static string? ToStore(string? positionJson, string? acceptedLocator)
    {
        if (string.IsNullOrWhiteSpace(positionJson)) return null;
        if (positionJson.Length > MaxLength) return null;
        if (!string.Equals(LocatorSpace.Derive(acceptedLocator), LocatorSpace.Scroll, StringComparison.Ordinal))
            return null;
        return positionJson;
    }
}
