using Application.Vocabulary;
using Domain.Vocabulary;

namespace Infrastructure.Persistence.Etl;

/// <summary>
/// Vocabulary (ADR-031 decided item 4): legacy cards that share <c>(user, language, word_key)</c> merge onto
/// one survivor (<see cref="Ranked"/>); each legacy card's sentence becomes an example of the survivor, each
/// legacy review a review of it. The survivor takes a loser's translation or definition only where it has
/// none (owner 2026-11-08). Payload hashes go through <see cref="VocabularyPayloads"/>, the API's functions.
/// Not carried: <c>total_reviews</c>/<c>correct_reviews</c> (derived from reviews), clusters, tutor,
/// embeddings (D6). Conflict rule for all three tables: insert what V2 lacks, leave what is equal; a V2 row
/// that differs is a failed check, never overwritten.
/// </summary>
public static class EtlV2Vocabulary
{
    public static readonly EtlV2Step Step = new("vocabulary", ["vocabulary_words", "vocabulary_reviews", "chapters", "user_books"],
        ["vocabulary_words", "vocabulary_examples", "vocabulary_reviews"], RunAsync);

    // A catalog chapter is named by decided item 6's fallback key; a blank legacy slug (nullable, no CHECK) falls back
    // too, since V2's chapter_key CHECK refuses it and the number still names the chapter. Only a chapter of the
    // card's own edition: legacy has no FK tying the two.
    private const string SelectLegacyWords = """
        SELECT w.id, w.user_id, w.language, w.word, w.translation, w.definition, w.edition_id, w.user_book_id, w.chapter_id, w.sentence, w.book_title,
            COALESCE(NULLIF(btrim(c.slug), ''), 'ch-' || c.chapter_number) AS chapter_key,
            w.stage, w.interval_days, w.consecutive_correct, w.next_review_at, w.last_reviewed_at, w.total_reviews,
            w.created_at, w.updated_at, w.is_retired, w.retired_at
        FROM vocabulary_words w LEFT JOIN chapters c ON c.id = w.chapter_id AND c.edition_id = w.edition_id
        ORDER BY w.id
        """;

    private const string SelectLegacyReviews = """
        SELECT id, vocabulary_word_id, user_id, review_mode, is_correct, response_time_ms, stage_before, stage_after, created_at
        FROM vocabulary_reviews ORDER BY id
        """;

    private const string SelectV2Words = """
        SELECT id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, created_at, updated_at, deleted_at, retired_at, revision
        FROM vocabulary_words
        """;

    private const string SelectV2WordsById = SelectV2Words + """

        WHERE id = ANY(@ids)
        """;

    private const string InsertWord = """
        INSERT INTO vocabulary_words (id, user_id, language, word, word_key, translation, definition, stage, interval_days, consecutive_correct,
            next_review_at, last_reviewed_at, created_at, updated_at, deleted_at, retired_at, revision)
        VALUES (@Id, @UserId, @Language, @Word, @WordKey, @Translation, @Definition, @Stage, @IntervalDays, @ConsecutiveCorrect,
            @NextReviewAt, @LastReviewedAt, @CreatedAt, @UpdatedAt, @DeletedAt, @RetiredAt, @Revision)
        """;

    private const string SelectV2Examples = """
        SELECT id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation, operation_id, payload_sha256, created_at, deleted_at
        FROM vocabulary_examples
        """;

    private const string SelectV2ExamplesById = SelectV2Examples + """

        WHERE id = ANY(@ids)
        """;

    private const string InsertExample = """
        INSERT INTO vocabulary_examples (id, user_id, word_id, book_id, file_id, chapter_key, book_title, sentence, contextual_translation,
            operation_id, payload_sha256, created_at, deleted_at)
        VALUES (@Id, @UserId, @WordId, @BookId, @FileId, @ChapterKey, @BookTitle, @Sentence, @ContextualTranslation,
            @OperationId, @PayloadSha256, @CreatedAt, @DeletedAt)
        """;

    private const string SelectV2Reviews = """
        SELECT id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at
        FROM vocabulary_reviews
        """;

    private const string InsertReview = """
        INSERT INTO vocabulary_reviews (id, user_id, word_id, operation_id, payload_sha256, review_mode, is_correct, response_time_ms, stage_before, stage_after, client_recorded_at, created_at)
        VALUES (@Id, @UserId, @WordId, @OperationId, @PayloadSha256, @ReviewMode, @IsCorrect, @ResponseTimeMs, @StageBefore, @StageAfter, @ClientRecordedAt, @CreatedAt)
        """;

    /// <summary>
    /// A case-variant group, survivor first (ADR-031 decided item 4): the higher <c>total_reviews</c>, tie → the
    /// newer <c>updated_at</c>, tie → the lower id (so a full tie is still deterministic). Losers follow in the same order.
    /// </summary>
    internal static List<LegacyWord> Ranked(IEnumerable<LegacyWord> group) =>
        [.. group.OrderByDescending(w => w.TotalReviews).ThenByDescending(w => w.UpdatedAt).ThenBy(w => w.Id.ToString("D"), StringComparer.Ordinal)];

    private static async Task RunAsync(EtlV2Context context, CancellationToken ct)
    {
        var uploadOwner = await EtlV2Rows.UploadOwnersAsync(context, ct);
        var legacyWords = EtlV2Rows.Admit(context, "vocabulary_words", await EtlV2Rows.SourceAsync<LegacyWord>(context, SelectLegacyWords, null, ct), w => w.Id,
            ("blank word or language", w => WordKeys.Language(w.Language) == "" || WordKeys.Of(w.Word) == ""),
            ("negative SRS field", w => w.Stage < 0 || w.IntervalDays < 0 || w.ConsecutiveCorrect < 0),
            // Numeric needs a decimal: finite and within its range (a value below its precision becomes 0, fine for a day count).
            ("interval_days not a representable number", w => !double.IsFinite(w.IntervalDays) || Math.Abs(w.IntervalDays) >= (double)decimal.MaxValue),
            EtlV2Rows.ForeignUploadRule<LegacyWord>(uploadOwner, w => w.UserBookId, w => w.UserId));

        // legacy card id → the survivor's card
        var cardOf = new Dictionary<Guid, WordRow>();
        var words = new List<WordRow>();
        var examples = new List<ExampleRow>();
        foreach (var group in legacyWords.GroupBy(w => (w.UserId, Language: WordKeys.Language(w.Language), Key: WordKeys.Of(w.Word))))
        {
            var card = WordOf(Ranked(group), group.Key.Language, group.Key.Key);
            words.Add(card);
            foreach (var w in group)
            {
                cardOf[w.Id] = card;
                if (!string.IsNullOrWhiteSpace(w.Sentence))
                    examples.Add(ExampleOf(card, w));
                if (OwnerNote(w) is { } note)
                    context.CleanupActions.Add($"vocabulary_words {w.Id}: {note}");
            }
        }

        // A review of a refused card is not planned: that card's check already fails the run.
        var legacyReviews = (await EtlV2Rows.SourceAsync<LegacyReview>(context, SelectLegacyReviews, null, ct)).Where(r => cardOf.ContainsKey(r.VocabularyWordId)).ToList();
        var reviews = EtlV2Rows.Admit(context, "vocabulary_reviews", legacyReviews, r => r.Id,
            ("another user's card", r => r.UserId != cardOf[r.VocabularyWordId].UserId),
            ("blank review_mode", r => string.IsNullOrWhiteSpace(r.ReviewMode)),
            ("negative response time or stage", r => r.ResponseTimeMs < 0 || r.StageBefore < 0 || r.StageAfter < 0))
            .Select(r => ReviewOf(cardOf[r.VocabularyWordId], r)).ToList();

        var (wordsRead, examplesRead, reviewsRead) = (EtlV2Rows.TargetAsync<WordRow>(context, SelectV2Words, null, ct),
            EtlV2Rows.TargetAsync<ExampleRow>(context, SelectV2Examples, null, ct), EtlV2Rows.TargetAsync<ReviewRow>(context, SelectV2Reviews, null, ct));
        await Task.WhenAll(wordsRead, examplesRead, reviewsRead);
        var (v2Words, v2Examples, v2Reviews) = (await wordsRead, await examplesRead, await reviewsRead);
        var wordPlan = EtlV2Rows.Plan(context, "vocabulary_words", words, v2Words, w => w.Id);
        var examplePlan = EtlV2Rows.Plan(context, "vocabulary_examples", examples, v2Examples, e => e.Id);
        var reviewPlan = EtlV2Rows.Plan(context, "vocabulary_reviews", reviews, v2Reviews, r => r.Id);
        // V2's secondary unique keys: a card another V2 card holds the key of would abort the insert with 23505.
        EtlV2Rows.HeldByAnother(context, "vocabulary_words: (user_id, language, word_key)", words, v2Words, w => w.Id, w => (w.UserId, w.Language, w.WordKey));
        EtlV2Rows.HeldByAnother(context, "vocabulary_examples: (user_id, operation_id)", examples, v2Examples, e => e.Id, e => (e.UserId, e.OperationId));
        EtlV2Rows.HeldByAnother(context, "vocabulary_reviews: (user_id, operation_id)", reviews, v2Reviews, r => r.Id, r => (r.UserId, r.OperationId));

        if (!await EtlV2Rows.InsertAsync(context, ct, (InsertWord, wordPlan.New), (InsertExample, examplePlan.New), (InsertReview, reviewPlan.New)))
            return;

        // Words and examples: only the rows this run wrote are re-read (the rest were equal before the write, and the write
        // adds only). Reviews: all of them, for the count check.
        var wordsAfter = EtlV2Rows.TargetAsync<WordRow>(context, SelectV2WordsById, new { ids = wordPlan.New.Select(w => w.Id).ToArray() }, ct);
        var examplesAfter = EtlV2Rows.TargetAsync<ExampleRow>(context, SelectV2ExamplesById, new { ids = examplePlan.New.Select(e => e.Id).ToArray() }, ct);
        var reviewsAfter = EtlV2Rows.TargetAsync<ReviewRow>(context, SelectV2Reviews, null, ct);
        await Task.WhenAll(wordsAfter, examplesAfter, reviewsAfter);
        EtlV2Rows.Verify(context, "vocabulary_words: parity (SRS fields equal)", wordPlan.New, await wordsAfter, w => w.Id);
        EtlV2Rows.Verify(context, "vocabulary_examples: parity", examplePlan.New, await examplesAfter, e => e.Id);
        EtlV2Rows.Verify(context, "vocabulary_reviews: parity", reviews, await reviewsAfter, r => r.Id);
        // From the source rows (every legacy review of the group), not the plan: the survivor's V2 reviews are all of them.
        // Over the cards this run carries: a V2-only card's reviews are its cleanup line's.
        var carried = words.Select(w => w.Id).ToHashSet();
        EtlV2Rows.Totals(context, "vocabulary: review count differs (legacy reviews of a merged group vs its survivor's V2 reviews)",
            legacyReviews.GroupBy(r => cardOf[r.VocabularyWordId].Id).ToDictionary(g => g.Key, g => (long)g.Count()),
            (await reviewsAfter).Where(r => carried.Contains(r.WordId)).GroupBy(r => r.WordId).ToDictionary(g => g.Key, g => (long)g.Count()));
    }

    private static WordRow WordOf(List<LegacyWord> ranked, string language, string key)
    {
        var s = ranked[0];
        return new()
        {
            Id = s.Id,
            UserId = s.UserId,
            Language = language,
            Word = s.Word,
            WordKey = key,
            // Owner 2026-11-08: a loser's translation or definition fills only a field the survivor has none in (the best-ranked loser's).
            Translation = ranked.Select(w => w.Translation).FirstOrDefault(t => !string.IsNullOrWhiteSpace(t)) ?? s.Translation,
            Definition = ranked.Select(w => w.Definition).FirstOrDefault(d => !string.IsNullOrWhiteSpace(d)) ?? s.Definition,
            Stage = s.Stage,
            IntervalDays = EtlV2Rows.Numeric(s.IntervalDays),
            ConsecutiveCorrect = s.ConsecutiveCorrect,
            NextReviewAt = s.NextReviewAt,
            LastReviewedAt = s.LastReviewedAt,
            CreatedAt = s.CreatedAt,
            UpdatedAt = s.UpdatedAt,
            // A retired card without its time keeps its last update as the retire time; a loser's retirement is not carried.
            RetiredAt = s.IsRetired ? s.RetiredAt ?? s.UpdatedAt : null,
        };
    }

    // The key names a chapter of the card's edition (the join guards it): only on that edition's pair, never on an upload.
    private static string? ChapterKeyOf(LegacyWord w) => w.UserBookId is null ? w.ChapterKey : null;

    /// <summary>
    /// What the run reports about a card's owners and chapter, or null. No owner CHECK in legacy: a card can name both
    /// (the upload is the more specific owner); a chapter_id not carried as chapter_key is listed, never dropped silently.
    /// </summary>
    private static string? OwnerNote(LegacyWord w) => (w.UserBookId, w.EditionId) switch
    {
        ({ } upload, { } edition) => $"both owners set (upload {upload}, edition {edition}); example kept on the upload"
            + (w.ChapterId is null ? "" : $", catalog chapter {w.ChapterId} not carried as its chapter_key"),
        _ when w.ChapterId is null || ChapterKeyOf(w) is not null => null,
        (_, null) => $"chapter {w.ChapterId} dropped, the card has no edition; example carried with no chapter_key",
        _ => $"chapter {w.ChapterId} is not of its edition; example carried with no chapter_key",
    };

    private static ExampleRow ExampleOf(WordRow card, LegacyWord w)
    {
        // An upload keeps its id in V2 (M3.2); a catalog book is its pair's. A deleted edition left neither.
        Guid? bookId = w.UserBookId ?? (w.EditionId is { } e ? EtlV2Ids.CatalogBook(w.UserId, e) : null);
        var operationId = EtlV2Ids.Operation(w.Id);
        var example = new VocabularyExample
        {
            BookId = bookId,
            ChapterKey = ChapterKeyOf(w),
            BookTitle = w.BookTitle,
            Sentence = w.Sentence!,
        };
        return new ExampleRow
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

    private static ReviewRow ReviewOf(WordRow card, LegacyReview r)
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
        return new ReviewRow
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
        public Guid? ChapterId { get; init; }
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

    private sealed record WordRow
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

    private sealed record ExampleRow
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

    private sealed record ReviewRow
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
