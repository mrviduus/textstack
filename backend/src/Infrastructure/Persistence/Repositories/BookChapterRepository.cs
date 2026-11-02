using Application.Transitional;
using Dapper;
using Domain.Transitional;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Transitional (dropped at M6.4, ADR-031). Dapper implementation of <see cref="IBookChapterRepository"/>
/// on <c>textstack_v2</c>: one chapter per <c>(user_id, file_id, chapter_key)</c>, one per number of a
/// file version, and a file only of the user's own book (<c>fk_book_chapters_book_files_user_id_book_id_file_id</c>).
/// </summary>
public sealed class BookChapterRepository(V2DataSource dataSource) : IBookChapterRepository
{
    private const string HeadingColumns = "id, chapter_key, chapter_number, title, word_count, source_start_page, source_end_page";

    private const string Columns = $"{HeadingColumns}, user_id, book_id, file_id, html, plain_text, created_at";
    private const string ChapterByKey = "user_id = @userId AND file_id = @fileId AND chapter_key = @chapterKey";

    // The full (user_id, book_id, file_id) prefix of ix_book_chapters_user_id_book_id_file_id_chapter_number,
    // so the index gives the order and a neighbour is a LIMIT 1 probe.
    private const string OfFile = "user_id = @userId AND book_id = @bookId AND file_id = @fileId";

    private const string SelectToc = $"""
        SELECT {HeadingColumns} FROM book_chapters
        WHERE {OfFile}
        ORDER BY chapter_number
        """;

    public async Task<IReadOnlyList<BookChapterHeading>> ListTocAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<BookChapterHeading>(new CommandDefinition(SelectToc, new { userId, bookId, fileId }, cancellationToken: ct))).AsList();
    }

    private const string SelectChapter = $"SELECT {Columns} FROM book_chapters WHERE {ChapterByKey}";

    // The chapter, then the nearest number on each side, not ±1: numbering may have gaps. The subquery
    // keeps user_id because it leads ak_book_chapters_user_id_file_id_chapter_key.
    private const string SelectChapterAndNeighbours = $"""
        {SelectChapter} AND book_id = @bookId;
        SELECT {HeadingColumns} FROM book_chapters
        WHERE {OfFile} AND chapter_number < (SELECT chapter_number FROM book_chapters WHERE {ChapterByKey})
        ORDER BY chapter_number DESC
        LIMIT 1;
        SELECT {HeadingColumns} FROM book_chapters
        WHERE {OfFile} AND chapter_number > (SELECT chapter_number FROM book_chapters WHERE {ChapterByKey})
        ORDER BY chapter_number
        LIMIT 1;
        """;

    public async Task<(BookChapter? Chapter, BookChapterHeading? Previous, BookChapterHeading? Next)> GetWithNeighboursAsync(
        Guid userId, Guid bookId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var results = await conn.QueryMultipleAsync(new CommandDefinition(
            SelectChapterAndNeighbours, new { userId, bookId, fileId, chapterKey }, cancellationToken: ct));
        var chapter = await results.ReadSingleOrDefaultAsync<BookChapter>();
        var previous = await results.ReadSingleOrDefaultAsync<BookChapterHeading>();
        var next = await results.ReadSingleOrDefaultAsync<BookChapterHeading>();
        return chapter is null ? (null, null, null) : (chapter, previous, next);
    }

    private const string SelectPlainText = $"SELECT plain_text FROM book_chapters WHERE {ChapterByKey}";

    public async Task<string?> GetPlainTextAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(SelectPlainText, new { userId, fileId, chapterKey }, cancellationToken: ct));
    }

    private const string DeleteFileChapters = $"DELETE FROM book_chapters WHERE {OfFile}";

    private const string InsertChapters = """
        INSERT INTO book_chapters (id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, word_count, source_start_page, source_end_page, created_at)
        SELECT c.id, @userId, @bookId, @fileId, c.chapter_key, c.chapter_number, c.title, c.html, c.plain_text, c.word_count, c.source_start_page, c.source_end_page, now()
        FROM unnest(@ids, @keys, @numbers, @titles, @htmls, @plainTexts, @wordCounts, @startPages, @endPages)
            AS c(id, chapter_key, chapter_number, title, html, plain_text, word_count, source_start_page, source_end_page)
        """;

    public async Task ReplaceForFileAsync(Guid userId, Guid bookId, Guid fileId, IReadOnlyList<BookChapter> chapters, CancellationToken ct)
    {
        await using var tx = await dataSource.BeginAsync(ct);
        await tx.Connection.ExecuteAsync(new CommandDefinition(DeleteFileChapters, new { userId, bookId, fileId }, tx.Transaction, cancellationToken: ct));
        await tx.Connection.ExecuteAsync(new CommandDefinition(InsertChapters, new
        {
            userId,
            bookId,
            fileId,
            ids = chapters.Select(c => c.Id).ToArray(),
            keys = chapters.Select(c => c.ChapterKey).ToArray(),
            numbers = chapters.Select(c => c.ChapterNumber).ToArray(),
            titles = chapters.Select(c => c.Title).ToArray(),
            htmls = chapters.Select(c => c.Html).ToArray(),
            plainTexts = chapters.Select(c => c.PlainText).ToArray(),
            wordCounts = chapters.Select(c => c.WordCount).ToArray(),
            startPages = chapters.Select(c => c.SourceStartPage).ToArray(),
            endPages = chapters.Select(c => c.SourceEndPage).ToArray(),
        }, tx.Transaction, cancellationToken: ct));
        await tx.CommitAsync(ct);
    }
}
