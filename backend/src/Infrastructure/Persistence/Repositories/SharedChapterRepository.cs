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

    public async Task<DiscussionWriteResult<SharedChapter>> ShareAsync(SharedChapter share, CancellationToken ct)
    {
        // A taken operation id inserts nothing, so nothing comes back; the stored row's payload hash
        // then says whether this was a retry or a different write.
        const string insert = $"""
            INSERT INTO shared_chapters (id, user_id, book_id, file_id, chapter_key, chapter_title, chapter_text, notes_snapshot, language, operation_id, payload_sha256, created_at)
            VALUES (@Id, @UserId, @BookId, @FileId, @ChapterKey, @ChapterTitle, @ChapterText, CAST(@NotesSnapshot AS jsonb), @Language, @OperationId, @PayloadSha256, now())
            ON CONFLICT (user_id, operation_id) DO NOTHING
            RETURNING {Columns}
            """;
        // ON CONFLICT waited for the first writer to commit, so its row is visible here.
        const string byOperation = $"SELECT {Columns} FROM shared_chapters WHERE user_id = @UserId AND operation_id = @OperationId";

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        // Nothing inserted and nothing found means the row that blocked the insert was deleted
        // between the two statements: one more round inserts it; a second miss is a broken
        // invariant, not a race.
        for (var round = 1; ; round++)
        {
            var created = await conn.QuerySingleOrDefaultAsync<SharedChapter>(new CommandDefinition(insert, share, cancellationToken: ct));
            if (created is not null) return new(DiscussionWriteOutcome.Created, created);
            var stored = await conn.QuerySingleOrDefaultAsync<SharedChapter>(new CommandDefinition(byOperation, share, cancellationToken: ct));
            if (stored is not null)
                return new(stored.PayloadSha256 == share.PayloadSha256 ? DiscussionWriteOutcome.Replayed : DiscussionWriteOutcome.OperationConflict, stored);
            if (round == 2)
                throw new InvalidOperationException($"Operation {share.OperationId} was taken, then gone, twice.");
        }
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
