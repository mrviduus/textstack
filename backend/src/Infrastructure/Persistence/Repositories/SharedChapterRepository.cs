using Application.Common;
using Application.Discussion;
using Dapper;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ISharedChapterRepository"/> on <c>textstack_v2</c>. The rules it
/// leans on live in the schema (database/v2/migrations/0000_baseline.up.sql, "Discussion"): one row
/// per <c>(user_id, operation_id)</c>, and a share can only name a book of its own user and a file of
/// that book (the latter FK deferred, so it is checked when the statement's transaction commits).
/// </summary>
public sealed class SharedChapterRepository(V2DataSource dataSource) : ISharedChapterRepository
{
    private const string Columns =
        "id, user_id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language, operation_id, payload_sha256, created_at";

    public async Task<WriteResult<SharedChapter>> ShareAsync(SharedChapter share, CancellationToken ct)
    {
        // The no-op DO UPDATE returns the stored row when the operation id is taken; xmax = 0 only
        // on a row this statement inserted.
        const string upsert = $"""
            INSERT INTO shared_chapters (id, user_id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language, operation_id, payload_sha256, created_at)
            VALUES (@Id, @UserId, @BookId, @FileId, @ChapterKey, @ChapterTitle, @ChapterText, CAST(@NotesSnapshot AS jsonb), @Language, @OperationId, @PayloadSha256, now())
            ON CONFLICT (user_id, operation_id) DO UPDATE SET operation_id = EXCLUDED.operation_id
            RETURNING {Columns}, xmax = 0 AS inserted
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var (stored, inserted) = (await conn.QueryAsync<SharedChapter, bool, (SharedChapter, bool)>(
            new CommandDefinition(upsert, share, cancellationToken: ct), (row, isNew) => (row, isNew), splitOn: "inserted")).Single();
        return new(
            inserted ? WriteOutcome.Created
            : stored.PayloadSha256 == share.PayloadSha256 ? WriteOutcome.Replayed
            : WriteOutcome.OperationConflict,
            stored);
    }

    public async Task<SharedChapter?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = $"SELECT {Columns} FROM shared_chapters WHERE user_id = @userId AND id = @id";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SharedChapter>(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct));
    }

    public async Task<IReadOnlyList<SharedChapter>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = $"""
            SELECT {Columns} FROM shared_chapters
            WHERE user_id = @userId AND book_id = @bookId
            ORDER BY created_at DESC, id DESC
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<SharedChapter>(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct));
        return rows.AsList();
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        // Waits for any append that is linking this share (it holds FOR KEY SHARE) to commit, so
        // the unlink below sees that checkpoint too.
        const string lockShare = "SELECT 1 FROM shared_chapters WHERE user_id = @userId AND id = @id FOR UPDATE";
        // The checkpoints keep their text and lose only the link; without this the share's delete
        // fails at commit on fk_discussion_checkpoints_shared_chapters_shared_chapter_id.
        const string unlink = """
            UPDATE discussion_checkpoints SET shared_chapter_id = NULL
            WHERE user_id = @userId AND shared_chapter_id = @id
            """;
        const string delete = "DELETE FROM shared_chapters WHERE user_id = @userId AND id = @id";

        var args = new { userId, id };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(lockShare, args, tx, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition(unlink, args, tx, cancellationToken: ct));
        var deleted = await conn.ExecuteAsync(new CommandDefinition(delete, args, tx, cancellationToken: ct)) > 0;
        await tx.CommitAsync(ct);
        return deleted;
    }
}
