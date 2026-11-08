using Application.Common;
using Npgsql;
using NpgsqlTypes;

namespace Infrastructure.Persistence.Etl;

// user_chapters → book_chapters (transitional, ADR-031 row 34): keyed to the book's one carried file, compared by
// md5 of the text (2,710 rows, 131 MB in production), the missing ones written by binary COPY (plan §5.2).
public static partial class EtlV2Uploads
{
    // chapter_key = COALESCE(slug, 'ch-' || chapter_number) (ADR-031 item 6). search_vector and
    // content_quality_score are not carried, nor a takedown's chapters (its content; listed once, with the book).
    private const string SelectLegacyChapters = """
        SELECT c.id, b.user_id, c.user_book_id AS book_id, COALESCE(c.slug, 'ch-' || c.chapter_number) AS chapter_key, c.chapter_number, c.title,
               md5(c.html) AS html_md5, md5(c.plain_text) AS plain_text_md5, c.word_count, c.source_start_page, c.source_end_page, c.created_at
        FROM user_chapters c
        JOIN user_books b ON b.id = c.user_book_id
        WHERE b.takedown_at IS NULL
        ORDER BY c.id
        """;

    private const string SelectV2Chapters = """
        SELECT id, user_id, book_id, file_id, chapter_key, chapter_number, title, md5(html) AS html_md5, md5(plain_text) AS plain_text_md5,
               word_count, source_start_page, source_end_page, created_at
        FROM book_chapters
        """;

    // The rows a run wrote, re-read for parity.
    private const string SelectV2ChaptersById = SelectV2Chapters + " WHERE id = ANY(@ids)";

    private const string SelectChapterTexts = "SELECT id, html, plain_text FROM user_chapters WHERE id = ANY(@ids)";

    private const string CopyChapters = """
        COPY book_chapters (id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, word_count,
                            source_start_page, source_end_page, created_at)
        FROM STDIN (FORMAT BINARY)
        """;

    private static async Task<List<ChapterRow>> MapChaptersAsync(EtlV2Context context, Dictionary<Guid, FileRow> files, CancellationToken ct)
    {
        var legacy = await EtlV2Rows.SourceAsync<ChapterRow>(context, SelectLegacyChapters, null, ct);
        foreach (var book in legacy.Where(c => !files.ContainsKey(c.BookId)).GroupBy(c => c.BookId))
            context.OrphanCandidates.Add($"user_books {book.Key}: {book.Count()} user_chapters not carried, the book has no file row");
        var rows = legacy.Where(c => files.ContainsKey(c.BookId)).Select(c => c with { FileId = files[c.BookId].Id }).ToList();
        EtlV2Rows.Check(context, "book_chapters: blank chapter key", rows.Where(c => string.IsNullOrWhiteSpace(c.ChapterKey)).Select(c => c.Id.ToString()));
        // The 'ch-<n>' fallback can collide with a real slug: V2's (user_id, file_id, chapter_key) key would refuse the second.
        EtlV2Rows.Check(context, "book_chapters: two chapters of a file with one key", EtlV2Rows.Duplicates(rows, c => (c.FileId, c.ChapterKey), c => c.Id));
        return rows;
    }

    private static async Task CopyChaptersAsync(EtlV2Context context, V2Transaction tx, List<ChapterRow> chapters, CancellationToken ct)
    {
        if (chapters.Count == 0)
            return;
        var byId = chapters.ToDictionary(c => c.Id);
        await using var texts = new NpgsqlCommand(SelectChapterTexts, context.Source.Connection, context.Source);
        texts.Parameters.AddWithValue("ids", byId.Keys.ToArray());
        await using var reader = await texts.ExecuteReaderAsync(ct);
        await using var copy = await tx.Connection.BeginBinaryImportAsync(CopyChapters, ct);
        while (await reader.ReadAsync(ct))
        {
            var c = byId[reader.GetGuid(0)];
            await copy.StartRowAsync(ct);
            await copy.WriteAsync(c.Id, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(c.UserId, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(c.BookId, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(c.FileId, NpgsqlDbType.Uuid, ct);
            await copy.WriteAsync(c.ChapterKey, NpgsqlDbType.Text, ct);
            await copy.WriteAsync(c.ChapterNumber, NpgsqlDbType.Integer, ct);
            await copy.WriteAsync(c.Title, NpgsqlDbType.Varchar, ct);
            await copy.WriteAsync(reader.GetString(1), NpgsqlDbType.Text, ct);
            await copy.WriteAsync(reader.GetString(2), NpgsqlDbType.Text, ct);
            foreach (var n in new[] { c.WordCount, c.SourceStartPage, c.SourceEndPage })
            {
                if (n is { } value)
                    await copy.WriteAsync(value, NpgsqlDbType.Integer, ct);
                else
                    await copy.WriteNullAsync(ct);
            }
            await copy.WriteAsync(c.CreatedAt.UtcDateTime, NpgsqlDbType.TimestampTz, ct);
        }
        await copy.CompleteAsync(ct);
    }

    private sealed record ChapterRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public Guid FileId { get; init; }
        public string ChapterKey { get; init; } = "";
        public int ChapterNumber { get; init; }
        public string Title { get; init; } = "";
        public string HtmlMd5 { get; init; } = "";
        public string PlainTextMd5 { get; init; } = "";
        public int? WordCount { get; init; }
        public int? SourceStartPage { get; init; }
        public int? SourceEndPage { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }
}
