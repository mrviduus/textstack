using Application.Annotations;
using Application.Common;
using Dapper;
using Domain.Annotations;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IAnnotationRepository"/> on <c>textstack_v2</c>, with the same
/// optimistic concurrency as <see cref="ReadingStateRepository"/>: a write names the revision it read,
/// and the statement itself checks it. The schema holds the rest (database/v2/migrations/0000_baseline.up.sql,
/// "Annotations"): a locator needs a file (<c>ck_annotations_locator_file</c>), and the book and file
/// must be the user's (<c>fk_annotations_books_user_id_book_id</c>, and the deferred
/// <c>fk_annotations_book_files_user_id_book_id_file_id</c>).
/// </summary>
public sealed class AnnotationRepository(V2DataSource dataSource) : IAnnotationRepository
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

    public async Task<Annotation?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(SelectById, new { userId, id }, cancellationToken: ct));
    }

    // ponytail: a page scans the user's annotations (ix_annotations_user_id_book_id); an
    // (user_id, updated_at, id) index if one reader's annotations reach the thousands.
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

    private const string SoftDelete = """
        UPDATE annotations SET deleted_at = now(), updated_at = now(), revision = revision + 1
        WHERE user_id = @userId AND id = @id AND deleted_at IS NULL
        """;

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(SoftDelete, new { userId, id }, cancellationToken: ct)) > 0;
    }
}
