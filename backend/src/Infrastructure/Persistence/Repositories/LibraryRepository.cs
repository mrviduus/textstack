using Application.Common;
using Application.Library;
using Dapper;
using Domain.Library;
using Npgsql;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ILibraryRepository"/> on <c>textstack_v2</c>. The rules it
/// leans on live in the schema (database/v2/migrations/0000_baseline.up.sql, "Library"): one current
/// file per book (partial unique <c>ix_book_files_user_id_book_id</c>), and a file can only point at
/// a book of its own user (<c>fk_book_files_books_user_id_book_id</c>).
/// </summary>
public sealed class LibraryRepository(V2DataSource dataSource) : ILibraryRepository
{
    // These column lists must agree: the first two for RETURNING, the third for the join.
    private const string BookColumns =
        "id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin, checkpoint_saving_enabled, revision, created_at, updated_at, removed_at";
    private const string FileColumns =
        "id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key, is_current, created_at";
    // A book and its current file in one row; the file half is all null for a book with no file,
    // which Dapper maps to a null CurrentFile.
    private const string BookWithCurrentFile = """
        SELECT b.id, b.user_id, b.title, b.author, b.language, b.description, b.genre, b.published_year, b.tags,
               b.cover_key, b.origin, b.checkpoint_saving_enabled, b.revision, b.created_at, b.updated_at, b.removed_at,
               f.id, f.user_id, f.book_id, f.sha256, f.byte_size, f.original_name, f.format, f.page_count, f.toc,
               f.server_storage_key, f.is_current, f.created_at

        """;
    private const string FromBooks = BookWithCurrentFile + """
        FROM books b
        LEFT JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.is_current

        """;

    private const string SelectLiveBooks = FromBooks + """
        WHERE b.user_id = @userId AND b.removed_at IS NULL
        ORDER BY b.created_at DESC
        """;

    public Task<IReadOnlyList<Book>> ListAsync(Guid userId, CancellationToken ct) => QueryBooksAsync(SelectLiveBooks, new { userId }, null, ct);

    private const string SelectBook = FromBooks + "WHERE b.user_id = @userId AND b.id = @bookId";

    public async Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        (await QueryBooksAsync(SelectBook, new { userId, bookId }, null, ct)).SingleOrDefault();

    private const string BookExists = "SELECT EXISTS (SELECT FROM books WHERE user_id = @userId AND id = @bookId)";

    public async Task<bool> ExistsAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<bool>(new CommandDefinition(BookExists, new { userId, bookId }, cancellationToken: ct));
    }

    private const string SelectFile = $"SELECT {FileColumns} FROM book_files WHERE user_id = @userId AND book_id = @bookId AND id = @fileId";

    public async Task<BookFile?> GetFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<BookFile>(new CommandDefinition(SelectFile, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    // Several books may hold the same bytes (no UNIQUE, by design): the oldest is the answer.
    private const string SelectOldestBySha256 = FromBooks + """
        WHERE b.user_id = @userId AND b.removed_at IS NULL AND f.sha256 = @sha256
        ORDER BY b.created_at
        LIMIT 1
        """;

    public async Task<Book?> FindBySha256Async(Guid userId, string sha256, CancellationToken ct) =>
        (await QueryBooksAsync(SelectOldestBySha256, new { userId, sha256 }, null, ct)).SingleOrDefault();

    private const string SelectChanged = FromBooks + """
        WHERE b.user_id = @userId AND (b.updated_at, b.id) > (@since, @afterId)
        ORDER BY b.updated_at, b.id
        LIMIT @limit
        """;

    public Task<IReadOnlyList<Book>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct) =>
        QueryBooksAsync(SelectChanged, new { userId, since, afterId, limit }, null, ct);

    // Two devices importing the same bytes at once: the second waits here, then sees the first's book.
    // No UNIQUE can say it (two books may hold the same bytes after a replacement), so a lock does.
    private const string LockImportOfBytes = "SELECT pg_advisory_xact_lock(hashtext(@userId::text || @sha256))";

    // Who already holds the import's ids. Reading another user's row only as a boolean: id_conflict.
    private const string SelectIdHolders = """
        SELECT (SELECT user_id FROM books WHERE id = @bookId) AS book_owner,
               EXISTS (SELECT FROM book_files WHERE id = @fileId) AS file_taken,
               EXISTS (SELECT FROM book_files WHERE user_id = @userId AND book_id = @bookId AND id = @fileId) AS file_is_version
        """;

    private const string InsertBook = $"""
        INSERT INTO books (id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin, checkpoint_saving_enabled, created_at, updated_at)
        VALUES (@Id, @UserId, @Title, @Author, @Language, @Description, @Genre, @PublishedYear, @Tags, @CoverKey, CAST(@Origin AS jsonb), @CheckpointSavingEnabled, now(), now())
        RETURNING {BookColumns}
        """;

    private const string InsertFile = $"""
        INSERT INTO book_files (id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key, is_current, created_at)
        VALUES (@Id, @UserId, @BookId, @Sha256, @ByteSize, @OriginalName, @Format, @PageCount, CAST(@Toc AS jsonb), @ServerStorageKey, true, now())
        RETURNING {FileColumns}
        """;

    public async Task<ImportResult> ImportAsync(Guid userId, Book book, BookFile file, CancellationToken ct)
    {
        if (file.BookId != book.Id)
            throw new ArgumentException("The file must belong to the book being imported.", nameof(file));
        (book.UserId, file.UserId) = (userId, userId);
        await using var tx = await dataSource.BeginAsync(ct);
        var conn = tx.Connection;
        await conn.ExecuteAsync(new CommandDefinition(LockImportOfBytes, new { userId, sha256 = file.Sha256 }, tx.Transaction, cancellationToken: ct));
        var (bookOwner, fileTaken, fileIsVersion) = await conn.QuerySingleAsync<(Guid?, bool, bool)>(new CommandDefinition(
            SelectIdHolders, new { userId, bookId = book.Id, fileId = file.Id }, tx.Transaction, cancellationToken: ct));
        if (bookOwner == userId && fileIsVersion)
            return new(ImportOutcome.Replayed, (await QueryBooksAsync(SelectBook, new { userId, bookId = book.Id }, tx.Transaction, ct)).Single());
        if (bookOwner is not null || fileTaken)
            return new(ImportOutcome.IdConflict, null);
        var duplicate = (await QueryBooksAsync(SelectOldestBySha256, new { userId, sha256 = file.Sha256 }, tx.Transaction, ct)).SingleOrDefault();
        if (duplicate is not null)
            return new(ImportOutcome.DuplicateFile, duplicate);
        var stored = await conn.QuerySingleAsync<Book>(new CommandDefinition(InsertBook, book, tx.Transaction, cancellationToken: ct));
        stored.CurrentFile = await conn.QuerySingleAsync<BookFile>(new CommandDefinition(InsertFile, file, tx.Transaction, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return new(ImportOutcome.Created, stored);
    }

    private const string UpdateMetadataGuarded = $"""
        WITH b AS (
            UPDATE books SET
                title = @Title, author = @Author, language = @Language, description = @Description, genre = @Genre,
                published_year = @PublishedYear, tags = @Tags, revision = revision + 1, updated_at = now()
            WHERE user_id = @userId AND id = @bookId AND revision = @expectedRevision AND removed_at IS NULL
            RETURNING {BookColumns}
        )
        {BookWithCurrentFile}
        FROM b
        LEFT JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.is_current
        """;

    public async Task<RevisionedWrite<Book>> UpdateMetadataAsync(
        Guid userId, Guid bookId, BookMetadata metadata, long expectedRevision, CancellationToken ct)
    {
        var args = new DynamicParameters(metadata);
        args.AddDynamicParams(new { userId, bookId, expectedRevision });
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var written = (await QueryBooksAsync(conn, UpdateMetadataGuarded, args, null, ct)).SingleOrDefault();
        // A second statement, not a UNION in the first: read in the update's snapshot, a loss to a
        // concurrent writer would show the row as it was before the winner.
        return written is not null ? new(true, written)
            : new(false, (await QueryBooksAsync(conn, SelectBook, new { userId, bookId }, null, ct)).SingleOrDefault());
    }

    // The row lock serializes two replacements of one book: without it both would find the same
    // current file, and the second insert would hit the one-current-file index.
    private const string LockBook = $"SELECT {BookColumns} FROM books WHERE user_id = @userId AND id = @bookId FOR UPDATE";

    // Its own statement after the lock, so its snapshot sees the replacement the lock waited for (a
    // join in the locking SELECT would read the current file as it was before). file_is_this_books:
    // null, the id is free; true, a version of this book; false, another book's, perhaps another user's.
    // It comes first: Dapper maps an all-null split to null only after the first.
    private const string SelectCurrentFileAndIdHolder = """
        SELECT (SELECT (user_id, book_id) = (@userId, @bookId) FROM book_files WHERE id = @fileId) AS file_is_this_books,
               f.id, f.user_id, f.book_id, f.sha256, f.byte_size, f.original_name, f.format, f.page_count, f.toc,
               f.server_storage_key, f.is_current, f.created_at
        FROM (SELECT 1) AS one
        LEFT JOIN book_files f ON f.user_id = @userId AND f.book_id = @bookId AND f.is_current
        """;

    private const string SupersedeCurrentFile = $"""
        UPDATE book_files SET is_current = false
        WHERE user_id = @userId AND book_id = @bookId AND is_current
        RETURNING {FileColumns}
        """;

    private const string TouchBook = "UPDATE books SET updated_at = now() WHERE user_id = @userId AND id = @bookId";

    public async Task<FileReplacement> ReplaceFileAsync(
        Guid userId, Guid bookId, BookFile file, Guid? replacesFileId, NpgsqlTransaction? tx, CancellationToken ct)
    {
        if (file.BookId != bookId)
            throw new ArgumentException("The file must belong to the book being replaced.", nameof(file));
        file.UserId = userId;
        var args = new { userId, bookId, fileId = file.Id };
        await using var unit = await dataSource.JoinOrBeginAsync(tx, ct);
        var conn = unit.Connection;
        var book = await conn.QuerySingleOrDefaultAsync<Book>(new CommandDefinition(LockBook, args, unit.Transaction, cancellationToken: ct));
        if (book is null) return new(FileReplaceOutcome.NotFound);
        var (isThisBooks, current) = (await conn.QueryAsync<bool?, BookFile, (bool?, BookFile?)>(
            new CommandDefinition(SelectCurrentFileAndIdHolder, args, unit.Transaction, cancellationToken: ct),
            (holder, f) => (holder, f), splitOn: "id")).Single();
        book.CurrentFile = current;
        // A replay first: the write it repeats landed, so it answers 200 even after the book was removed (M1.2 delta 3).
        if (current?.Id == file.Id) return new(FileReplaceOutcome.Replayed, current);
        if (book.RemovedAt is not null) return new(FileReplaceOutcome.BookRemoved, Book: book);
        if (isThisBooks == false) return new(FileReplaceOutcome.IdConflict);
        // A superseded version of this book, or a view of the current file that is stale.
        if (isThisBooks == true || current?.Id != replacesFileId) return new(FileReplaceOutcome.FileReplaced, current);

        var superseded = await conn.QuerySingleOrDefaultAsync<BookFile>(new CommandDefinition(SupersedeCurrentFile, args, unit.Transaction, cancellationToken: ct));
        var inserted = await conn.QuerySingleAsync<BookFile>(new CommandDefinition(InsertFile, file, unit.Transaction, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition(TouchBook, args, unit.Transaction, cancellationToken: ct));
        await unit.CommitAsync(ct);
        return new(FileReplaceOutcome.Replaced, inserted, superseded);
    }

    private const string SetCheckpointSaving = $"""
        WITH b AS (
            UPDATE books SET checkpoint_saving_enabled = @enabled, updated_at = now()
            WHERE user_id = @userId AND id = @bookId
            RETURNING {BookColumns}
        )
        {BookWithCurrentFile}
        FROM b
        LEFT JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.is_current
        """;

    public async Task<Book?> SetCheckpointSavingAsync(Guid userId, Guid bookId, bool enabled, CancellationToken ct) =>
        (await QueryBooksAsync(SetCheckpointSaving, new { userId, bookId, enabled }, null, ct)).SingleOrDefault();

    private const string MarkRemoved = """
        UPDATE books SET removed_at = now(), updated_at = now()
        WHERE user_id = @userId AND id = @bookId AND removed_at IS NULL
        """;

    public Task<bool> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct) => ChangesOneAsync(MarkRemoved, new { userId, bookId }, ct);

    private const string ClearRemoved = """
        UPDATE books SET removed_at = NULL, updated_at = now()
        WHERE user_id = @userId AND id = @bookId AND removed_at IS NOT NULL
        """;

    public Task<bool> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct) => ChangesOneAsync(ClearRemoved, new { userId, bookId }, ct);

    private async Task<bool> ChangesOneAsync(string update, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(update, args, cancellationToken: ct)) > 0;
    }

    private async Task<IReadOnlyList<Book>> QueryBooksAsync(string select, object args, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var lease = await dataSource.JoinOrOpenAsync(tx, ct);
        return await QueryBooksAsync(lease.Connection, select, args, tx, ct);
    }

    /// <summary>Books with their current file: <paramref name="select"/> is one of the <see cref="BookWithCurrentFile"/> statements.</summary>
    private static async Task<IReadOnlyList<Book>> QueryBooksAsync(NpgsqlConnection conn, string select, object args, NpgsqlTransaction? tx, CancellationToken ct)
    {
        var books = await conn.QueryAsync<Book, BookFile, Book>(
            new CommandDefinition(select, args, tx, cancellationToken: ct),
            (book, file) =>
            {
                book.CurrentFile = file;
                return book;
            });
        return books.AsList();
    }
}
