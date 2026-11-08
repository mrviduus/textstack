using Dapper;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Catalog pairs (v2-plan §5.2, ADR-031 D5, row 38): every (user, edition) with an intent row becomes a
/// <c>books</c> row with no file, id <see cref="EtlV2Ids.CatalogBook"/>, origin
/// <c>{"kind":"catalog","editionSlug":…}</c>, and title, author and language only (owner 2026-11-08: no
/// description, no cover). Its catalog highlights become unanchored annotations (row 43: text, note, colour;
/// no file, no locator). Catalog positions are not carried (D5). Conflict rule: insert what V2 lacks, leave
/// what is equal; a V2 row that differs is a failed check, never overwritten.
/// </summary>
public static class EtlV2Catalog
{
    private static readonly string[] IntentSources =
    [
        "user_libraries", "reading_progresses", "highlights", "vocabulary_words", "pending_vocabulary_words", "word_lookups",
        "word_clusters", "book_insight", "collections", "book_collections", "editions", "edition_authors", "authors",
    ];

    public static readonly EtlV2Step Step = new("catalog", IntentSources, ["books", "annotations"], RunAsync);

    // catalog-retirement-plan §3.4's intent query minus bookmarks (retired), one row per pair: created_at is
    // the pair's first intent by immutable creation times only; reading_progresses has none (updated_at moves, and
    // would make a re-run over a newer dump a mismatch), so a progress-only pair takes the edition's created_at. The retired tables (lookups, clusters, pending words, shelves) still select pairs
    // (owner 2026-11-08). Edition columns are NULL for a pair whose edition is gone (a shelf entry has no FK).
    private const string IntentPairs = """
        WITH intent(user_id, edition_id, at) AS (
            SELECT user_id, edition_id, created_at FROM user_libraries
            UNION ALL SELECT user_id, edition_id, NULL FROM reading_progresses
            UNION ALL SELECT user_id, edition_id, created_at FROM highlights WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM pending_vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, first_tapped_at FROM word_lookups WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM word_clusters WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM book_insight WHERE edition_id IS NOT NULL
            UNION ALL SELECT c.user_id, bc.book_id, bc.added_at FROM book_collections bc
                JOIN collections c ON c.id = bc.collection_id WHERE bc.book_type = 'savedbook')
        SELECT i.user_id, i.edition_id, COALESCE(min(i.at), e.created_at) AS created_at, e.id IS NOT NULL AS edition_exists, e.title, e.language,
            jsonb_build_object('kind', 'catalog', 'editionSlug', e.slug)::text AS origin,
            -- The first author by credit order; name and id break ties.
            (SELECT a.name FROM edition_authors ea JOIN authors a ON a.id = ea.author_id
             WHERE ea.edition_id = e.id ORDER BY ea."order", a.name, a.id LIMIT 1) AS author
        FROM intent i LEFT JOIN editions e ON e.id = i.edition_id
        GROUP BY i.user_id, i.edition_id, e.id, e.created_at
        ORDER BY i.user_id, i.edition_id
        """;

    // Upload highlights, and those with neither book (a deleted upload's trail), are M3.2's.
    private const string SelectLegacyHighlights = """
        SELECT id, user_id, edition_id, selected_text, note_text, color, version AS revision, created_at, updated_at
        FROM highlights WHERE user_book_id IS NULL AND edition_id IS NOT NULL ORDER BY id
        """;

    // The catalog books V2 holds, and any row under a planned id whatever its origin (then a mismatch, not a 23505).
    private const string SelectV2Books = """
        SELECT id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin::text AS origin,
               checkpoint_saving_enabled, revision, created_at, updated_at, removed_at
        FROM books
        WHERE origin->>'kind' = 'catalog' OR id = ANY(@ids)
        """;

    private const string InsertBook = """
        INSERT INTO books (id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin,
                           checkpoint_saving_enabled, revision, created_at, updated_at, removed_at)
        VALUES (@Id, @UserId, @Title, @Author, @Language, @Description, @Genre, @PublishedYear, @Tags, @CoverKey, CAST(@Origin AS jsonb),
                @CheckpointSavingEnabled, @Revision, @CreatedAt, @UpdatedAt, @RemovedAt)
        """;

    private const string SelectV2Annotations = """
        SELECT id, user_id, book_id, file_id, selected_text, note_text, locator::text AS locator, color, created_at, updated_at, deleted_at, revision
        FROM annotations
        WHERE book_id IN (SELECT id FROM books WHERE origin->>'kind' = 'catalog') OR id = ANY(@ids)
        """;

    private const string InsertAnnotation = """
        INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, deleted_at, revision)
        VALUES (@Id, @UserId, @BookId, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, @CreatedAt, @UpdatedAt, @DeletedAt, @Revision)
        """;

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var pairs = await EtlV2Rows.SourceAsync<IntentPair>(context, IntentPairs, null, ct);
        foreach (var p in pairs.Where(p => !p.EditionExists))
            context.OrphanCandidates.Add($"catalog_pairs {EtlV2Ids.CatalogBook(p.UserId, p.EditionId)}: edition {p.EditionId} is gone (a dangling shelf entry); not carried");
        var books = EtlV2Rows.Admit(context, "books (catalog)", pairs.Where(p => p.EditionExists).Select(BookOf), b => b.Id,
            ("blank edition title", b => string.IsNullOrWhiteSpace(b.Title)));

        var bookIds = books.Select(b => b.Id).ToHashSet();
        context.CatalogPairs = pairs.Where(p => p.EditionExists)
            .ToDictionary(p => (p.UserId, p.EditionId), p => bookIds.Contains(EtlV2Ids.CatalogBook(p.UserId, p.EditionId)));
        // A highlight's edition is an intent, so its pair is planned unless refused above (that check already fails the run).
        var annotations = EtlV2Rows.Admit(context, "annotations (catalog)",
            (await EtlV2Rows.SourceAsync<LegacyHighlight>(context, SelectLegacyHighlights, null, ct))
                .Select(h => AnnotationOf(h)).Where(a => bookIds.Contains(a.BookId)), a => a.Id,
            ("blank text or a version below 1", a => string.IsNullOrWhiteSpace(a.SelectedText) || a.Revision < 1));

        var ids = new { ids = books.Select(b => b.Id).ToArray() };
        var notes = new { ids = annotations.Select(a => a.Id).ToArray() };
        var bookPlan = EtlV2Rows.Plan(context, "books (catalog)", books, await EtlV2Rows.TargetAsync<BookRow>(context, SelectV2Books, ids, ct), b => b.Id);
        var annotationPlan = EtlV2Rows.Plan(context, "annotations (catalog)", annotations,
            await EtlV2Rows.TargetAsync<AnnotationRow>(context, SelectV2Annotations, notes, ct), a => a.Id);

        if (!context.MayWrite)
            return;
        await using (var tx = await context.BeginWriteAsync(ct))
        {
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertBook, bookPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.Connection.ExecuteAsync(new CommandDefinition(InsertAnnotation, annotationPlan.New, tx.Transaction, cancellationToken: ct));
            await tx.CommitAsync(ct);
        }

        // Plan §5.2 "completeness per intent pair": a pair is complete when its book and every annotation on it are in V2 as mapped.
        var booksAfter = EtlV2Rows.Classify(books, await EtlV2Rows.TargetAsync<BookRow>(context, SelectV2Books, ids, ct), b => b.Id);
        var notesAfter = EtlV2Rows.Classify(annotations, await EtlV2Rows.TargetAsync<AnnotationRow>(context, SelectV2Annotations, notes, ct), a => a.Id);
        EtlV2Rows.Check(context, "catalog: intent pair incomplete (its book or an annotation is not in V2 as mapped)",
            booksAfter.New.Concat(booksAfter.Different).Select(b => b.Id)
                .Concat(notesAfter.New.Concat(notesAfter.Different).Select(a => a.BookId))
                .Distinct().Select(id => id.ToString()));
    }

    private static BookRow BookOf(IntentPair p) => new()
    {
        Id = EtlV2Ids.CatalogBook(p.UserId, p.EditionId),
        UserId = p.UserId,
        Title = p.Title ?? "",
        Author = p.Author,
        Language = p.Language,
        Origin = p.Origin!,
        CreatedAt = p.CreatedAt,
        UpdatedAt = p.CreatedAt,
    };

    private static AnnotationRow AnnotationOf(LegacyHighlight h) => new()
    {
        Id = h.Id,
        UserId = h.UserId,
        BookId = EtlV2Ids.CatalogBook(h.UserId, h.EditionId),
        SelectedText = h.SelectedText,
        NoteText = h.NoteText,
        Color = h.Color,
        CreatedAt = h.CreatedAt,
        UpdatedAt = h.UpdatedAt,
        Revision = h.Revision,
    };

    private sealed record IntentPair
    {
        public Guid UserId { get; init; }
        public Guid EditionId { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public bool EditionExists { get; init; }
        public string? Title { get; init; }
        public string? Language { get; init; }
        public string? Origin { get; init; }
        public string? Author { get; init; }
    }

    private sealed record LegacyHighlight
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid EditionId { get; init; }
        public string SelectedText { get; init; } = "";
        public string? NoteText { get; init; }
        public string Color { get; init; } = "";
        public int Revision { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }

    /// <summary>A <c>books</c> row, every column: the defaults a catalog pair leaves (no description, cover, tags) are compared too.</summary>
    private sealed record BookRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Title { get; init; } = "";
        public string? Author { get; init; }
        public string? Language { get; init; }
        public string? Description { get; init; }
        public string? Genre { get; init; }
        public int? PublishedYear { get; init; }
        public string[] Tags { get; init; } = [];
        public string? CoverKey { get; init; }
        public string Origin { get; init; } = "";
        public bool CheckpointSavingEnabled { get; init; }
        public long Revision { get; init; } = 1;
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public DateTimeOffset? RemovedAt { get; init; }
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
