using System.Text.Json;

namespace Infrastructure.Persistence.Etl;

// Progress → reading_state and upload highlights → annotations; the quote check (plan §5.2 validation part 3).
public static partial class EtlV2Uploads
{
    private const string SelectV2States = """
        SELECT user_id, book_id, file_id, current_locator::text AS current_locator, book_fraction, frontier_locator::text AS frontier_locator,
               frontier_fraction, completed_at, client_recorded_at, updated_at, revision, reset_revision
        FROM reading_state
        """;

    private const string InsertState = """
        INSERT INTO reading_state (user_id, book_id, file_id, current_locator, book_fraction, frontier_locator, frontier_fraction,
                                   completed_at, client_recorded_at, updated_at, revision, reset_revision)
        VALUES (@UserId, @BookId, @FileId, CAST(@CurrentLocator AS jsonb), @BookFraction, CAST(@FrontierLocator AS jsonb), @FrontierFraction,
                @CompletedAt, @ClientRecordedAt, @UpdatedAt, @Revision, @ResetRevision)
        """;

    // Upload highlights, and the ones with no book at all (a deleted upload's trail); catalog ones are M3.3's.
    // The locator, built here so jsonb prints it as the target will: a PDF anchor as-is; a reflow anchor with
    // chapterId replaced by its chapter's key (ADR-031 item 6); a reflow anchor whose chapter is gone has none.
    private const string SelectLegacyHighlights = """
        SELECT h.id, h.user_id, h.user_book_id AS book_id, h.selected_text, h.note_text, h.color, h.version AS revision, h.created_at, h.updated_at,
               jsonb_typeof(h.anchor_json) = 'object' AS anchor_is_object,
               CASE
                   WHEN jsonb_typeof(h.anchor_json) <> 'object' THEN NULL
                   WHEN h.anchor_json ->> 'kind' = 'pdf'
                       THEN jsonb_build_object('version', 1, 'scheme', 'pdf-page', 'value', h.anchor_json)
                   WHEN c.id IS NOT NULL
                       THEN jsonb_build_object('version', 1, 'scheme', 'textstack-anchor-v1',
                            'value', (h.anchor_json - 'chapterId') || jsonb_build_object('chapterKey', COALESCE(c.slug, 'ch-' || c.chapter_number)))
               END::text AS locator
        FROM highlights h
        LEFT JOIN user_chapters c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
        WHERE h.user_book_id IS NOT NULL OR h.edition_id IS NULL
        ORDER BY h.id
        """;

    private const string SelectV2Annotations = """
        SELECT id, user_id, book_id, file_id, selected_text, note_text, locator::text AS locator, color, created_at, updated_at, deleted_at, revision
        FROM annotations
        """;

    private const string InsertAnnotation = """
        INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, deleted_at, revision)
        VALUES (@Id, @UserId, @BookId, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, @CreatedAt, @UpdatedAt, @DeletedAt, @Revision)
        """;

    // Plan §5.2 validation part 3: an anchored upload annotation's text is in its chapter's plain_text. On a
    // written run, what V2 holds; otherwise legacy's (the rows V2 would hold).
    private const string QuotesMissingInV2 = """
        SELECT a.id FROM annotations a
        LEFT JOIN book_chapters c ON c.user_id = a.user_id AND c.file_id = a.file_id AND c.chapter_key = a.locator -> 'value' ->> 'chapterKey'
        WHERE a.id = ANY(@ids) AND (c.id IS NULL OR strpos(c.plain_text, a.selected_text) = 0)
        ORDER BY a.id
        """;

    private const string QuotesMissingInLegacy = """
        SELECT h.id FROM highlights h
        LEFT JOIN user_chapters c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
        WHERE h.id = ANY(@ids) AND (c.id IS NULL OR strpos(c.plain_text, h.selected_text) = 0)
        ORDER BY h.id
        """;

    private static List<StateRow> MapStates(EtlV2Context context, List<LegacyBook> books, Dictionary<Guid, FileRow> files)
    {
        var (unmappable, outOfRange, rows) = (new List<string>(), new List<string>(), new List<StateRow>());
        foreach (var b in books.Where(b => b.HasProgress))
        {
            if (!files.TryGetValue(b.Id, out var file))
            {
                context.OrphanCandidates.Add($"user_books {b.Id}: progress not carried, the book has no file row (its position resets, as a catalog book's)");
                continue;
            }
            // No locator V2 can resume from (a percent or a "read" mark alone), or a page on a file that is not a PDF.
            if (b.CurrentLocator is null || (Scheme(b.CurrentLocator) == "pdf-page" && file.Format != "pdf"))
            {
                unmappable.Add(b.Id.ToString());
                continue;
            }
            var fraction = b.BookFraction ?? 0;
            if (fraction is < 0 or > 1)
                outOfRange.Add(b.Id.ToString());
            rows.Add(new StateRow
            {
                UserId = b.UserId,
                BookId = b.Id,
                FileId = file.Id,
                CurrentLocator = b.CurrentLocator,
                BookFraction = fraction,
                CompletedAt = b.CompletedAt,
                ClientRecordedAt = b.ClientRecordedAt,
                UpdatedAt = b.StateUpdatedAt,
            });
        }
        EtlV2Rows.Check(context, "reading_state: legacy progress with no mappable locator", unmappable);
        EtlV2Rows.Check(context, "reading_state: progress percent outside 0..1", outOfRange);
        return rows;
    }

    private static async Task<List<AnnotationRow>> MapAnnotationsAsync(
        EtlV2Context context, Dictionary<Guid, LegacyBook> books, Dictionary<Guid, FileRow> files, CancellationToken ct)
    {
        var (notOwner, unmappable, invalid, rows) = (new List<string>(), new List<string>(), new List<string>(), new List<AnnotationRow>());
        foreach (var h in await EtlV2Rows.SourceAsync<LegacyHighlight>(context, SelectLegacyHighlights, null, ct))
        {
            if (h.BookId is not { } bookId)
            {
                context.OrphanCandidates.Add($"highlights {h.Id}: no upload and no edition (a deleted upload's trail); not carried");
                continue;
            }
            var book = books[bookId];
            var file = files.GetValueOrDefault(bookId);
            if (h.UserId != book.UserId)
                notOwner.Add(h.Id.ToString());
            if (!h.AnchorIsObject || (Scheme(h.Locator) == "pdf-page" && file is not null && file.Format != "pdf"))
                unmappable.Add(h.Id.ToString());
            if (string.IsNullOrWhiteSpace(h.SelectedText) || h.Revision < 1)
                invalid.Add(h.Id.ToString());
            if (h.AnchorIsObject && (h.Locator is null || file is null))
                context.OrphanCandidates.Add($"highlights {h.Id}: anchor not carried ({(file is null ? "the book has no file row" : "its chapter is gone")}); carried as a quotation");
            rows.Add(new AnnotationRow
            {
                Id = h.Id,
                UserId = book.UserId,
                BookId = bookId,
                FileId = file?.Id,
                SelectedText = h.SelectedText,
                NoteText = h.NoteText,
                Locator = file is null ? null : h.Locator,
                Color = h.Color,
                CreatedAt = h.CreatedAt,
                UpdatedAt = h.UpdatedAt,
                Revision = h.Revision,
            });
        }
        EtlV2Rows.Check(context, "annotations: highlight owner is not its upload's owner", notOwner);
        EtlV2Rows.Check(context, "annotations: anchor V2 cannot hold", unmappable);
        EtlV2Rows.Check(context, "annotations: blank text or a version below 1", invalid);
        return rows;
    }

    private static async Task CheckQuotesAsync(EtlV2Context context, List<AnnotationRow> annotations, bool written, CancellationToken ct)
    {
        var ids = annotations.Where(a => Scheme(a.Locator) == "textstack-anchor-v1").Select(a => a.Id).ToArray();
        var missing = written
            ? await EtlV2Rows.TargetAsync<Guid>(context, QuotesMissingInV2, new { ids }, ct)
            : await EtlV2Rows.SourceAsync<Guid>(context, QuotesMissingInLegacy, new { ids }, ct);
        EtlV2Rows.Check(context, "annotations: selected_text not in its chapter's plain_text", missing.Select(id => id.ToString()));
    }

    private static string? Scheme(string? locator) =>
        locator is null ? null : JsonDocument.Parse(locator).RootElement.GetProperty("scheme").GetString();

    private sealed record LegacyHighlight
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid? BookId { get; init; }
        public string SelectedText { get; init; } = "";
        public string? NoteText { get; init; }
        public string Color { get; init; } = "";
        public long Revision { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public bool AnchorIsObject { get; init; }
        public string? Locator { get; init; }
    }

    private sealed record StateRow
    {
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public Guid FileId { get; init; }
        public string CurrentLocator { get; init; } = "";
        public decimal BookFraction { get; init; }
        public string? FrontierLocator { get; init; }
        public decimal? FrontierFraction { get; init; }
        public DateTimeOffset? CompletedAt { get; init; }
        public DateTimeOffset ClientRecordedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public long Revision { get; init; } = 1;
        public long? ResetRevision { get; init; }
    }

    private sealed record AnnotationRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public Guid? FileId { get; init; }
        public string SelectedText { get; init; } = "";
        public string? NoteText { get; init; }
        public string? Locator { get; init; }
        public string Color { get; init; } = "";
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public DateTimeOffset? DeletedAt { get; init; }
        public long Revision { get; init; }
    }
}
