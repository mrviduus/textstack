using Application.Discussion;
using Dapper;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IInsightRepository"/> on <c>textstack_v2</c>; the legacy table
/// keeps its own <see cref="InsightRepository"/> until M2.4. One row per (user, book, chapter) is the
/// single unique index <c>ix_book_insight_user_id_book_id_chapter_slug</c>, NULLS NOT DISTINCT so the
/// book-level row is one row too; the upserts use it as their conflict target.
/// </summary>
public sealed class V2InsightRepository(V2DataSource dataSource) : IInsightRepository
{
    private const string Columns =
        "id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at";

    // The insert both saves start with; each adds its own DO UPDATE.
    private const string InsertIntoSlot = """
        INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)
        VALUES (@Id, @UserId, @BookId, @ChapterSlug, @Text, @Question, @Source, CAST(@ReviewJson AS jsonb), now(), now())
        ON CONFLICT (user_id, book_id, chapter_slug)
        """;

    public async Task<IReadOnlyList<BookInsight>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = $"SELECT {Columns} FROM book_insight WHERE user_id = @userId AND book_id = @bookId";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<BookInsight>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<IReadOnlyList<BookInsight>> ListReviewsForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = $"""
            SELECT {Columns} FROM book_insight
            WHERE user_id = @userId AND book_id = @bookId AND review_json IS NOT NULL AND chapter_slug IS NOT NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<BookInsight>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<IReadOnlyList<BookInsight>> ListByIdsAsync(Guid userId, IReadOnlyCollection<Guid> ids, CancellationToken ct)
    {
        const string sql = $"SELECT {Columns} FROM book_insight WHERE user_id = @userId AND id = ANY(@ids)";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<BookInsight>(new CommandDefinition(
            sql, new { userId, ids = ids.ToArray() }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<BookInsight?> SaveAsync(BookInsight insight, CancellationToken ct)
    {
        // The WHERE turns "the slot holds a review" into no row updated, so no row returned.
        const string sql = $"""
            {InsertIntoSlot}
            DO UPDATE SET text = EXCLUDED.text, question = EXCLUDED.question, updated_at = now()
            WHERE book_insight.review_json IS NULL
            RETURNING {Columns}
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<BookInsight>(new CommandDefinition(sql, insight, cancellationToken: ct));
    }

    public async Task<BookInsight> SaveReviewAsync(BookInsight insight, CancellationToken ct)
    {
        // A review without its JSON would silently demote the slot to a plain insight, and a review
        // is always of one chapter (ADR-016).
        ArgumentNullException.ThrowIfNull(insight.ReviewJson);
        if (insight.ChapterSlug is null)
            throw new ArgumentException("A chapter review needs a chapter slug.", nameof(insight));
        const string sql = $"""
            {InsertIntoSlot}
            DO UPDATE SET review_json = EXCLUDED.review_json, text = EXCLUDED.text,
                          question = EXCLUDED.question, updated_at = now()
            RETURNING {Columns}
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<BookInsight>(new CommandDefinition(sql, insight, cancellationToken: ct));
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = "DELETE FROM book_insight WHERE user_id = @userId AND id = @id";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct)) > 0;
    }
}
