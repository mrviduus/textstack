using Application.Vocabulary;
using Dapper;
using Domain.Vocabulary;
using Npgsql;

namespace Infrastructure.Persistence.Etl.Steps;

/// <summary>
/// M3.3 vocabulary (ADR-031 decided item 4): legacy cards that share <c>(user, language, word_key)</c>
/// merge onto one survivor (<see cref="Survivor"/>); each legacy card's sentence becomes an example of
/// the survivor, each legacy review a review of it. Payload hashes go through
/// <see cref="VocabularyPayloads"/>, the API's functions. Not carried: the losing cards' own fields,
/// <c>total_reviews</c>/<c>correct_reviews</c> (derived from reviews), clusters, tutor, embeddings (D6).
/// </summary>
public static class EtlV2Vocabulary
{
    public static readonly string[] SourceTables = ["vocabulary_words", "vocabulary_reviews", "chapters", "user_books"];

    public static readonly string[] TargetTables = ["vocabulary_words", "vocabulary_examples", "vocabulary_reviews"];

    public static readonly EtlV2Step Step = new("vocabulary", RunAsync);

    // A catalog chapter is named by decided item 6's fallback key.
    private const string LegacyWords = """
        SELECT w.id, w.user_id, w.language, w.word, w.translation, w.definition, w.edition_id, w.user_book_id, w.sentence, w.book_title,
            COALESCE(c.slug, 'ch-' || c.chapter_number) AS chapter_key,
            w.stage, w.interval_days, w.consecutive_correct, w.next_review_at, w.last_reviewed_at, w.total_reviews,
            w.created_at, w.updated_at, w.is_retired, w.retired_at
        FROM vocabulary_words w LEFT JOIN chapters c ON c.id = w.chapter_id
        ORDER BY w.id
        """;

    private const string LegacyReviews = """
        SELECT id, vocabulary_word_id, user_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, created_at
        FROM vocabulary_reviews ORDER BY id
        """;

    private const string UploadOwners = "SELECT id, user_id FROM user_books";

    private const string SelectWords = """
        SELECT id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, created_at, updated_at, deleted_at, retired_at, revision
        FROM vocabulary_words WHERE id = ANY(@ids)
        """;

    // Another card under a planned key is a mismatch to report, not a unique violation to die on.
    private const string SelectWordKeys = "SELECT id, user_id, language, word_key FROM vocabulary_words";

    private const string InsertWord = """
        INSERT INTO vocabulary_words (id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, created_at, updated_at, retired_at)
        VALUES (@Id, @UserId, @Language, @Word, @WordKey, @Translation, @Definition, @Stage, @IntervalDays, @ConsecutiveCorrect,
            @NextReviewAt, @LastReviewedAt, @CreatedAt, @UpdatedAt, @RetiredAt)
        """;

    private const string SelectExamples = """
        SELECT id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at, deleted_at
        FROM vocabulary_examples WHERE id = ANY(@ids)
        """;

    private const string InsertExample = """
        INSERT INTO vocabulary_examples (id, user_id, word_id, book_id, chapter_key, book_title, sentence, operation_id, payload_sha256, created_at)
        VALUES (@Id, @UserId, @WordId, @BookId, @ChapterKey, @BookTitle, @Sentence, @OperationId, @PayloadSha256, @CreatedAt)
        """;

    private const string SelectReviews = """
        SELECT id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at
        FROM vocabulary_reviews WHERE id = ANY(@ids)
        """;

    private const string InsertReview = """
        INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at)
        VALUES (@Id, @UserId, @WordId, @OperationId, @PayloadSha256, @ReviewMode, @IsCorrect, @ResponseTimeMs, @StageBefore, @StageAfter, @ClientRecordedAt, @CreatedAt)
        """;

    private const string ReviewCounts = "SELECT word_id, count(*) FROM vocabulary_reviews WHERE word_id = ANY(@ids) GROUP BY word_id";

    /// <summary>
    /// The card a case-variant group keeps (ADR-031 decided item 4): the higher <c>total_reviews</c>,
    /// tie → the newer <c>updated_at</c>, tie → the lower id (so a full tie is still deterministic).
    /// </summary>
    internal static LegacyWord Survivor(IEnumerable<LegacyWord> group) =>
        group.OrderByDescending(w => w.TotalReviews).ThenByDescending(w => w.UpdatedAt).ThenBy(w => w.Id.ToString("D"), StringComparer.Ordinal).First();

    private static Task RunAsync(EtlV2Context context, CancellationToken ct) => EtlV2Rows.InTargetAsync(context, async tx =>
    {
        var source = context.Source;
        var users = await EtlV2Rows.KnownUsersAsync(context, tx, ct);
        var words = (await source.Connection!.QueryAsync<LegacyWord>(new CommandDefinition(LegacyWords, transaction: source, cancellationToken: ct))).AsList();
        var reviews = (await source.Connection!.QueryAsync<LegacyReview>(new CommandDefinition(LegacyReviews, transaction: source, cancellationToken: ct))).AsList();
        var uploadOwner = (await source.Connection!.QueryAsync<(Guid Id, Guid UserId)>(new CommandDefinition(UploadOwners, transaction: source, cancellationToken: ct)))
            .ToDictionary(b => b.Id, b => b.UserId);

        EtlV2Rows.Orphans(context, "vocabulary_words", words.Where(w => !users.Contains(w.UserId)).Select(w => (w.Id, $"user {w.UserId} is not in the target")));
        var unmappable = new List<(Guid, string)>();
        var carried = new List<LegacyWord>();
        foreach (var w in words.Where(w => users.Contains(w.UserId)))
        {
            var reason = WordKeys.Language(w.Language) == "" ? "blank language"
                : WordKeys.Of(w.Word) == "" ? "blank word"
                : w.Stage < 0 || w.IntervalDays < 0 || w.ConsecutiveCorrect < 0 ? "negative SRS field"
                : w.UserBookId is { } ub && uploadOwner[ub] != w.UserId ? "its upload belongs to another user"
                : null;
            if (reason is null) carried.Add(w);
            else unmappable.Add((w.Id, reason));
        }
        EtlV2Rows.Unmappable(context, "vocabulary_words", unmappable);

        // legacy card id → the survivor's card
        var cardOf = new Dictionary<Guid, PlannedWord>();
        var planned = new List<PlannedWord>();
        var examples = new List<PlannedExample>();
        foreach (var group in carried.GroupBy(w => (w.UserId, Language: WordKeys.Language(w.Language), Key: WordKeys.Of(w.Word))))
        {
            var card = WordOf(Survivor(group), group.Key.Language, group.Key.Key);
            planned.Add(card);
            foreach (var w in group)
            {
                cardOf[w.Id] = card;
                if (!string.IsNullOrWhiteSpace(w.Sentence))
                    examples.Add(ExampleOf(card, w));
            }
        }

        var reviewRows = new List<PlannedReview>();
        var badReviews = new List<(Guid, string)>();
        var orphanReviews = new List<(Guid, string)>();
        foreach (var r in reviews)
        {
            if (!cardOf.TryGetValue(r.VocabularyWordId, out var card))
            {
                if (users.Contains(r.UserId))
                    badReviews.Add((r.Id, $"its card {r.VocabularyWordId} is not carried"));
                else
                    orphanReviews.Add((r.Id, $"user {r.UserId} is not in the target"));
                continue;
            }
            var reason = r.UserId != card.UserId ? "another user's card"
                : string.IsNullOrWhiteSpace(r.ReviewMode) ? "blank review_mode"
                : r.ResponseTimeMs < 0 || r.StageBefore < 0 || r.StageAfter < 0 ? "negative field"
                : null;
            if (reason is null) reviewRows.Add(ReviewOf(card, r));
            else badReviews.Add((r.Id, reason));
        }
        EtlV2Rows.Unmappable(context, "vocabulary_reviews", badReviews);
        EtlV2Rows.Orphans(context, "vocabulary_reviews", orphanReviews);

        var held = await ReportKeyCollisionsAsync(context, tx, planned, ct);
        planned.RemoveAll(w => held.Contains(w.Id));
        examples.RemoveAll(e => held.Contains(e.WordId));
        reviewRows.RemoveAll(r => held.Contains(r.WordId));
        await EtlV2Rows.ConvergeAsync(context, tx, "vocabulary_words", planned, w => w.Id, SelectWords, InsertWord, ct);
        await EtlV2Rows.ConvergeAsync(context, tx, "vocabulary_examples", examples, e => e.Id, SelectExamples, InsertExample, ct);
        await EtlV2Rows.ConvergeAsync(context, tx, "vocabulary_reviews", reviewRows, r => r.Id, SelectReviews, InsertReview, ct);
        if (context.DryRun)
            return;

        var stored = await EtlV2Rows.ReadAsync<PlannedWord>(tx, SelectWords, [.. planned.Select(w => w.Id)], w => w.Id, ct);
        context.Checks.Add(new("vocabulary.srs-fields-equal", planned.Count(w => !stored.TryGetValue(w.Id, out var s) || Srs(s) != Srs(w))));
        // Expected from the source rows (every legacy review of the group), not from the plan.
        var expected = reviews.Where(r => cardOf.ContainsKey(r.VocabularyWordId)).GroupBy(r => cardOf[r.VocabularyWordId].Id).ToDictionary(g => g.Key, g => (long)g.Count());
        var actual = (await tx.Connection!.QueryAsync<(Guid WordId, long Count)>(new CommandDefinition(ReviewCounts, new { ids = planned.Select(w => w.Id).ToArray() }, tx, cancellationToken: ct)))
            .ToDictionary(c => c.WordId, c => c.Count);
        context.Checks.Add(new("vocabulary.review-counts-equal",
            planned.Count(w => expected.GetValueOrDefault(w.Id) != actual.GetValueOrDefault(w.Id))));
    }, ct);

    /// <summary>Planned cards whose key another target card holds: reported, and (with their examples and reviews) not written, which would die on the unique key.</summary>
    private static async Task<HashSet<Guid>> ReportKeyCollisionsAsync(EtlV2Context context, NpgsqlTransaction tx, List<PlannedWord> planned, CancellationToken ct)
    {
        var byKey = (await tx.Connection!.QueryAsync<(Guid Id, Guid UserId, string Language, string WordKey)>(new CommandDefinition(SelectWordKeys, transaction: tx, cancellationToken: ct)))
            .ToDictionary(k => (k.UserId, k.Language, k.WordKey), k => k.Id);
        var collisions = planned.Where(w => byKey.TryGetValue((w.UserId, w.Language, w.WordKey), out var id) && id != w.Id).ToList();
        foreach (var w in collisions)
            context.CleanupActions.Add($"vocabulary_words {w.Id}: card {byKey[(w.UserId, w.Language, w.WordKey)]} already holds its key; resolve by hand");
        context.Checks.Add(new("vocabulary_words.key-held-by-another-card", collisions.Count));
        return [.. collisions.Select(w => w.Id)];
    }

    private static (int, decimal, int, DateTimeOffset, DateTimeOffset?, DateTimeOffset?) Srs(PlannedWord w) =>
        (w.Stage, w.IntervalDays, w.ConsecutiveCorrect, w.NextReviewAt, w.LastReviewedAt, w.RetiredAt);

    private static PlannedWord WordOf(LegacyWord s, string language, string key) => new()
    {
        Id = s.Id,
        UserId = s.UserId,
        Language = language,
        Word = s.Word,
        WordKey = key,
        Translation = s.Translation,
        Definition = s.Definition,
        Stage = s.Stage,
        IntervalDays = EtlV2Rows.Numeric(s.IntervalDays),
        ConsecutiveCorrect = s.ConsecutiveCorrect,
        NextReviewAt = s.NextReviewAt,
        LastReviewedAt = s.LastReviewedAt,
        CreatedAt = s.CreatedAt,
        UpdatedAt = s.UpdatedAt,
        // A retired card without its time keeps its last update as the retire time.
        RetiredAt = s.IsRetired ? s.RetiredAt ?? s.UpdatedAt : null,
    };

    private static PlannedExample ExampleOf(PlannedWord card, LegacyWord w)
    {
        // An upload keeps its id in V2 (M3.2); a catalog book is its pair's. A deleted edition left neither.
        Guid? bookId = w.UserBookId ?? (w.EditionId is { } e ? EtlV2Ids.CatalogBook(w.UserId, e) : null);
        var operationId = EtlV2Ids.Operation(w.Id);
        var example = new VocabularyExample
        {
            BookId = bookId,
            ChapterKey = bookId is null ? null : w.ChapterKey,
            BookTitle = w.BookTitle,
            Sentence = w.Sentence!,
        };
        return new PlannedExample
        {
            Id = operationId,
            UserId = card.UserId,
            WordId = card.Id,
            BookId = example.BookId,
            ChapterKey = example.ChapterKey,
            BookTitle = example.BookTitle,
            Sentence = example.Sentence,
            OperationId = operationId,
            PayloadSha256 = VocabularyPayloads.ExampleSha256(new VocabularyWord { Language = card.Language, WordKey = card.WordKey }, example),
            CreatedAt = w.CreatedAt,
        };
    }

    private static PlannedReview ReviewOf(PlannedWord card, LegacyReview r)
    {
        // Hashed and stored truncated to milliseconds, so a replay of the legacy operation would match.
        var recorded = new DateTimeOffset(r.CreatedAt.Ticks - r.CreatedAt.Ticks % TimeSpan.TicksPerMillisecond, r.CreatedAt.Offset);
        var review = new VocabularyReview
        {
            WordId = card.Id,
            ReviewMode = r.ReviewMode,
            IsCorrect = r.IsCorrect,
            ResponseTimeMs = r.ResponseTimeMs,
            ClientRecordedAt = recorded,
        };
        return new PlannedReview
        {
            Id = r.Id,
            UserId = card.UserId,
            WordId = card.Id,
            OperationId = EtlV2Ids.Operation(r.Id),
            PayloadSha256 = VocabularyPayloads.ReviewSha256(review),
            ReviewMode = r.ReviewMode,
            IsCorrect = r.IsCorrect,
            ResponseTimeMs = r.ResponseTimeMs,
            StageBefore = r.StageBefore,
            StageAfter = r.StageAfter,
            ClientRecordedAt = recorded,
            CreatedAt = r.CreatedAt,
        };
    }

    internal sealed record LegacyWord
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Language { get; init; } = "";
        public string Word { get; init; } = "";
        public string? Translation { get; init; }
        public string? Definition { get; init; }
        public Guid? EditionId { get; init; }
        public Guid? UserBookId { get; init; }
        public string? Sentence { get; init; }
        public string? BookTitle { get; init; }
        public string? ChapterKey { get; init; }
        public int Stage { get; init; }
        public double IntervalDays { get; init; }
        public int ConsecutiveCorrect { get; init; }
        public DateTimeOffset NextReviewAt { get; init; }
        public DateTimeOffset? LastReviewedAt { get; init; }
        public int TotalReviews { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public bool IsRetired { get; init; }
        public DateTimeOffset? RetiredAt { get; init; }
    }

    private sealed record LegacyReview
    {
        public Guid Id { get; init; }
        public Guid VocabularyWordId { get; init; }
        public Guid UserId { get; init; }
        public string ReviewMode { get; init; } = "";
        public bool IsCorrect { get; init; }
        public int ResponseTimeMs { get; init; }
        public int StageBefore { get; init; }
        public int StageAfter { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }

    internal sealed record PlannedWord
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public string Language { get; init; } = "";
        public string Word { get; init; } = "";
        public string WordKey { get; init; } = "";
        public string? Translation { get; init; }
        public string? Definition { get; init; }
        public int Stage { get; init; }
        public decimal IntervalDays { get; init; }
        public int ConsecutiveCorrect { get; init; }
        public DateTimeOffset NextReviewAt { get; init; }
        public DateTimeOffset? LastReviewedAt { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset UpdatedAt { get; init; }
        public DateTimeOffset? DeletedAt { get; init; }
        public DateTimeOffset? RetiredAt { get; init; }
        public long Revision { get; init; } = 1;
    }

    internal sealed record PlannedExample
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid WordId { get; init; }
        public Guid? BookId { get; init; }
        public Guid? FileId { get; init; }
        public string? ChapterKey { get; init; }
        public string? BookTitle { get; init; }
        public string Sentence { get; init; } = "";
        public string? ContextualTranslation { get; init; }
        public Guid OperationId { get; init; }
        public string PayloadSha256 { get; init; } = "";
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset? DeletedAt { get; init; }
    }

    internal sealed record PlannedReview
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid WordId { get; init; }
        public Guid OperationId { get; init; }
        public string PayloadSha256 { get; init; } = "";
        public string ReviewMode { get; init; } = "";
        public bool IsCorrect { get; init; }
        public int? ResponseTimeMs { get; init; }
        public int StageBefore { get; init; }
        public int StageAfter { get; init; }
        public DateTimeOffset ClientRecordedAt { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
    }
}
