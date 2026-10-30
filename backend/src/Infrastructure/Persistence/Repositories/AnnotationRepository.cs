using Application.Annotations;
using Dapper;
using Domain.Annotations;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IAnnotationRepository"/> on <c>textstack_v2</c>, with the same
/// optimistic concurrency as <see cref="ReadingStateRepository"/>: a write names the revision it read,
/// and the statement itself checks it. The schema holds the rest (database/v2/migrations/0000_baseline.up.sql,
/// "Annotations"): a locator needs a file (<c>ck_annotations_locator_file</c>), and the file must be a
/// version of the same user's book (<c>fk_annotations_book_files_user_id_book_id_file_id</c>, deferred).
/// </summary>
public sealed class AnnotationRepository(V2DataSource dataSource) : IAnnotationRepository
{
    private const string Columns =
        "id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, deleted_at, revision";

    public async Task<IReadOnlyList<Annotation>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = $"""
            SELECT {Columns} FROM annotations
            WHERE user_id = @userId AND book_id = @bookId AND deleted_at IS NULL
            ORDER BY created_at, id
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<Annotation>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct))).AsList();
    }

    public async Task<Annotation?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = $"SELECT {Columns} FROM annotations WHERE user_id = @userId AND id = @id";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct));
    }

    public async Task<SaveAnnotationResult> SaveAsync(
        Guid userId, Annotation annotation, long? expectedRevision, CancellationToken ct)
    {
        if (annotation.UserId != userId)
            throw new ArgumentException("The annotation must belong to the user writing it.", nameof(annotation));
        // Selecting the book by user makes another user's book a loss, not an FK error. ON CONFLICT
        // turns "this id is already stored" into no row returned, whoever stored it.
        const string create = $"""
            INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, revision)
            SELECT @Id, b.user_id, b.id, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, now(), now(), 1
            FROM books b
            WHERE b.user_id = @UserId AND b.id = @BookId
            ON CONFLICT (id) DO NOTHING
            RETURNING {Columns}
            """;
        // A tombstone takes no write, so a device that missed the delete cannot revive it.
        const string update = $"""
            UPDATE annotations SET
                file_id = @FileId,
                selected_text = @SelectedText,
                note_text = @NoteText,
                locator = CAST(@Locator AS jsonb),
                color = @Color,
                updated_at = now(),
                revision = revision + 1
            WHERE user_id = @UserId AND id = @Id AND revision = @expectedRevision AND deleted_at IS NULL
            RETURNING {Columns}
            """;

        var args = new
        {
            annotation.Id,
            annotation.UserId,
            annotation.BookId,
            annotation.FileId,
            annotation.SelectedText,
            annotation.NoteText,
            annotation.Locator,
            annotation.Color,
            expectedRevision,
        };
        await using (var conn = await dataSource.OpenConnectionAsync(ct))
        {
            var written = await conn.QuerySingleOrDefaultAsync<Annotation>(new CommandDefinition(
                expectedRevision is null ? create : update, args, cancellationToken: ct));
            if (written is not null) return new SaveAnnotationResult(true, written);
        }
        return new SaveAnnotationResult(false, await GetAsync(userId, annotation.Id, ct));
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = """
            UPDATE annotations SET deleted_at = now(), updated_at = now(), revision = revision + 1
            WHERE user_id = @userId AND id = @id AND deleted_at IS NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct)) > 0;
    }
}
