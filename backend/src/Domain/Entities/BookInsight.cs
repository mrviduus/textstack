namespace Domain.Entities;

/// <summary>
/// A conclusion about a book, written back into the book.
///
/// <para>The reasoning happens somewhere else — Claude, ChatGPT, whatever the reader already keeps
/// their profile and their year of history in. We do not try to be that. What we are is the book, its
/// markup, and the memory of having read it, so the only thing that has to come home is the
/// <b>result</b>: what was worked out, and about which part of the book.</para>
///
/// <para><b>A catalog, not a transcript.</b> A transcript is ordered by time and is useless to come
/// back to — the conclusion you want is in the fortieth message. A book already has a spine, and
/// every other piece of user markup already hangs on it (highlights, bookmarks, progress). So an
/// insight hangs on it too: <see cref="ChapterSlug"/> names the chapter it is about, or is
/// <c>null</c> for the whole book. A study конспект is then not a frozen document but an assembly of
/// these in reading order — run the pass again and it is current.</para>
///
/// <para><b>Keyed by slug, not chapter id.</b> Re-ingestion deletes and recreates every chapter, so
/// the Guids change and anything holding one comes unstuck. The slug is regenerated from the title
/// and survives while the title does. Same lesson as the reading position (ADR-015); the same lesson
/// is why <see cref="Highlight"/> stores a text anchor.</para>
///
/// <para><b>One insight per target.</b> <c>(UserId, book, ChapterSlug)</c> is unique — a save
/// replaces. That is what makes "run it again and the конспект is updated" literally true, and it is
/// also the ceiling that stops one agent pass from burying the book under two hundred notes. It
/// costs history, deliberately: this is a конспект, not a log. <see cref="UpdatedAt"/> carries
/// freshness, and a writer that wants to add rather than replace reads the existing text first.</para>
///
/// <para>Exactly one of <see cref="EditionId"/> (a catalog book) or <see cref="UserBookId"/> (the
/// user's own upload) is set — enforced by a DB CHECK, the same shape as
/// <see cref="BookConversation"/>. Site-scoped (<see cref="ISiteScoped"/>) like the other per-user
/// AI tables. Plain POCO; EF mapping in AppDbContext.Insights.cs.</para>
///
/// <para>Deliberately NOT <see cref="BookConversation"/>: that is a chat container with a rolling
/// summary and a summarized-through watermark, and we decided not to keep the chat. Deliberately not
/// <c>Note</c> either: its API was never wired up and it is hard-bound to an edition.</para>
/// </summary>
public class BookInsight : ISiteScoped
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public Guid SiteId { get; set; }

    /// <summary>The catalog edition this is about — null iff this is about an upload.</summary>
    public Guid? EditionId { get; set; }

    /// <summary>The user's uploaded book this is about — null iff this is about a catalog book.</summary>
    public Guid? UserBookId { get; set; }

    /// <summary>
    /// The chapter this is about, by slug. <c>null</c> means the insight is about the whole book —
    /// which is what a study конспект's overview is.
    /// </summary>
    public string? ChapterSlug { get; set; }

    /// <summary>The conclusion itself, as Markdown.</summary>
    public string Text { get; set; } = "";

    /// <summary>
    /// The question this answers, when there was one. This is the provenance stamp that gives coming
    /// back its meaning — "this is what I was trying to work out" — without storing the conversation
    /// it came from. Null for an unprompted summary.
    /// </summary>
    public string? Question { get; set; }

    /// <summary>Where it came from: <c>"mcp"</c> today; the app itself later.</summary>
    public string Source { get; set; } = "mcp";

    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }

    // Navigation
    public User User { get; set; } = null!;
    public Site Site { get; set; } = null!;
    public Edition? Edition { get; set; }
    public UserBook? UserBook { get; set; }
}
