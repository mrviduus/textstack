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

    private const string SelectToc = $"""
        SELECT {HeadingColumns} FROM book_chapters
        WHERE user_id = @userId AND file_id = @fileId
        ORDER BY chapter_number
        """;

    public async Task<IReadOnlyList<BookChapterHeading>> ListTocAsync(Guid userId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<BookChapterHeading>(new CommandDefinition(SelectToc, new { userId, fileId }, cancellationToken: ct))).AsList();
    }

    private const string SelectChapter = $"SELECT {Columns} FROM book_chapters WHERE {ChapterByKey}";

    public async Task<BookChapter?> GetAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<BookChapter>(new CommandDefinition(SelectChapter, new { userId, fileId, chapterKey }, cancellationToken: ct));
    }

    // The nearest number on each side, not ±1: numbering may have gaps. The owner filter is on the
    // rows returned; the subquery only finds the chapter's number in that file (file ids are unique).
    private const string NumberOfKey = "SELECT chapter_number FROM book_chapters WHERE file_id = @fileId AND chapter_key = @chapterKey";

    private const string SelectNeighbours = $"""
        SELECT {HeadingColumns} FROM book_chapters
        WHERE user_id = @userId AND file_id = @fileId AND chapter_number < ({NumberOfKey})
        ORDER BY chapter_number DESC
        LIMIT 1;
        SELECT {HeadingColumns} FROM book_chapters
        WHERE user_id = @userId AND file_id = @fileId AND chapter_number > ({NumberOfKey})
        ORDER BY chapter_number
        LIMIT 1;
        """;

    public async Task<(BookChapterHeading? Previous, BookChapterHeading? Next)> GetNeighboursAsync(
        Guid userId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var results = await conn.QueryMultipleAsync(new CommandDefinition(SelectNeighbours, new { userId, fileId, chapterKey }, cancellationToken: ct));
        var previous = await results.ReadSingleOrDefaultAsync<BookChapterHeading>();
        return (previous, await results.ReadSingleOrDefaultAsync<BookChapterHeading>());
    }

    private const string SelectPlainText = $"SELECT plain_text FROM book_chapters WHERE {ChapterByKey}";

    public async Task<string?> GetPlainTextAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<string>(new CommandDefinition(SelectPlainText, new { userId, fileId, chapterKey }, cancellationToken: ct));
    }

    // One statement for the whole set, so a failure stores none of it.
    // ponytail: a second extraction of the same file hits ak_book_chapters_user_id_file_id_chapter_key; the M2.6 worker decides replace vs reconcile, as ChapterReconciler does on legacy (#1091).
    private const string InsertChapters = """
        INSERT INTO book_chapters (id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, word_count, source_start_page, source_end_page, created_at)
        SELECT c.id, @userId, @bookId, @fileId, c.chapter_key, c.chapter_number, c.title, c.html, c.plain_text, c.word_count, c.source_start_page, c.source_end_page, now()
        FROM unnest(@ids, @keys, @numbers, @titles, @htmls, @plainTexts, @wordCounts, @startPages, @endPages)
            AS c(id, chapter_key, chapter_number, title, html, plain_text, word_count, source_start_page, source_end_page)
        """;

    public async Task InsertForFileAsync(Guid userId, Guid bookId, Guid fileId, IReadOnlyList<BookChapter> chapters, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await conn.ExecuteAsync(new CommandDefinition(InsertChapters, new
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
        }, cancellationToken: ct));
    }
}
