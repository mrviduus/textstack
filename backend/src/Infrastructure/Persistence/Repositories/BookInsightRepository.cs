using Application.Discussion;
using Dapper;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IBookInsightRepository"/> on <c>textstack_v2</c>; the legacy table
/// keeps its own <c>InsightRepository</c> until M2.4. One row per (user, book, chapter) is the
/// single unique index <c>ix_book_insight_user_id_book_id_chapter_slug</c>, NULLS NOT DISTINCT so the
/// book-level row is one row too; the upserts use it as their conflict target.
/// </summary>
public sealed class BookInsightRepository(AppDataSource dataSource) : IBookInsightRepository
{
    private const string Columns =
        "id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at";

    private const string InsertIntoSlot = """
        INSERT INTO book_insight (id, user_id, book_id, chapter_slug, text, question, source, review_json, created_at, updated_at)
        VALUES (@Id, @UserId, @BookId, @ChapterSlug, @Text, @Question, @Source, CAST(@ReviewJson AS jsonb), now(), now())
        ON CONFLICT (user_id, book_id, chapter_slug)
        """;

    private const string SelectForBook = $"SELECT {Columns} FROM book_insight WHERE user_id = @userId AND book_id = @bookId";

    public Task<IReadOnlyList<BookInsight>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        ListAsync(SelectForBook, new { userId, bookId }, ct);

    private const string UpsertInsight = $"""
        {InsertIntoSlot}
        DO UPDATE SET text = EXCLUDED.text, question = EXCLUDED.question, updated_at = now()
        WHERE book_insight.review_json IS NULL
        RETURNING {Columns}
        """;

    public async Task<BookInsight?> SaveAsync(BookInsight insight, CancellationToken ct)
    {
        // Through here a review would land in a slot nothing may then write.
        if (insight.ReviewJson is not null)
            throw new ArgumentException("A chapter review is not saved through SaveAsync.", nameof(insight));
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<BookInsight>(new CommandDefinition(UpsertInsight, insight, cancellationToken: ct));
    }

    private const string DeleteInsight = "DELETE FROM book_insight WHERE user_id = @userId AND id = @id";

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteInsight, new { userId, id }, cancellationToken: ct)) > 0;
    }

    private async Task<IReadOnlyList<BookInsight>> ListAsync(string select, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<BookInsight>(new CommandDefinition(select, args, cancellationToken: ct))).AsList();
    }
}
