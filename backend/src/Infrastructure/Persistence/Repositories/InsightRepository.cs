using Application.Common.Interfaces;
using Dapper;
using Domain.Entities;
using Microsoft.EntityFrameworkCore.Storage;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IInsightRepository"/>. The table's rules live in the schema
/// (database/migrations/0000_baseline.up.sql, "book_insight"): the edition/user-book XOR CHECK, and one
/// row per (user, book, chapter) — two partial unique indexes, NULLS NOT DISTINCT so the book-level row
/// (chapter_slug NULL) is protected too. The upserts below use those indexes as their conflict target.
/// </summary>
public sealed class InsightRepository(NpgsqlDataSource dataSource) : IInsightRepository
{
    private const string Columns =
        "id, user_id, site_id, edition_id, user_book_id, chapter_slug, text, question, source, review_json, created_at, updated_at";

    private const string Insert = $"""
        INSERT INTO book_insight (id, user_id, site_id, edition_id, user_book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)
        VALUES (@Id, @UserId, @SiteId, @EditionId, @UserBookId, @ChapterSlug, @Text, @Question, @Source, CAST(@ReviewJson AS jsonb), @CreatedAt, @UpdatedAt)

        """;

    public async Task<IReadOnlyList<BookInsight>> ListForBookAsync(
        Guid userId, Guid? userBookId, Guid? editionId, CancellationToken ct)
    {
        // One of the two ids is null, and "= NULL" matches nothing: the predicate is the other one.
        const string sql = $"""
            SELECT {Columns} FROM book_insight
            WHERE user_id = @userId AND (user_book_id = @userBookId OR edition_id = @editionId)
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<BookInsight>(new CommandDefinition(
            sql, new { userId, userBookId, editionId }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<IReadOnlyList<BookInsight>> ListByIdsAsync(
        Guid userId, IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        if (ids.Count == 0) return [];
        const string sql = $"SELECT {Columns} FROM book_insight WHERE user_id = @userId AND id = ANY(@ids)";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<BookInsight>(new CommandDefinition(
            sql, new { userId, ids = ids.ToArray() }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<BookInsight?> SaveAsync(BookInsight insight, CancellationToken ct)
    {
        // The WHERE turns "the slot holds a review" into no row updated, so no row returned.
        const string update = $"""
            DO UPDATE SET text = EXCLUDED.text, question = EXCLUDED.question, updated_at = EXCLUDED.updated_at
            WHERE book_insight.review_json IS NULL
            RETURNING {Columns}
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<BookInsight>(new CommandDefinition(
            Insert + OnConflict(insight) + update, insight, cancellationToken: ct));
    }

    public async Task<BookInsight> SaveReviewAsync(BookInsight insight, IDbContextTransaction tx, CancellationToken ct)
    {
        const string update = $"""
            DO UPDATE SET review_json = EXCLUDED.review_json, text = EXCLUDED.text,
                          question = EXCLUDED.question, updated_at = EXCLUDED.updated_at
            RETURNING {Columns}
            """;
        var t = tx.GetDbTransaction();
        return await t.Connection!.QuerySingleAsync<BookInsight>(new CommandDefinition(
            Insert + OnConflict(insight) + update, insight, t, cancellationToken: ct));
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = "DELETE FROM book_insight WHERE id = @id AND user_id = @userId";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { id, userId }, cancellationToken: ct)) > 0;
    }

    public async Task<IReadOnlyList<BookInsight>> ListAllReadersChapterInsightsAsync(
        Guid? userBookId, Guid? editionId, IDbContextTransaction tx, CancellationToken ct)
    {
        const string sql = $"""
            SELECT {Columns} FROM book_insight
            WHERE (user_book_id = @userBookId OR edition_id = @editionId) AND chapter_slug IS NOT NULL
            """;
        var t = tx.GetDbTransaction();
        var rows = await t.Connection!.QueryAsync<BookInsight>(new CommandDefinition(
            sql, new { userBookId, editionId }, t, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task MoveChapterSlugsAsync(
        IReadOnlyList<(Guid Id, string To)> moves, IDbContextTransaction tx, CancellationToken ct)
    {
        if (moves.Count == 0) return;
        // Park first: the unique key is checked per row, and one insight may take another's old slug.
        const string sql = """
            UPDATE book_insight SET chapter_slug = '~' || replace(id::text, '-', '') WHERE id = ANY(@ids);
            UPDATE book_insight b SET chapter_slug = m.slug
            FROM unnest(@ids, @slugs) AS m(id, slug) WHERE b.id = m.id;
            """;
        var t = tx.GetDbTransaction();
        await t.Connection!.ExecuteAsync(new CommandDefinition(sql, new
        {
            ids = moves.Select(m => m.Id).ToArray(),
            slugs = moves.Select(m => m.To).ToArray(),
        }, t, cancellationToken: ct));
    }

    /// <summary>The unique index of the insight's book kind — a closed choice between two constants.</summary>
    private static string OnConflict(BookInsight i) => i.UserBookId is not null
        ? "ON CONFLICT (user_id, user_book_id, chapter_slug) WHERE user_book_id IS NOT NULL\n"
        : "ON CONFLICT (user_id, edition_id, chapter_slug) WHERE edition_id IS NOT NULL\n";
}
