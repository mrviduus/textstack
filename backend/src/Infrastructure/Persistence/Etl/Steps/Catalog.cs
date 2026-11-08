using Dapper;
using Npgsql;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// M3.3 catalog pairs (v2-plan §5.2, ADR-031 D5): every (user, edition) with an intent row becomes a
/// <c>books</c> row with no file, id <see cref="EtlV2Ids.CatalogBook"/>, origin
/// <c>{"kind":"catalog","editionSlug":…}</c>; its catalog highlights become unanchored annotations
/// (text, note, colour; no file, no locator). Catalog positions are not carried (D5).
/// </summary>
public static class EtlV2Catalog
{
    public static readonly string[] SourceTables =
    [
        "user_libraries", "reading_progresses", "highlights", "vocabulary_words", "pending_vocabulary_words", "word_lookups",
        "word_clusters", "book_insight", "collections", "book_collections", "editions", "edition_authors", "authors",
    ];

    public static readonly string[] TargetTables = ["books", "annotations"];

    public static readonly EtlV2Step Step = new("catalog", RunAsync);

    // catalog-retirement-plan §3.4's intent query minus bookmarks (retired), one row per pair: created_at
    // is the pair's first intent. Edition columns are NULL for a pair whose edition is gone (a savedbook
    // shelf entry has no FK).
    internal const string IntentPairs = """
        WITH intent(user_id, edition_id, at) AS (
            SELECT user_id, edition_id, created_at FROM user_libraries
            UNION ALL SELECT user_id, edition_id, updated_at FROM reading_progresses
            UNION ALL SELECT user_id, edition_id, created_at FROM highlights WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM pending_vocabulary_words WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, first_tapped_at FROM word_lookups WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM word_clusters WHERE edition_id IS NOT NULL
            UNION ALL SELECT user_id, edition_id, created_at FROM book_insight WHERE edition_id IS NOT NULL
            UNION ALL SELECT c.user_id, bc.book_id, bc.added_at FROM book_collections bc
                JOIN collections c ON c.id = bc.collection_id WHERE bc.book_type = 'savedbook')
        SELECT i.user_id, i.edition_id, min(i.at) AS created_at, e.id IS NOT NULL AS edition_exists, e.slug, e.title, e.language,
            -- The first author by credit order; name and id break ties.
            (SELECT a.name FROM edition_authors ea JOIN authors a ON a.id = ea.author_id
             WHERE ea.edition_id = e.id ORDER BY ea."order", a.name, a.id LIMIT 1) AS author
        FROM intent i LEFT JOIN editions e ON e.id = i.edition_id
        GROUP BY i.user_id, i.edition_id, e.id
        ORDER BY i.user_id, i.edition_id
        """;

    // Upload highlights are M3.2's. One with neither book lost its edition or its upload.
    private const string CatalogHighlights = """
        SELECT id, user_id, edition_id, selected_text, note_text, color, version, created_at, updated_at
        FROM highlights WHERE user_book_id IS NULL ORDER BY id
        """;

    private const string SelectBooks = """
        SELECT id, user_id, title, author, language,
            -- NULL unless origin is exactly a catalog origin, so any other shape is a mismatch.
            CASE WHEN origin = jsonb_build_object('kind', 'catalog', 'editionSlug', origin->>'editionSlug') THEN origin->>'editionSlug' END AS edition_slug,
            description, genre, published_year, cover_key, cardinality(tags) AS tag_count, checkpoint_saving_enabled,
            created_at, updated_at, removed_at, revision
        FROM books WHERE id = ANY(@ids)
        """;

    private const string InsertBook = """
        INSERT INTO books (id, user_id, title, author, language, origin, created_at, updated_at)
        VALUES (@Id, @UserId, @Title, @Author, @Language, jsonb_build_object('kind', 'catalog', 'editionSlug', @EditionSlug), @CreatedAt, @UpdatedAt)
        """;

    private const string SelectAnnotations = """
        SELECT id, user_id, book_id, file_id, selected_text, note_text, locator::text AS locator, color, created_at, updated_at, deleted_at, revision
        FROM annotations WHERE id = ANY(@ids)
        """;

    private const string InsertAnnotation = """
        INSERT INTO annotations (id, user_id, book_id, selected_text, note_text, color, created_at, updated_at, revision)
        VALUES (@Id, @UserId, @BookId, @SelectedText, @NoteText, @Color, @CreatedAt, @UpdatedAt, @Revision)
        """;

    private static Task RunAsync(EtlV2Context context, CancellationToken ct) => EtlV2Rows.InTargetAsync(context, async tx =>
    {
        var source = context.Source;
        var users = await EtlV2Rows.KnownUsersAsync(context, tx, ct);
        var pairs = (await source.Connection!.QueryAsync<IntentPair>(new CommandDefinition(IntentPairs, transaction: source, cancellationToken: ct))).AsList();
        EtlV2Rows.Orphans(context, "catalog_pairs", pairs.Where(p => !users.Contains(p.UserId) || !p.EditionExists)
            .Select(p => (EtlV2Ids.CatalogBook(p.UserId, p.EditionId),
                !p.EditionExists ? $"edition {p.EditionId} is gone" : $"user {p.UserId} is not in the target")));
        var carried = pairs.Where(p => users.Contains(p.UserId) && p.EditionExists).ToList();
        EtlV2Rows.Unmappable(context, "books", [.. carried.Where(p => string.IsNullOrWhiteSpace(p.Title))
            .Select(p => (EtlV2Ids.CatalogBook(p.UserId, p.EditionId), "blank edition title"))]);
        var books = carried.Where(p => !string.IsNullOrWhiteSpace(p.Title)).Select(BookOf).ToList();

        var highlights = (await source.Connection!.QueryAsync<LegacyHighlight>(new CommandDefinition(CatalogHighlights, transaction: source, cancellationToken: ct))).AsList();
        var bookIds = books.Select(b => b.Id).ToHashSet();
        var planned = new List<CatalogAnnotation>();
        var orphans = new List<(Guid, string)>();
        var unmappable = new List<(Guid, string)>();
        foreach (var h in highlights)
        {
            if (h.EditionId is not { } editionId)
                orphans.Add((h.Id, "no book: its edition or upload was deleted"));
            else if (!users.Contains(h.UserId))
                orphans.Add((h.Id, $"user {h.UserId} is not in the target"));
            else if (!bookIds.Contains(EtlV2Ids.CatalogBook(h.UserId, editionId)))
                orphans.Add((h.Id, "its catalog pair is not carried"));
            else if (string.IsNullOrWhiteSpace(h.SelectedText))
                unmappable.Add((h.Id, "blank selected_text"));
            else if (h.Version < 1)
                unmappable.Add((h.Id, "version below 1"));
            else
                planned.Add(new CatalogAnnotation
                {
                    Id = h.Id,
                    UserId = h.UserId,
                    BookId = EtlV2Ids.CatalogBook(h.UserId, editionId),
                    SelectedText = h.SelectedText,
                    NoteText = h.NoteText,
                    Color = h.Color,
                    CreatedAt = h.CreatedAt,
                    UpdatedAt = h.UpdatedAt,
                    Revision = h.Version,
                });
        }
        EtlV2Rows.Orphans(context, "highlights", orphans);
        EtlV2Rows.Unmappable(context, "annotations", unmappable);

        await EtlV2Rows.ConvergeAsync(context, tx, "books", books, b => b.Id, SelectBooks, InsertBook, ct);
        await EtlV2Rows.ConvergeAsync(context, tx, "annotations", planned, a => a.Id, SelectAnnotations, InsertAnnotation, ct);
        if (!context.DryRun)
            context.Checks.Add(new("catalog.intent-pairs-complete", await IncompletePairsAsync(tx, books, planned, ct)));
    }, ct);

    /// <summary>Pairs whose book row, or any of whose annotations, is not in the target as mapped (§5.2 completeness per intent pair).</summary>
    private static async Task<int> IncompletePairsAsync(NpgsqlTransaction tx, List<CatalogBook> books, List<CatalogAnnotation> annotations, CancellationToken ct)
    {
        var storedBooks = await EtlV2Rows.ReadAsync<CatalogBook>(tx, SelectBooks, [.. books.Select(b => b.Id)], b => b.Id, ct);
        var storedNotes = await EtlV2Rows.ReadAsync<CatalogAnnotation>(tx, SelectAnnotations, [.. annotations.Select(a => a.Id)], a => a.Id, ct);
        var badBooks = annotations.Where(a => !storedNotes.TryGetValue(a.Id, out var s) || s != a).Select(a => a.BookId).ToHashSet();
        return books.Count(b => !storedBooks.TryGetValue(b.Id, out var s) || s != b || badBooks.Contains(b.Id));
    }

    private static CatalogBook BookOf(IntentPair p) => new()
    {
        Id = EtlV2Ids.CatalogBook(p.UserId, p.EditionId),
        UserId = p.UserId,
        Title = p.Title!,
        Author = p.Author,
        Language = p.Language,
        EditionSlug = p.Slug,
        CreatedAt = p.CreatedAt,
        UpdatedAt = p.CreatedAt,
    };

    internal sealed record IntentPair
    {
        public Guid UserId { get; init; }
        public Guid EditionId { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public bool EditionExists { get; init; }
        public string? Slug { get; init; }
        public string? Title { get; init; }
        public string? Language { get; init; }
        public string? Author { get; init; }
    }

    private sealed record LegacyHighlight
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid? EditionId { get; init; }
        public string SelectedText { get; init; } = "";
        public string? NoteText { get; init; }
        public string Color { get; init; } = "";
        public int Version { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
    }

    /// <summary>A catalog book as stored: every column, the defaults included, so any drift is a mismatch.</summary>
    internal sealed record CatalogBook
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Title { get; init; } = "";
        public string? Author { get; init; }
        public string? Language { get; init; }
        public string? EditionSlug { get; init; }
        public string? Description { get; init; }
        public string? Genre { get; init; }
        public int? PublishedYear { get; init; }
        public string? CoverKey { get; init; }
        public int TagCount { get; init; }
        public bool CheckpointSavingEnabled { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public DateTimeOffset? RemovedAt { get; init; }
        public long Revision { get; init; } = 1;
    }

    internal sealed record CatalogAnnotation
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
