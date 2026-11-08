namespace Infrastructure.Persistence.Etl;

/// <summary>
/// The <c>books</c> and <c>annotations</c> rows two steps write (uploads, catalog pairs): one column list, one
/// INSERT, one record each. A step adds only its WHERE to the SELECT.
/// </summary>
internal static class EtlV2BookRows
{
    public const string SelectBooks = """
        SELECT id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin::text AS origin,
               checkpoint_saving_enabled, revision, created_at, updated_at, removed_at
        FROM books
        """;

    public const string InsertBook = """
        INSERT INTO books (id, user_id, title, author, language, description, genre, published_year, tags, cover_key, origin,
                           checkpoint_saving_enabled, revision, created_at, updated_at, removed_at)
        VALUES (@Id, @UserId, @Title, @Author, @Language, @Description, @Genre, @PublishedYear, @Tags, @CoverKey, CAST(@Origin AS jsonb),
                @CheckpointSavingEnabled, @Revision, @CreatedAt, @UpdatedAt, @RemovedAt)
        """;

    public const string SelectAnnotations = """
        SELECT id, user_id, book_id, file_id, selected_text, note_text, locator::text AS locator, color, created_at, updated_at, deleted_at, revision
        FROM annotations
        """;

    public const string InsertAnnotation = """
        INSERT INTO annotations (id, user_id, book_id, file_id, selected_text, note_text, locator, color, created_at, updated_at, deleted_at, revision)
        VALUES (@Id, @UserId, @BookId, @FileId, @SelectedText, @NoteText, CAST(@Locator AS jsonb), @Color, @CreatedAt, @UpdatedAt, @DeletedAt, @Revision)
        """;

    /// <summary>What V2's annotation CHECKs refuse (<c>ck_annotations_selected_text</c>, <c>ck_annotations_revision</c>).</summary>
    public const string BlankOrUnversioned = "blank text or a version below 1";

    public static bool IsBlankOrUnversioned(string selectedText, long revision) => string.IsNullOrWhiteSpace(selectedText) || revision < 1;
}

/// <summary>A <c>books</c> row, every column: the defaults a catalog pair leaves (no description, cover, tags) are compared too.</summary>
internal sealed record BookRow
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

internal sealed record AnnotationRow
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
