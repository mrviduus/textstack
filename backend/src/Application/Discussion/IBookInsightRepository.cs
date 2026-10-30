using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The V2 insights (table <c>book_insight</c> on <c>textstack_v2</c>; ADR-016, ADR-031): one row per
/// user, book and chapter, the book-level row (<c>ChapterSlug</c> null) included. It replaces the
/// legacy <c>Application.Common.Interfaces.IInsightRepository</c> at M2.4 (plan §6, "re-point"): that
/// port keeps serving the legacy table until its callers move, and is deleted then; a different name,
/// so the files bridging the two can import both. Every method is scoped to <c>userId</c>
/// (docs/01-architecture/data-access.md rule 7).
/// <para>No transaction parameter yet: the legacy review save composes with the review questions in
/// one transaction; on V2 that composition is M2.4's use case and adds <c>NpgsqlTransaction? tx</c>
/// (#1067).</para>
/// <para>Input validation (JSON shape, hash format, text lengths, enum values) is the API's job: a caller
/// bug surfaces from the repository as the schema's <c>PostgresException</c> (data-access.md rule 8).</para>
/// </summary>
public interface IBookInsightRepository
{
    /// <summary>The user's insights on one book, unordered.</summary>
    Task<IReadOnlyList<BookInsight>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>The user's chapter reviews on one book (rows with <c>ReviewJson</c> and a chapter slug).</summary>
    Task<IReadOnlyList<BookInsight>> ListReviewsForBookAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>The user's insights among <paramref name="ids"/>; others' ids are skipped.</summary>
    Task<IReadOnlyList<BookInsight>> ListByIdsAsync(Guid userId, IReadOnlyCollection<Guid> ids, CancellationToken ct);

    /// <summary>
    /// Inserts <paramref name="insight"/>, or replaces text and question of the row already in its
    /// (user, book, chapter) slot. Returns the stored row (<c>Id == insight.Id</c> when inserted), or
    /// null when the slot holds a structured review: only <see cref="SaveReviewAsync"/> replaces that
    /// (ADR-016 §3).
    /// </summary>
    Task<BookInsight?> SaveAsync(BookInsight insight, CancellationToken ct);

    /// <summary>
    /// Inserts <paramref name="insight"/> (a chapter review), or replaces review, text and question of
    /// the row already in its slot. Returns the stored row: the existing id when replaced. Throws
    /// <see cref="ArgumentException"/> when <c>ReviewJson</c> or <c>ChapterSlug</c> is null.
    /// </summary>
    Task<BookInsight> SaveReviewAsync(BookInsight insight, CancellationToken ct);

    /// <summary>False when not the user's.</summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}
