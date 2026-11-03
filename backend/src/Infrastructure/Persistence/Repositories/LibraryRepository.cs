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
/// a book of its own user (<c>fk_book_files_books_user_id_book_id</c>). Split by concern: the reads
/// here, the metadata and version writes in <c>.Writes.cs</c>, the stored bytes in <c>.Content.cs</c>.
/// </summary>
public sealed partial class LibraryRepository(V2DataSource dataSource) : ILibraryRepository
{
    // These column lists must agree: the first two for RETURNING, the third for the join.
    private const string BookColumns =
        "id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin, checkpoint_saving_enabled, revision, created_at, updated_at, removed_at";
    private const string FileColumns =
        "id, user_id, book_id, sha256, byte_size, original_name, format, page_count, toc, server_storage_key, content_removed_at, is_current, created_at";
    // A book and its current file in one row; the file half is all null for a book with no file,
    // which Dapper maps to a null CurrentFile.
    private const string BookWithCurrentFile = """
        SELECT b.id, b.user_id, b.title, b.author, b.language, b.description, b.genre, b.published_year, b.tags,
               b.cover_key, b.origin, b.checkpoint_saving_enabled, b.revision, b.created_at, b.updated_at, b.removed_at,
               f.id, f.user_id, f.book_id, f.sha256, f.byte_size, f.original_name, f.format, f.page_count, f.toc,
               f.server_storage_key, f.content_removed_at, f.is_current, f.created_at

        """;
    private const string FromBooks = BookWithCurrentFile + """
        FROM books b
        LEFT JOIN book_files f ON f.user_id = b.user_id AND f.book_id = b.id AND f.is_current

        """;

    // The same over a CTE b that RETURNING {BookColumns} from a write: the row this write produced.
    private const string FromWrittenBook = BookWithCurrentFile + """
        FROM b
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

    private const string FileFormat = "SELECT format FROM book_files WHERE user_id = @userId AND book_id = @bookId AND id = @fileId";

    public async Task<string?> FileFormatAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<string?>(new CommandDefinition(FileFormat, new { userId, bookId, fileId }, cancellationToken: ct));
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
