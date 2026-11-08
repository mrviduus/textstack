using Application.Sync;

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

    // Annotations of catalog pairs' books are the catalog step's (M3.3); a row under a mapped id is read wherever it hangs.
    private const string SelectV2Annotations = EtlV2BookRows.SelectAnnotations + """

        WHERE book_id NOT IN (SELECT id FROM books WHERE origin->>'kind' = 'catalog') OR id = ANY(@ids)
        """;

    // Plan §5.2 validation part 3: an anchored upload annotation's text is in its chapter's plain_text, legacy's
    // (V2's are their md5 copies). Owner 2026-11-08: every whitespace run collapses to one space on both sides
    // before comparing (a selection spans line breaks the text keeps); otherwise strict (no trim, no case
    // folding). Each chapter is normalized once, however many highlights it holds.
    private const string QuotesMissing = """
        WITH h AS (SELECT id, user_book_id, user_chapter_id, selected_text FROM highlights WHERE id = ANY(@ids)),
             c AS MATERIALIZED (
                 SELECT id, user_book_id, regexp_replace(plain_text, '\s+', ' ', 'g') AS text
                 FROM user_chapters WHERE id IN (SELECT user_chapter_id FROM h))
        SELECT h.id FROM h
        LEFT JOIN c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
        WHERE c.id IS NULL OR strpos(c.text, regexp_replace(h.selected_text, '\s+', ' ', 'g')) = 0
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
            // No locator V2 can resume from (a percent or a "read" mark alone), or one that does not fit the file (a page on a non-PDF):
            // the chapter slug if legacy has one, else a failed check.
            var locator = b.CurrentLocator is null || SyncValidation.FitsFile(Scheme(b.CurrentLocator), file.Format, "current_locator") is not null
                ? b.SlugLocator : b.CurrentLocator;
            if (locator is null)
            {
                unmappable.Add(b.Id.ToString());
                continue;
            }
            // Shortest round-trip digits, as sessions and vocabulary carry a double (Postgres's ::numeric keeps 15). Negated, so NaN is outside too.
            var fraction = b.BookFraction is { } percent && percent is >= 0 and <= 1 ? EtlV2Rows.Numeric(percent) : 0;
            if (b.BookFraction is { } p && !(p is >= 0 and <= 1))
                outOfRange.Add(b.Id.ToString());
            rows.Add(new StateRow
            {
                UserId = b.UserId,
                BookId = b.Id,
                FileId = file.Id,
                CurrentLocator = locator,
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
        // Unlike EtlV2Rows.Admit, a refused row stays in the mapped rows: a dry run's Writes count it as "would insert"
        // (the run fails on the check before any write). M3.4's report reader must not compare the two dialects' counts.
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
            if (!h.AnchorIsObject || (file is not null && SyncValidation.FitsFile(Scheme(h.Locator), file.Format, "locator") is not null))
                unmappable.Add(h.Id.ToString());
            if (EtlV2BookRows.IsBlankOrUnversioned(h.SelectedText, h.Revision))
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
        EtlV2Rows.Check(context, $"annotations: {EtlV2BookRows.BlankOrUnversioned}", invalid);
        return rows;
    }

    private static async Task CheckQuotesAsync(EtlV2Context context, List<AnnotationRow> annotations, CancellationToken ct)
    {
        var ids = annotations.Where(a => Scheme(a.Locator) == "textstack-anchor-v1").Select(a => a.Id).ToArray();
        var missing = await EtlV2Rows.SourceAsync<Guid>(context, QuotesMissing, new { ids }, ct);
        EtlV2Rows.Check(context, "annotations: selected_text not in its chapter's plain_text", missing.Select(id => id.ToString()));
    }

    private static string? Scheme(string? locator) => locator is null ? null : SyncValidation.SchemeOf(locator);

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
}
