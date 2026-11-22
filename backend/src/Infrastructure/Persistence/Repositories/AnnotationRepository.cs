using Application.Annotations;
using Application.Common;
using Dapper;
using Domain.Annotations;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IAnnotationRepository"/> on <c>textstack_v2</c>, with the same
/// optimistic concurrency as <see cref="ReadingStateRepository"/>: a write names the revision it read,
/// and the statement itself checks it. The schema holds the rest (database/migrations/0000_baseline.up.sql,
/// "Annotations"): a locator needs a file (<c>ck_annotations_locator_file</c>), and the book and file
/// must be the user's (<c>fk_annotations_books_user_id_book_id</c>, and the deferred
/// <c>fk_annotations_book_files_user_id_book_id_file_id</c>).
/// </summary>
public sealed class AnnotationRepository(AppDataSource dataSource) : IAnnotationRepository
{
    // The insert's column list is this one minus deleted_at; the two must agree.
    private const string Columns =
        "id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, deleted_at, revision";
    private const string SelectById = $"SELECT {Columns} FROM annotations WHERE user_id = @userId AND id = @id";

    private const string SelectLiveOfBook = $"""
        SELECT {Columns} FROM annotations
        WHERE user_id = @userId AND book_id = @bookId AND deleted_at IS NULL
        ORDER BY created_at, id
        """;

    public async Task<IReadOnlyList<Annotation>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<Annotation>(new CommandDefinition(SelectLiveOfBook, new { userId, bookId }, cancellationToken: ct))).AsList();
    }

    // Two fixed statements (newest/oldest), every value a parameter. The chapter is the current file's row for the
    // locator's chapterKey; a PDF anchor gets kind: pdf as the legacy anchor had it; an epub-cfi one (the V2 reader's)
    // its quote context. A removed book's highlights stay listed, under the title it had (legacy's #982).
    private const string ListAllFrom = """
        FROM annotations a
        JOIN books b ON b.user_id = a.user_id AND b.id = a.book_id
        """;

    private const string ListAllWhere = """
        WHERE a.user_id = @userId AND a.deleted_at IS NULL
          AND (@color::text IS NULL OR a.color = @color)
          AND (@search::text IS NULL OR strpos(lower(a.selected_text), lower(@search)) > 0
               OR strpos(lower(coalesce(a.note_text, '')), lower(@search)) > 0)
        """;

    private const string ListAllSelect = $"""
        SELECT count(*) OVER ()::int AS Total, a.id AS Id, a.selected_text AS SelectedText,
            (CASE WHEN a.locator->>'scheme' = 'epub-cfi' THEN jsonb_build_object(
                      'prefix', coalesce(a.locator->>'prefix', ''), 'exact', a.selected_text, 'suffix', coalesce(a.locator->>'suffix', ''))
                  WHEN jsonb_typeof(a.locator->'value') IS DISTINCT FROM 'object' THEN jsonb_build_object()
                  WHEN a.locator->>'scheme' = 'pdf-page' THEN (a.locator->'value') || jsonb_build_object('v', 1, 'kind', 'pdf')
                  ELSE a.locator->'value' END)::text AS AnchorJson,
            a.color AS Color, a.note_text AS NoteText, a.created_at AS CreatedAt, a.book_id AS BookId, b.title AS BookTitle,
            b.removed_at IS NOT NULL AS BookRemoved,
            c.id AS ChapterId, c.title AS ChapterTitle, c.chapter_key AS ChapterKey
        {ListAllFrom}
        LEFT JOIN LATERAL (
            SELECT bc.id, bc.title, bc.chapter_key FROM book_files f
            JOIN book_chapters bc ON bc.user_id = f.user_id AND bc.file_id = f.id AND bc.chapter_key = a.locator->'value'->>'chapterKey'
            WHERE f.user_id = a.user_id AND f.book_id = a.book_id AND f.is_current
            LIMIT 1
        ) c ON true
        {ListAllWhere}
        """;

    private const string ListAllNewest = ListAllSelect + " ORDER BY a.created_at DESC, a.id DESC LIMIT @limit OFFSET @offset";
    private const string ListAllOldest = ListAllSelect + " ORDER BY a.created_at, a.id LIMIT @limit OFFSET @offset";

    public async Task<AnnotationPage> ListAllAsync(Guid userId, string? search, string? color, bool oldestFirst, int limit, int offset, CancellationToken ct)
    {
        var args = new { userId, search = string.IsNullOrEmpty(search) ? null : search, color = string.IsNullOrEmpty(color) ? null : color, limit, offset };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<ListRow>(new CommandDefinition(oldestFirst ? ListAllOldest : ListAllNewest, args, cancellationToken: ct))).AsList();
        // A page past the end has no row to carry the total: count it alone.
        var total = rows.Count > 0 ? rows[0].Total
            : offset == 0 ? 0 : await conn.ExecuteScalarAsync<int>(new CommandDefinition($"SELECT count(*)::int {ListAllFrom} {ListAllWhere}", args, cancellationToken: ct));
        return new(total, rows.Select(r => new AnnotationListItem(r.Id, r.SelectedText, r.AnchorJson, r.Color, r.NoteText, r.CreatedAt,
            r.BookId, r.BookTitle, r.BookRemoved, r.ChapterId, r.ChapterTitle, r.ChapterKey)).ToList());
    }

    private sealed record ListRow(int Total, Guid Id, string SelectedText, string AnchorJson, string Color, string? NoteText,
        DateTimeOffset CreatedAt, Guid BookId, string BookTitle, bool BookRemoved, Guid? ChapterId, string? ChapterTitle, string? ChapterKey);

    public async Task<Annotation?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(SelectById, new { userId, id }, cancellationToken: ct));
    }

    private const string SelectChanged = $"""
        SELECT {Columns} FROM annotations
        WHERE user_id = @userId AND (updated_at, id) > (@since, @afterId)
        ORDER BY updated_at, id
        LIMIT @limit
        """;

    public async Task<IReadOnlyList<Annotation>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<Annotation>(new CommandDefinition(SelectChanged, new { userId, since, afterId, limit }, cancellationToken: ct))).AsList();
    }

    private const string InsertAnnotation = $"""
        INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, revision)
        VALUES (@Id, @UserId, @BookId, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, now(), now(), 1)
        ON CONFLICT (id) DO NOTHING
        RETURNING {Columns}
        """;

    private const string UpdateGuarded = $"""
        UPDATE annotations SET
            file_id = @FileId,
            selected_text = @SelectedText,
            note_text = @NoteText,
            locator = CAST(@Locator AS jsonb),
            color = @Color,
            updated_at = now(),
            revision = revision + 1
        WHERE user_id = @UserId AND id = @Id AND book_id = @BookId AND revision = @expectedRevision AND deleted_at IS NULL
        RETURNING {Columns}
        """;

    public async Task<RevisionedWrite<Annotation>> SaveAsync(
        Guid userId, Annotation annotation, long? expectedRevision, CancellationToken ct)
    {
        var args = new DynamicParameters(annotation);
        args.Add("UserId", userId);
        args.Add("expectedRevision", expectedRevision);
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var written = await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(
            expectedRevision is null ? InsertAnnotation : UpdateGuarded, args, cancellationToken: ct));
        return written is not null
            ? new RevisionedWrite<Annotation>(true, written)
            : new RevisionedWrite<Annotation>(false, await conn.QuerySingleOrDefaultAsync<Annotation>(
                new CommandDefinition(SelectById, new { userId, id = annotation.Id }, cancellationToken: ct)));
    }

    private const string SoftDelete = $"""
        UPDATE annotations SET deleted_at = now(), updated_at = now(), revision = revision + 1
        WHERE user_id = @userId AND id = @id AND deleted_at IS NULL
        RETURNING {Columns}
        """;

    public async Task<Annotation?> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        var args = new { userId, id };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        // Already a tombstone: the re-read is its own statement, so it sees a delete that won concurrently.
        return await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(SoftDelete, args, cancellationToken: ct))
            ?? await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(SelectById, args, cancellationToken: ct));
    }
}
