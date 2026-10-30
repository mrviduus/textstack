using Application.Discussion;
using Dapper;
using Domain.Discussion;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ICheckpointRepository"/> on <c>textstack_v2</c>. The schema
/// holds one row per <c>(user_id, operation_id)</c> and refuses a checkpoint with all four sections
/// empty (<c>ck_discussion_checkpoints_not_empty</c>). Its share FK checks owner and book only; that
/// the share is of the same chapter and file version is checked by the insert itself (table comment).
/// </summary>
public sealed class CheckpointRepository(V2DataSource dataSource) : ICheckpointRepository
{
    private const string Columns =
        "id, user_id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256, created_at";

    public async Task<DiscussionWriteResult<DiscussionCheckpoint>> AppendAsync(DiscussionCheckpoint checkpoint, CancellationToken ct)
    {
        // Inserts nothing when the named share does not match, or when the operation id is taken;
        // the row under the operation id, or its absence, then tells the two apart. FOR KEY SHARE
        // holds the share until this insert commits: a share delete in flight makes it wait and then
        // find the share gone (a mismatch, not an FK error at commit), and a delete that comes later
        // waits for this row to commit and unlinks it.
        const string insert = $"""
            INSERT INTO discussion_checkpoints (id, user_id, book_id, file_id, chapter_key, shared_chapter_id, topic, reader_thoughts, assistant_suggestions, conclusions, open_questions, language, operation_id, payload_sha256, created_at)
            SELECT @Id, @UserId, @BookId, @FileId, @ChapterKey, @SharedChapterId, @Topic,
                   CAST(@ReaderThoughts AS jsonb), CAST(@AssistantSuggestions AS jsonb), CAST(@Conclusions AS jsonb), CAST(@OpenQuestions AS jsonb),
                   @Language, @OperationId, @PayloadSha256, now()
            WHERE @SharedChapterId IS NULL OR EXISTS (
                SELECT 1 FROM shared_chapters s
                WHERE s.user_id = @UserId AND s.book_id = @BookId AND s.id = @SharedChapterId
                  AND s.chapter_key = @ChapterKey AND s.file_id IS NOT DISTINCT FROM @FileId
                FOR KEY SHARE)
            ON CONFLICT (user_id, operation_id) DO NOTHING
            RETURNING {Columns}
            """;
        const string byOperation = $"SELECT {Columns} FROM discussion_checkpoints WHERE user_id = @UserId AND operation_id = @OperationId";

        await using var conn = await dataSource.OpenConnectionAsync(ct);
        // Two rounds: a row that blocked the insert may be deleted before it is read, and then the
        // second insert goes through. Nothing under the operation id twice is a share mismatch.
        for (var round = 1; ; round++)
        {
            var created = await conn.QuerySingleOrDefaultAsync<DiscussionCheckpoint>(new CommandDefinition(insert, checkpoint, cancellationToken: ct));
            if (created is not null) return new(DiscussionWriteOutcome.Created, created);
            // A retry is answered from the stored row even if its share has been deleted since.
            var stored = await conn.QuerySingleOrDefaultAsync<DiscussionCheckpoint>(new CommandDefinition(byOperation, checkpoint, cancellationToken: ct));
            if (stored is not null)
                return new(stored.PayloadSha256 == checkpoint.PayloadSha256 ? DiscussionWriteOutcome.Replayed : DiscussionWriteOutcome.OperationConflict, stored);
            if (round == 2) return new(DiscussionWriteOutcome.ShareMismatch, null);
        }
    }

    public async Task<CheckpointPage> ListAsync(
        Guid userId, Guid bookId, string? chapterKey, int limit, CheckpointCursor? after, CancellationToken ct)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(limit);
        // Keyset on the (user_id, book_id, created_at, id) index; one row past the page says whether
        // another page exists. The CAST types a null cursor, which Dapper sends untyped.
        const string sql = $"""
            SELECT {Columns} FROM discussion_checkpoints
            WHERE user_id = @userId AND book_id = @bookId
              AND (@chapterKey IS NULL OR chapter_key = @chapterKey)
              AND (CAST(@afterCreatedAt AS timestamptz) IS NULL OR (created_at, id) > (@afterCreatedAt, @afterId))
            ORDER BY created_at, id
            LIMIT @take
            """;
        var args = new { userId, bookId, chapterKey, afterCreatedAt = after?.CreatedAt, afterId = after?.Id, take = (long)limit + 1 };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var rows = (await conn.QueryAsync<DiscussionCheckpoint>(new CommandDefinition(sql, args, cancellationToken: ct))).AsList();
        if (rows.Count <= limit) return new(rows, null);
        rows.RemoveAt(limit);
        var last = rows[^1];
        return new(rows, new(last.CreatedAt, last.Id));
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        const string sql = "DELETE FROM discussion_checkpoints WHERE user_id = @userId AND id = @id";
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, id }, cancellationToken: ct)) > 0;
    }
}
