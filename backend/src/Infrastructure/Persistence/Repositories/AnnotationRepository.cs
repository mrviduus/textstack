using Application.Annotations;
using Dapper;
using Domain.Annotations;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="IAnnotationRepository"/> on <c>textstack_v2</c>, with the same
/// optimistic concurrency as <see cref="ReadingStateRepository"/>: a write names the revision it read,
/// and the statement itself checks it. The schema holds the rest (database/v2/migrations/0000_baseline.up.sql,
/// "Annotations"): a locator needs a file (<c>ck_annotations_locator_file</c>). That the file is a
/// version of the same user's book is checked by the writes themselves, ahead of the deferred
/// <c>fk_annotations_book_files_user_id_book_id_file_id</c>.
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
        // Selecting the book, and the file among its versions, by user makes another user's book or an
        // unknown file a loss here; the deferred FK would only fail at commit. ON CONFLICT turns "this
        // id is already stored" into no row returned, whoever stored it.
        const string create = $"""
            INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, revision)
            SELECT @Id, b.user_id, b.id, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, now(), now(), 1
            FROM books b
            WHERE b.user_id = @UserId AND b.id = @BookId
              AND (@FileId IS NULL OR EXISTS (SELECT FROM book_files f WHERE f.user_id = b.user_id AND f.book_id = b.id AND f.id = @FileId))
            ON CONFLICT (id) DO NOTHING
            RETURNING {Columns}
            """;
        // A tombstone takes no write, so a device that missed the delete cannot revive it.
        const string update = $"""
            UPDATE annotations a SET
                file_id = @FileId,
                selected_text = @SelectedText,
                note_text = @NoteText,
                locator = CAST(@Locator AS jsonb),
                color = @Color,
                updated_at = now(),
                revision = a.revision + 1
            WHERE a.user_id = @UserId AND a.id = @Id AND a.revision = @expectedRevision AND a.deleted_at IS NULL
              AND (@FileId IS NULL OR EXISTS (SELECT FROM book_files f WHERE f.user_id = a.user_id AND f.book_id = a.book_id AND f.id = @FileId))
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
