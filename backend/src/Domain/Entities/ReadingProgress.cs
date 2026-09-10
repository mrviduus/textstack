namespace Domain.Entities;

public class ReadingProgress : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }
    public Guid EditionId { get; set; }
    public Guid ChapterId { get; set; }
    /// <summary>
    /// Opaque to the server — the clients own the format. Written as
    /// <c>scroll:&lt;chapterSlug&gt;:&lt;pixelOffset&gt;</c> by the readers,
    /// <c>page:&lt;N&gt;</c> by the PDF original view, and
    /// <c>{"type":"end"}</c> / <c>{"type":"start"}</c> by mark-as-read.
    /// </summary>
    public required string Locator { get; set; }

    /// <summary>
    /// Progress across the WHOLE BOOK, 0..1 — not within the current chapter.
    /// <para>
    /// This column had no declared unit for most of its life, and the two clients
    /// picked different ones: mobile sent a chapter fraction, web sent a book
    /// fraction, and the server stored whichever arrived. A chapter fraction
    /// reaches 1.0 at the bottom of <em>every</em> chapter, which is why a book
    /// being actively read could report "100% complete" and disappear from
    /// Continue Reading. Book-wide is the canonical unit here and on
    /// <see cref="UserBook.ProgressPercent"/>; compute it with the shared
    /// <c>computeBookProgress</c> rather than passing scroll position through.
    /// </para>
    /// </summary>
    public double? Percent { get; set; }

    /// <summary>
    /// The reader's position as a LOGICAL position in the text — a chapter slug,
    /// a text anchor (prefix/exact/suffix, the same shape
    /// <see cref="Highlight.AnchorJson"/> stores) and a character offset hint.
    /// Opaque to the server; the clients own the format.
    /// <para>
    /// <see cref="Locator"/> is a pixel offset, and a pixel offset stops being
    /// true the moment the text reflows — a font size change, a rotation, a
    /// different screen, a re-parsed book. ADR-007 decided in January 2026 that
    /// the position is a logical position in the text and listed <c>scrollY</c>
    /// among the things explicitly not used; the implementation went the other
    /// way four months later and has been patched sixteen times since. This is
    /// the column that lets it be right, added alongside rather than instead of
    /// the locator so already-installed builds keep working unchanged.
    /// </para>
    /// <para>
    /// INVARIANT: a row never holds two positions that disagree. A write that
    /// carries no position NULLs this, and so does a write whose accepted
    /// locator is not in scroll space. A stale anchor beside a fresh pixel is
    /// exactly the self-contradicting row <c>resume.ts</c> was written for.
    /// </para>
    /// </summary>
    public string? PositionJson { get; set; }

    /// <summary>
    /// High-water mark: the furthest chapter ordinal (<see cref="Chapter.ChapterNumber"/>) the user
    /// has ever reached in this edition, so flipping back to an earlier chapter never loses how far
    /// they got. Null on legacy rows → callers fall back to the current chapter (self-heals on the
    /// next progress save).
    /// <para>
    /// CURRENTLY WRITE-ONLY. Its reader was the RAG spoiler gate, deleted 2026-09-10 with the rest of
    /// the retrieval spine. Kept deliberately rather than dropped: it is one int, it keeps
    /// accumulating correctly, and the planned <c>get_book_progress</c> MCP tool needs exactly this —
    /// "how far has this reader actually got" is the question an outside assistant must be able to
    /// ask before it can avoid spoiling a book. Dropping it would mean re-deriving a history we are
    /// already recording.
    /// </para>
    /// </summary>
    public int? MaxChapterNumber { get; set; }

    /// <summary>
    /// Set once <see cref="Percent"/> crosses <c>0.99</c>, or by an explicit
    /// mark-as-finished; cleared by mark-as-unfinished. The presence of this is
    /// the answer to "is it finished?".
    /// <para>
    /// Editions had no completion field at all, so four different places each
    /// answered the question with their own inequality against a percentage —
    /// 0.95 in the shelf service, 0.95 in the web library filter, 1.0 on the web
    /// cards, 1.0 in the mobile action sheet — and "mark as read" had to fake it
    /// by writing a percent of exactly 1. Mirrors
    /// <see cref="UserBook.CompletedAt"/>, which uploads have always had.
    /// </para>
    /// </summary>
    public DateTimeOffset? CompletedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition Edition { get; set; } = null!;
    public Chapter Chapter { get; set; } = null!;
}
