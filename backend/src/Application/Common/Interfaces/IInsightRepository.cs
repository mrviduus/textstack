using Domain.Entities;
using Microsoft.EntityFrameworkCore.Storage;

namespace Application.Common.Interfaces;

/// <summary>
/// <see cref="BookInsight"/> persistence (table <c>book_insight</c>) — the first module off EF Core
/// (ADR-028; rules in docs/01-architecture/data-access.md). A book is named by exactly one of
/// <c>userBookId</c> (an upload) or <c>editionId</c> (a catalog book); both or neither throws.
/// <para>Methods taking an <see cref="IDbContextTransaction"/> run inside the caller's EF transaction,
/// so their writes commit or roll back with the EF writes around them.</para>
/// </summary>
public interface IInsightRepository
{
    /// <summary>One reader's insights on one book, unordered.</summary>
    Task<IReadOnlyList<BookInsight>> ListForBookAsync(Guid userId, Guid? userBookId, Guid? editionId, CancellationToken ct);

    /// <summary>One reader's chapter reviews on one book (rows with <c>ReviewJson</c> and a chapter slug).</summary>
    Task<IReadOnlyList<BookInsight>> ListReviewsForBookAsync(Guid userId, Guid? userBookId, Guid? editionId, CancellationToken ct);

    /// <summary>The reader's insights among <paramref name="ids"/>; others' ids are skipped.</summary>
    Task<IReadOnlyList<BookInsight>> ListByIdsAsync(Guid userId, IReadOnlyCollection<Guid> ids, CancellationToken ct);

    /// <summary>
    /// Insert <paramref name="insight"/>, or replace text + question of the row already in its
    /// (user, book, chapter) slot. Returns the stored row (<c>Id == insight.Id</c> when inserted), or
    /// <c>null</c> when the slot holds a structured review — that is replaced only by
    /// <see cref="SaveReviewAsync"/> (ADR-016 §3).
    /// </summary>
    Task<BookInsight?> SaveAsync(BookInsight insight, CancellationToken ct);

    /// <summary>
    /// Insert <paramref name="insight"/> (a chapter review), or replace review, text and question of
    /// the row already in its slot. Returns the stored row — the existing id when replaced.
    /// </summary>
    Task<BookInsight> SaveReviewAsync(BookInsight insight, IDbContextTransaction tx, CancellationToken ct);

    /// <summary>False when no such insight is the reader's.</summary>
    Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct);

    /// <summary>
    /// System operation (re-ingestion): EVERY reader's chapter insights on one book — the ones whose
    /// slug may have to follow a chapter. Only <c>Id</c>, <c>UserId</c> and <c>ChapterSlug</c> are
    /// loaded: it runs inside the chapter rewrite's transaction, and the text is not needed.
    /// </summary>
    Task<IReadOnlyList<BookInsight>> ListAllReadersChapterInsightsAsync(
        Guid? userBookId, Guid? editionId, IDbContextTransaction tx, CancellationToken ct);

    /// <summary>System operation (re-ingestion): set each insight's chapter slug. Moves may swap slugs.</summary>
    Task MoveChapterSlugsAsync(IReadOnlyList<(Guid Id, string To)> moves, IDbContextTransaction tx, CancellationToken ct);
}
