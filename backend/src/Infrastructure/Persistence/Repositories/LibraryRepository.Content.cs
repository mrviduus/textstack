using Application.Library;
using Dapper;
using Domain.Library;

namespace Infrastructure.Persistence.Repositories;

// The bytes the server holds (M2.6): attach under the quota, "stop syncing", the cover, the keys account delete and the orphan sweep read.
public sealed partial class LibraryRepository
{
    // One user's attaches run one at a time, so N uploads that each fit cannot together pass the limit.
    // An advisory lock, not FOR UPDATE on users: every V2 insert's FK check takes KEY SHARE on the
    // users row, and FOR UPDATE would block all of the user's writes for the whole attach.
    // Then the book row, as a replacement or a removal takes it. The reads after it are statements of
    // their own, so each sees what the locks waited for.
    private const string LockQuotaAndReadTarget = $"""
        SELECT pg_advisory_xact_lock(hashtextextended('library-quota:' || @userId::text, 0));
        {LockBook};
        SELECT {FileColumns} FROM book_files WHERE user_id = @userId AND book_id = @bookId AND is_current;
        {SelectFile};
        {SumStored};
        """;

    private const string SumStored = "SELECT COALESCE(sum(byte_size), 0)::bigint FROM book_files WHERE user_id = @userId AND server_storage_key IS NOT NULL";

    // user_id here is defence in depth: the locked reads above already proved the file is the user's.
    private const string SetStorageKey = $"""
        WITH f AS (
            UPDATE book_files SET server_storage_key = @storageKey, content_removed_at = NULL
            WHERE user_id = @userId AND book_id = @bookId AND id = @fileId
            RETURNING {FileColumns}
        ), b AS ({TouchBook})
        SELECT {FileColumns} FROM f
        """;

    public async Task<ContentAttachment> AttachContentAsync(
        Guid userId, Guid bookId, Guid fileId, string storageKey, long limitBytes, Action placeBytes, CancellationToken ct)
    {
        var args = new { userId, bookId, fileId, storageKey };
        await using var tx = await dataSource.BeginAsync(ct);
        var conn = tx.Connection;
        Book? book;
        BookFile? current, file;
        long used;
        await using (var reads = await conn.QueryMultipleAsync(new CommandDefinition(LockQuotaAndReadTarget, args, tx.Transaction, cancellationToken: ct)))
        {
            await reads.ReadAsync();
            book = await reads.ReadSingleOrDefaultAsync<Book>();
            current = await reads.ReadSingleOrDefaultAsync<BookFile>();
            file = await reads.ReadSingleOrDefaultAsync<BookFile>();
            used = await reads.ReadSingleAsync<long>();
        }
        if (book is null || file is null) return new(AttachOutcome.NotFound);
        if (file.IsCurrent && file.ServerStorageKey is not null) return new(AttachOutcome.AlreadyStored, file);
        if (book.RemovedAt is not null)
        {
            book.CurrentFile = current;
            return new(AttachOutcome.BookRemoved, Book: book);
        }
        if (!file.IsCurrent) return new(AttachOutcome.FileReplaced, current);
        if (used + file.ByteSize > limitBytes) return new(AttachOutcome.QuotaExceeded, Used: used);

        var attached = await conn.QuerySingleAsync<BookFile>(new CommandDefinition(SetStorageKey, args, tx.Transaction, cancellationToken: ct));
        placeBytes();
        await tx.CommitAsync(ct);
        return new(AttachOutcome.Attached, attached);
    }

    // Stamped once: a second "stop syncing" changes nothing and moves no feed. The row lock in `old`
    // waits for an attach in flight and then reads its key, so the key returned is the one cleared.
    private const string ClearContent = """
        WITH old AS (
            SELECT id, server_storage_key FROM book_files
            WHERE user_id = @userId AND book_id = @bookId AND id = @fileId
            FOR UPDATE
        ), f AS (
            UPDATE book_files b SET server_storage_key = NULL, content_removed_at = COALESCE(b.content_removed_at, now())
            FROM old
            WHERE b.id = old.id AND (old.server_storage_key IS NOT NULL OR b.content_removed_at IS NULL)
            RETURNING b.book_id, old.server_storage_key
        ), touched AS (
            UPDATE books SET updated_at = now() WHERE user_id = @userId AND id IN (SELECT book_id FROM f)
        )
        SELECT server_storage_key FROM f
        """;

    public async Task<string?> RemoveContentAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string?>(new CommandDefinition(ClearContent, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    private const string SelectUsersKeys = """
        SELECT server_storage_key FROM book_files WHERE user_id = @userId AND server_storage_key IS NOT NULL
        UNION ALL
        SELECT cover_key FROM books WHERE user_id = @userId AND cover_key IS NOT NULL
        """;

    public async Task<IReadOnlyList<string>> ListStorageKeysAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<string>(new CommandDefinition(SelectUsersKeys, new { userId }, cancellationToken: ct))).AsList();
    }

    private const string SelectAllKeys = """
        SELECT server_storage_key FROM book_files WHERE server_storage_key IS NOT NULL
        UNION
        SELECT cover_key FROM books WHERE cover_key IS NOT NULL
        """;

    public async Task<IReadOnlySet<string>> AllStorageKeysAsync(CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<string>(new CommandDefinition(SelectAllKeys, cancellationToken: ct))).ToHashSet();
    }

    public async Task<long> StoredBytesAsync(Guid userId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(SumStored, new { userId }, cancellationToken: ct));
    }

    private const string SetCoverKey = $"""
        WITH b AS (
            UPDATE books SET cover_key = @coverKey, updated_at = now()
            WHERE user_id = @userId AND id = @bookId
            RETURNING {BookColumns}
        )
        {FromWrittenBook}
        """;

    public async Task<Book?> SetCoverAsync(Guid userId, Guid bookId, string coverKey, CancellationToken ct) =>
        (await QueryBooksAsync(SetCoverKey, new { userId, bookId, coverKey }, null, ct)).SingleOrDefault();
}
