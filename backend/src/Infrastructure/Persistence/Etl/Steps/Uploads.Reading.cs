using System.Text.Json;
using Application.Sync;
using Contracts.V2;

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

    /// <summary>
    /// #1150: a reflow anchor's <c>startOffset</c>/<c>endOffset</c> as a jsonb object to merge over it (over
    /// <c>h.anchor_json</c>, against chapter <c>c</c>). Valid integer offsets (V2's <c>IsOffset</c>, <c>end ≥ start</c>):
    /// <c>{}</c>, carried as they are. Else computed from <c>c.plain_text</c>: the first match of prefix+exact+suffix, then
    /// prefix+exact, exact+suffix, exact alone (the readers' <c>findWithContext</c> order), each part matched under the
    /// quote check's normalization (any whitespace run matches any run; whitespace before closing punctuation is
    /// optional); <c>startOffset</c> = where exact's match starts, <c>endOffset</c> = where it ends. Exact's leading and
    /// trailing whitespace tokens (and the optional whitespace before a leading closing punctuation) sit outside the
    /// captured group, so the offsets span exact's first to last non-whitespace character, never a run before or
    /// after it. Not found: <c>{}</c>. The four tiers are a COALESCE chain (evaluated until the first hit); the end is
    /// one anchored re-match of the group at the start found (the group's match from a given start is unique).
    /// Computed only within V2's own caps (exact 1..4000 code points, prefix/suffix ≤ 32; literals here, as SQL
    /// cannot read <see cref="SyncLimits"/>): a longer quote can pass Postgres's regex size limit (2201B, ~8000
    /// whitespace runs) and abort the run, and V2 refuses such an anchor on edit anyway, so it is carried and listed
    /// instead (<see cref="AnchorRefusals"/>).
    /// ponytail: positions are Postgres characters (code points), not the UTF-16 units of the protocol: past an astral
    /// character they run short by one per pair. Exact alone takes the first occurrence (the readers score every one by
    /// context): the readers re-find the quote before trusting stored offsets. NBSP is not <c>\s</c> in the DB locale,
    /// as strict as the quote check. No per-row timeout: a 4000-character quote at the end of 500k of repeated text
    /// took ~39 s, realistic text 0.24 s at 300k; the rehearsal shows real timings. Offsets are hints (clients
    /// re-verify; the server checks only the shape). validate-etl.sql restates it verbatim (a test asserts so).
    /// </summary>
    internal const string AnchorOffsets = """
        SELECT COALESCE(
            CASE WHEN h.anchor_json ->> 'startOffset' ~ '^[0-9]+$' AND h.anchor_json ->> 'endOffset' ~ '^[0-9]+$'
                      AND jsonb_typeof(h.anchor_json -> 'startOffset') = 'number' AND jsonb_typeof(h.anchor_json -> 'endOffset') = 'number'
                 THEN CASE WHEN (h.anchor_json ->> 'endOffset')::numeric BETWEEN (h.anchor_json ->> 'startOffset')::numeric AND 2147483647 THEN '{}'::jsonb END END,
            (SELECT jsonb_build_object('startOffset', s.pos - 1,
                                       'endOffset', s.pos - 1 + char_length(substring(substr(c.plain_text, s.pos) FROM '^' || g.grp)))
             FROM (SELECT array_agg(regexp_replace(regexp_replace(regexp_replace(regexp_replace(COALESCE(u.s, ''),
                              '\s+(?=[]).,;:!?…}»”’›])', '', 'g'), '([^\w\s])', '\\\1', 'g'), '\\([]).,;:!?…}»”’›])', '\\s*\\\1', 'g'), '\s+', '\\s+', 'g')
                          ORDER BY u.i) AS p
                   FROM unnest(ARRAY[h.anchor_json ->> 'prefix', h.anchor_json ->> 'exact', h.anchor_json ->> 'suffix']) WITH ORDINALITY u(s, i)) q,
                  LATERAL (SELECT COALESCE(substring(q.p[2] FROM '^\\s[+*]'), '') AS lead, regexp_replace(q.p[2], '^\\s[+*]', '') AS rest) r,
                  LATERAL (SELECT r.lead, regexp_replace(r.rest, '\\s\+$', '') AS grp, COALESCE(substring(r.rest FROM '\\s\+$'), '') AS trail) g,
                  LATERAL (SELECT CASE WHEN jsonb_typeof(h.anchor_json -> 'exact') = 'string' AND char_length(h.anchor_json ->> 'exact') BETWEEN 1 AND 4000
                                            AND char_length(COALESCE(h.anchor_json ->> 'prefix', '')) <= 32 AND char_length(COALESCE(h.anchor_json ->> 'suffix', '')) <= 32
                                       THEN COALESCE(
                                           NULLIF(regexp_instr(c.plain_text, q.p[1] || g.lead || '(' || g.grp || ')' || g.trail || q.p[3], 1, 1, 0, '', 1), 0),
                                           NULLIF(regexp_instr(c.plain_text, q.p[1] || g.lead || '(' || g.grp || ')' || g.trail, 1, 1, 0, '', 1), 0),
                                           NULLIF(regexp_instr(c.plain_text, g.lead || '(' || g.grp || ')' || g.trail || q.p[3], 1, 1, 0, '', 1), 0),
                                           NULLIF(regexp_instr(c.plain_text, g.lead || '(' || g.grp || ')' || g.trail, 1, 1, 0, '', 1), 0)) END AS pos) s
             WHERE s.pos IS NOT NULL),
            '{}') AS offsets
        """;

    // Upload highlights, and the ones with no book at all (a deleted upload's trail); catalog ones are M3.3's.
    // The locator, built here so jsonb prints it as the target will: a PDF anchor as-is; a reflow anchor with
    // chapterId replaced by its chapter's key (ADR-031 item 6) and its offsets as AnchorOffsets gives them;
    // a reflow anchor whose chapter is gone has none.
    private const string SelectLegacyHighlights = """
        SELECT h.id, h.user_id, h.user_book_id AS book_id, h.selected_text, h.note_text, h.color, h.version AS revision, h.created_at, h.updated_at,
               jsonb_typeof(h.anchor_json) = 'object' AS anchor_is_object,
               CASE
                   WHEN jsonb_typeof(h.anchor_json) <> 'object' THEN NULL
                   WHEN h.anchor_json ->> 'kind' = 'pdf'
                       THEN jsonb_build_object('version', 1, 'scheme', 'pdf-page', 'value', h.anchor_json)
                   WHEN c.id IS NOT NULL
                       THEN jsonb_build_object('version', 1, 'scheme', 'textstack-anchor-v1',
                            'value', (h.anchor_json - 'chapterId') || o.offsets || jsonb_build_object('chapterKey', COALESCE(c.slug, 'ch-' || c.chapter_number)))
               END::text AS locator
        FROM highlights h
        LEFT JOIN user_chapters c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
        CROSS JOIN LATERAL (
        """ + AnchorOffsets + """
        ) o
        WHERE h.user_book_id IS NOT NULL OR h.edition_id IS NULL
        ORDER BY h.id
        """;

    // Annotations of catalog pairs' books are the catalog step's (M3.3); a row under a mapped id is read wherever it hangs.
    private const string SelectV2Annotations = EtlV2BookRows.SelectAnnotations + """

        WHERE book_id NOT IN (SELECT id FROM books WHERE origin->>'kind' = 'catalog') OR id = ANY(@ids)
        """;

    // Plan §5.2 validation part 3: an anchored upload annotation's text is in its chapter's plain_text, legacy's
    // (V2's are their md5 copies). Owner 2026-11-08: every whitespace run collapses to one space on both sides
    // before comparing (a selection spans line breaks the text keeps); owner 2026-11-09: whitespace before closing
    // punctuation is dropped on both sides too (an html→text artifact, "flow ." vs "flow."); otherwise strict (no
    // trim, no case folding). Each chapter is normalized once, however many highlights it holds.
    private const string QuotesMissing = """
        WITH h AS (SELECT id, user_book_id, user_chapter_id, selected_text FROM highlights WHERE id = ANY(@ids)),
             c AS MATERIALIZED (
                 SELECT id, user_book_id, regexp_replace(regexp_replace(plain_text, '\s+', ' ', 'g'), '\s+(?=[]).,;:!?…}»”’›])', '', 'g') AS text
                 FROM user_chapters WHERE id IN (SELECT user_chapter_id FROM h))
        SELECT h.id FROM h
        LEFT JOIN c ON c.id = h.user_chapter_id AND c.user_book_id = h.user_book_id
        WHERE c.id IS NULL OR strpos(c.text, regexp_replace(regexp_replace(h.selected_text, '\s+', ' ', 'g'), '\s+(?=[]).,;:!?…}»”’›])', '', 'g')) = 0
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
            if (file is not null && Scheme(h.Locator) == "textstack-anchor-v1")
                foreach (var reason in AnchorRefusals(h.Locator!))
                    context.OrphanCandidates.Add($"highlights {h.Id}: anchor V2 refuses on edit ({reason}); carried as legacy had it");
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

    // validate-etl.sql's anchor_refusal holds the same literals, byte for byte.
    internal const string RefusedQuote = "quote not in its chapter's text, no valid offsets";
    internal const string RefusedContext = "prefix or suffix missing, not a string or over 32 characters";
    internal const string RefusedExact = "exact missing, not a string, empty or over 4000 characters";
    internal const string RefusedChapterKey = "chapter key blank or over 200 UTF-16 units";

    /// <summary>
    /// What V2's write rule (SyncValidation's textstack-anchor-v1 rule: chapterKey non-blank ≤ 200 UTF-16 units, exact
    /// 1..4000 code points, prefix/suffix 0..32, int32 offsets ≥ 0 with end ≥ start) refuses in a mapped locator, one
    /// reason each. The quote reason only where <see cref="AnchorOffsets"/> looked for the quote (within the caps) and
    /// found none. Lengths are counted as SQL's char_length counts them (code points), so validate-etl agrees.
    /// </summary>
    private static IEnumerable<string> AnchorRefusals(string locator)
    {
        using var json = JsonDocument.Parse(locator);
        var value = json.RootElement.GetProperty("value");
        if (!value.TryGetProperty("chapterKey", out var key) || key.ValueKind != JsonValueKind.String
            || SyncValidation.RequiredText(key.GetString(), "chapterKey", SyncLimits.MaxChapterKey) is not null)
            yield return RefusedChapterKey;
        var exact = IsText(value, "exact", 1, SyncLimits.MaxSelectedText);
        if (!exact)
            yield return RefusedExact;
        if (!IsText(value, "prefix", 0, SyncLimits.MaxContextCodePoints) || !IsText(value, "suffix", 0, SyncLimits.MaxContextCodePoints))
            yield return RefusedContext;
        var offsets = Offset(value, "startOffset") is { } start && Offset(value, "endOffset") is { } end && end >= start;
        if (!offsets && exact && SqlLength(value, "prefix") <= SyncLimits.MaxContextCodePoints && SqlLength(value, "suffix") <= SyncLimits.MaxContextCodePoints)
            yield return RefusedQuote;

        static bool IsText(JsonElement value, string member, int min, int max) =>
            value.TryGetProperty(member, out var s) && s.ValueKind == JsonValueKind.String && s.GetString()!.EnumerateRunes().Count() is var n && n >= min && n <= max;

        // char_length(COALESCE(value ->> member, '')), as AnchorOffsets bounds it: code points of the string, or of the
        // member's JSON text as Postgres prints it (the locator is jsonb's own print, so GetRawText is that text).
        static int SqlLength(JsonElement value, string member) =>
            !value.TryGetProperty(member, out var s) || s.ValueKind == JsonValueKind.Null ? 0
            : (s.ValueKind == JsonValueKind.String ? s.GetString()! : s.GetRawText()).EnumerateRunes().Count();

        static int? Offset(JsonElement value, string member) =>
            value.TryGetProperty(member, out var n) && n.ValueKind == JsonValueKind.Number && n.TryGetInt32(out var i) && i >= 0 ? i : null;
    }

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
