using Application.Library;
using Dapper;
using Domain.Library;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Dapper implementation of <see cref="ILibraryRepository"/> on <c>textstack_v2</c>. The rules it
/// leans on live in the schema (database/v2/migrations/0000_baseline.up.sql, "Library"): one current
/// file per book (partial unique <c>ix_book_files_user_id_book_id</c>), and a file can only point at
/// a book of its own user (<c>fk_book_files_books_user_id_book_id</c>).
/// </summary>
public sealed class LibraryRepository(V2DataSource dataSource) : ILibraryRepository
{
    // These three column lists must agree: the first two for RETURNING, the third for the join.
    private const string BookColumns =
        "id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin, checkpoint_saving_enabled, created_at, updated_at, removed_at";
    private const string FileColumns =
        "id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key, is_current, created_at";
    // A book and its current file in one row; the file half is all null for a book with no file,
    // which Dapper maps to a null CurrentFile.
    private const string SelectBookWithCurrentFile = """
        SELECT b.id, b.user_id, b.title, b.author, b.language, b.description, b.genre, b.published_year, b.tags,
               b.cover_key, b.origin, b.checkpoint_saving_enabled, b.created_at, b.updated_at, b.removed_at,
               f.id, f.user_id, f.book_id, f.sha256, f.byte_size, f.original_name, f.format, f.page_count, f.toc,
               f.server_storage_key, f.is_current, f.created_at
        FROM books b
        LEFT JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.is_current

        """;

    private const string InsertFile = $"""
        INSERT INTO book_files (id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key, is_current, created_at)
        VALUES (@Id, @UserId, @BookId, @Sha256, @ByteSize, @OriginalName, @Format, @PageCount, CAST(@Toc AS jsonb), @ServerStorageKey, true, now())
        RETURNING {FileColumns}
        """;

    public Task<IReadOnlyList<Book>> ListAsync(Guid userId, CancellationToken ct) => QueryBooksAsync("""
        WHERE b.user_id = @userId AND b.removed_at IS NULL
        ORDER BY b.created_at DESC
        """, new { userId }, ct);

    public async Task<Book?> GetAsync(Guid userId, Guid bookId, CancellationToken ct) =>
        (await QueryBooksAsync("WHERE b.user_id = @userId AND b.id = @bookId", new { userId, bookId }, ct)).SingleOrDefault();

    // Several books may hold the same bytes (no UNIQUE, by design): the oldest is the answer.
    public async Task<Book?> FindBySha256Async(Guid userId, string sha256, CancellationToken ct) =>
        (await QueryBooksAsync("""
            WHERE b.user_id = @userId AND b.removed_at IS NULL AND f.sha256 = @sha256
            ORDER BY b.created_at
            LIMIT 1
            """, new { userId, sha256 }, ct)).SingleOrDefault();

    public async Task<Book> ImportAsync(Book book, BookFile file, CancellationToken ct)
    {
        if (file.UserId != book.UserId || file.BookId != book.Id)
            throw new ArgumentException("The file must belong to the book being imported.", nameof(file));
        const string insertBook = $"""
            INSERT INTO books (id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin, checkpoint_saving_enabled, created_at, updated_at)
            VALUES (@Id, @UserId, @Title, @Author, @Language, @Description, @Genre, @PublishedYear, @Tags, @CoverKey, CAST(@Origin AS jsonb), @CheckpointSavingEnabled, now(), now())
            RETURNING {BookColumns}
            """;
        // ponytail: a replayed import throws on pk_books; return the stored row once the M2 import endpoint is replayable (#1065).
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        var stored = await conn.QuerySingleAsync<Book>(new CommandDefinition(insertBook, book, tx, cancellationToken: ct));
        stored.CurrentFile = await conn.QuerySingleAsync<BookFile>(new CommandDefinition(InsertFile, file, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return stored;
    }

    public async Task<FileReplacement?> ReplaceFileAsync(Guid userId, Guid bookId, BookFile file, CancellationToken ct)
    {
        if (file.UserId != userId || file.BookId != bookId)
            throw new ArgumentException("The file must belong to the book being replaced.", nameof(file));
        // Bumping updated_at also locks the book row, which serializes two replacements of one book:
        // without it both would find the same current row, and the second insert would hit the
        // one-current-file index.
        const string lockBook = """
            UPDATE books SET updated_at = now()
            WHERE user_id = @userId AND id = @bookId AND removed_at IS NULL
            """;
        const string supersede = $"""
            UPDATE book_files SET is_current = false
            WHERE user_id = @userId AND book_id = @bookId AND is_current
            RETURNING {FileColumns}
            """;
        // The state's locators and fractions mean something only in the version they were taken in.
        // A delete is safe here, unlike in a reset: a device still holding the old revision names the
        // old file, and AdvanceAsync's file_id guard makes that write lose.
        // ponytail: another aggregate's table, in this transaction; moves to IReadingStateRepository with a shared tx (#1067).
        const string resetReading = "DELETE FROM reading_state WHERE user_id = @userId AND book_id = @bookId";

        var args = new { userId, bookId };
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        if (await conn.ExecuteAsync(new CommandDefinition(lockBook, args, tx, cancellationToken: ct)) == 0)
            return null;
        var superseded = await conn.QuerySingleOrDefaultAsync<BookFile>(new CommandDefinition(supersede, args, tx, cancellationToken: ct));
        var current = await conn.QuerySingleAsync<BookFile>(new CommandDefinition(InsertFile, file, tx, cancellationToken: ct));
        await conn.ExecuteAsync(new CommandDefinition(resetReading, args, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return new FileReplacement(current, superseded);
    }

    public async Task<bool> RemoveAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = """
            UPDATE books SET removed_at = now(), updated_at = now()
            WHERE user_id = @userId AND id = @bookId AND removed_at IS NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct)) > 0;
    }

    public async Task<bool> RestoreAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        const string sql = """
            UPDATE books SET removed_at = NULL, updated_at = now()
            WHERE user_id = @userId AND id = @bookId AND removed_at IS NOT NULL
            """;
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(sql, new { userId, bookId }, cancellationToken: ct)) > 0;
    }

    /// <summary>Books with their current file; <paramref name="whereAndOrder"/> must filter on <c>b.user_id</c>.</summary>
    private async Task<IReadOnlyList<Book>> QueryBooksAsync(string whereAndOrder, object args, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        var books = await conn.QueryAsync<Book, BookFile, Book>(
            new CommandDefinition(SelectBookWithCurrentFile + whereAndOrder, args, cancellationToken: ct),
            (book, file) =>
            {
                book.CurrentFile = file;
                return book;
            });
        return books.AsList();
    }
}
