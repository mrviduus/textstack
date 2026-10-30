using Domain.Discussion;

namespace Application.Discussion;

/// <summary>
/// The V2 insights (table <c>book_insight</c> on <c>textstack_v2</c>; ADR-016, ADR-031): one row per
/// user, book and chapter, the book-level row (<c>ChapterSlug</c> null) included. The V2 port of
/// <c>Application.Common.Interfaces.IInsightRepository</c>, which keeps serving the legacy table until
/// its callers move (M2.4) and is deleted then. Every method is scoped to <c>userId</c>
/// (docs/01-architecture/data-access.md rule 7).
/// <para>No transaction parameter yet: the legacy review save composes with the review questions in
/// one transaction; on V2 that composition is M2.4's use case and adds <c>NpgsqlTransaction? tx</c>
/// (#1067).</para>
/// </summary>
public interface IInsightRepository
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
    /// the row already in its slot. Returns the stored row: the existing id when replaced.
    /// </summary>
    Task<BookInsight> SaveReviewAsync(BookInsight insight, CancellationToken ct);

    /// <summary>False when not the user's.</summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);
}
