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

    // The no-op DO UPDATE returns the stored row when the operation id is taken; xmax = 0 only
    // on a row this statement inserted.
    private const string UpsertShare = $"""
        INSERT INTO shared_chapters (id, user_id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language, operation_id, payload_sha256, created_at)
        VALUES (@Id, @UserId, @BookId, @FileId, @ChapterKey, @ChapterTitle, @ChapterText, CAST(@NotesSnapshot AS jsonb), @Language, @OperationId, @PayloadSha256, now())
        ON CONFLICT (user_id, operation_id) DO UPDATE SET operation_id = EXCLUDED.operation_id
        RETURNING {Columns}, xmax = 0 AS inserted
        """;

    public async Task<WriteResult<SharedChapter>> ShareAsync(SharedChapter share, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var (stored, inserted) = (await conn.QueryAsync<SharedChapter, bool, (SharedChapter, bool)>(
            new CommandDefinition(UpsertShare, share, cancellationToken: ct), (row, isNew) => (row, isNew), splitOn: "inserted")).Single();
        return new(
            inserted ? WriteOutcome.Created
            : stored.PayloadSha256 == share.PayloadSha256 ? WriteOutcome.Replayed
            : WriteOutcome.OperationConflict,
            stored);
    }

    private const string SelectShare = $"SELECT {Columns} FROM shared_chapters WHERE user_id = @userId AND id = @id";

    public async Task<SharedChapter?> GetAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<SharedChapter>(new CommandDefinition(SelectShare, new { userId, id }, cancellationToken: ct));
    }

    private const string SelectSharesOfBook = $"""
        SELECT {Columns} FROM shared_chapters
        WHERE user_id = @userId AND book_id = @bookId
        ORDER BY created_at DESC, id DESC
        """;

    public async Task<IReadOnlyList<SharedChapter>> ListForBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = await conn.QueryAsync<SharedChapter>(new CommandDefinition(SelectSharesOfBook, new { userId, bookId }, cancellationToken: ct));
        return rows.AsList();
    }

    // The share FK's ON DELETE SET NULL (shared_chapter_id) unlinks its checkpoints; see migration 0001.
    private const string DeleteShare = "DELETE FROM shared_chapters WHERE user_id = @userId AND id = @id";

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(DeleteShare, new { userId, id }, cancellationToken: ct)) > 0;
    }
}
