using System.Text;
using Application.Common;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Vocabulary;
using TextStack.Vocabulary;
using static Application.Sync.SyncValidation;
using static Contracts.V2.SyncLimits;

namespace Application.Vocabulary;

/// <summary>
/// The /me/v2 vocabulary use cases (v2-sync-protocol.md "Payloads → Vocabulary", M2.3 rows). The
/// server owns the key (<see cref="WordKeys"/>) and the schedule (S3: the answer is applied to the
/// locked card by <see cref="ISrsEngine"/>). An example's book and file are checked before any write
/// (<see cref="LibraryProvenance"/>). After a write the response is the card as stored now, with its
/// live examples.
/// </summary>
public sealed class VocabularySyncService(ILibraryRepository library, IVocabularyRepository words, ISrsEngine srs)
{
    public async Task<SyncResult> SaveWordAsync(Guid userId, SaveVocabularyWordRequest r, CancellationToken ct)
    {
        if (Word(r) is { } invalid) return invalid;
        if (r.Example is { BookId: { } bookId } provenance
            && await library.MissingBookOrFileAsync(userId, bookId, provenance.FileId, ct) is { } missing) return missing;

        var saved = await words.SaveWordAsync(userId, new VocabularyWord
        {
            Id = r.Id!.Value,
            Language = WordKeys.Language(r.Language!),
            Word = r.Word!,
            WordKey = WordKeys.Of(r.Word!),
            Translation = r.Translation,
            Definition = r.Definition,
        }, ct);
        if (saved.Outcome == WordSaveOutcome.IdConflict) return SyncResult.IdConflict;
        var created = saved.Outcome == WordSaveOutcome.Created;
        // Created without an example: the returned row is the whole card (no examples yet).
        if (created && r.Example is null) return SyncResult.Created(saved.Word!.ToDto());
        // A tombstone wins over the save, except that its example is asked first (principle 6): a
        // replay of a save that landed before the delete answers 200, a new operation 409 deleted.
        if (saved.Outcome == WordSaveOutcome.Deleted && r.Example is null) return await DeletedAsync(userId, saved.Word!.Id, ct);

        string? example = null;
        if (r.Example is { } sent)
        {
            var added = await words.AddExampleAsync(userId, NewExample(saved.Word!, sent), ct);
            if (added.Outcome is not (WriteOutcome.Created or WriteOutcome.Replayed))
                return await LossAsync(userId, saved.Word!.Id, added.Outcome, added.Row?.ToDto(), ct);
            example = added.Outcome == WriteOutcome.Created ? "added" : "replayed";
        }
        return await RespondAsync(userId, saved.Word!.Id, card => SyncResult.Written(created, card.ToDto(example)), ct);
    }

    private static SyncResult? Word(SaveVocabularyWordRequest r) =>
        ClientId(r.Id, "id") ?? RequiredText(r.Language, "language", MaxLanguage) ?? RequiredText(r.Word, "word", MaxWord)
        // A key of only format or punctuation characters (a zero-width space) names no word.
        ?? (WordKeys.Of(r.Word!).EnumerateRunes().Any(Rune.IsLetterOrDigit) ? null : SyncResult.Invalid("word", "word has no letter or digit."))
        ?? Text(r.Translation, "translation", MaxTranslation) ?? Text(r.Definition, "definition", MaxDefinition)
        ?? (r.Example is null ? null : Example(r.Example, "example."));

    public Task<SyncResult> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct) =>
        RespondAsync(userId, wordId, card => SyncResult.Ok(card.ToDto()), ct);

    public async Task<SyncResult> UpdateWordAsync(Guid userId, Guid wordId, PatchVocabularyWordRequest r, CancellationToken ct)
    {
        if (Required(r.ExpectedRevision, "expectedRevision") is { } missing) return missing;
        var stored = await words.GetCardAsync(userId, wordId, ct);
        if (stored is null) return SyncResult.NotFound;
        if (stored.DeletedAt is not null) return await DeletedAsync(userId, wordId, ct);
        if (Merge(r.Translation, stored.Translation, "translation", out var translation, MaxTranslation) is { } badTranslation) return badTranslation;
        if (Merge(r.Definition, stored.Definition, "definition", out var definition, MaxDefinition) is { } badDefinition) return badDefinition;

        var result = await words.UpdateWordAsync(userId, wordId, translation, definition, r.ExpectedRevision!.Value, ct);
        if (result.Current is not { } written) return SyncResult.NotFound;
        // Not accepted but already as sent: a retry of an edit that landed, whose response was lost.
        var ownWrite = result.Accepted || (written.Translation, written.Definition) == (translation, definition);
        return await RespondAsync(userId, wordId, card =>
            card.DeletedAt is not null ? Deleted(card)
            : ownWrite ? SyncResult.Ok(card.ToDto())
            : SyncResult.StaleRevision(card.Revision, card.ToDto()), ct);
    }

    /// <summary>Idempotent: deleting a tombstone answers it again.</summary>
    public async Task<SyncResult> DeleteWordAsync(Guid userId, Guid wordId, CancellationToken ct)
    {
        await words.DeleteWordAsync(userId, wordId, ct);
        return await GetWordAsync(userId, wordId, ct);
    }

    public async Task<SyncResult> RestoreWordAsync(Guid userId, Guid wordId, RestoreVocabularyWordRequest r, CancellationToken ct)
    {
        if (Required(r.ExpectedRevision, "expectedRevision") is { } missing) return missing;
        var result = await words.RestoreWordAsync(userId, wordId, r.ExpectedRevision!.Value, ct);
        if (result.Current is null) return SyncResult.NotFound;
        // Lost but live: what a restore produces, so a retry whose response was lost (PDD "Own write, lost response").
        return await RespondAsync(userId, wordId, card =>
            result.Accepted || card.DeletedAt is null ? SyncResult.Ok(card.ToDto()) : SyncResult.StaleRevision(card.Revision, card.ToDto()), ct);
    }

    public async Task<SyncResult> AddExampleAsync(Guid userId, Guid wordId, VocabularyExampleRequest r, CancellationToken ct)
    {
        if (Example(r) is { } invalid) return invalid;
        // Read first: the hash names the card by its key, as a save-by-key does (M1.3 delta 5).
        var card = await words.GetCardAsync(userId, wordId, ct);
        if (card is null) return SyncResult.NotFound;
        if (r.BookId is { } bookId && await library.MissingBookOrFileAsync(userId, bookId, r.FileId, ct) is { } missing) return missing;

        var added = await words.AddExampleAsync(userId, NewExample(card, r), ct);
        if (added.Outcome is not (WriteOutcome.Created or WriteOutcome.Replayed))
            return await LossAsync(userId, wordId, added.Outcome, added.Row?.ToDto(), ct);
        return SyncResult.Written(added.Outcome, added.Row!.ToDto());
    }

    public async Task<SyncResult> RecordReviewAsync(Guid userId, VocabularyReviewRequest r, CancellationToken ct)
    {
        if (Review(r, DateTimeOffset.UtcNow) is { } invalid) return invalid;
        var review = new VocabularyReview
        {
            Id = Guid.CreateVersion7(),
            WordId = r.WordId!.Value,
            OperationId = r.OperationId!.Value,
            ReviewMode = r.ReviewMode!,
            IsCorrect = r.IsCorrect!.Value,
            ResponseTimeMs = r.ResponseTimeMs,
            ClientRecordedAt = r.ClientRecordedAt!.Value,
        };
        review.PayloadSha256 = VocabularyPayloads.ReviewSha256(review);
        var result = await words.RecordReviewAsync(userId, review, Schedule(review.IsCorrect), ct);
        if (result.Outcome is not (WriteOutcome.Created or WriteOutcome.Replayed))
            return await LossAsync(userId, review.WordId, result.Outcome, result.Row?.ToDto(), ct);
        return await RespondAsync(userId, review.WordId,
            card => SyncResult.Written(result.Outcome, new RecordedReviewDto(result.Row!.ToDto(), card.ToDto())), ct);
    }

    /// <summary>An answer; <paramref name="now"/> is the server's receive time, which a client time may not pass by more than the skew.</summary>
    private static SyncResult? Review(VocabularyReviewRequest r, DateTimeOffset now) =>
        ClientId(r.OperationId, "operationId") ?? Required(r.WordId, "wordId") ?? RequiredText(r.ReviewMode, "reviewMode", MaxReviewMode)
        ?? Required(r.IsCorrect, "isCorrect") ?? Required(r.ClientRecordedAt, "clientRecordedAt")
        ?? NotFuture(r.ClientRecordedAt, now, "clientRecordedAt")
        ?? (r.ResponseTimeMs is null or >= 0 ? null : SyncResult.Invalid("responseTimeMs", "responseTimeMs must be zero or more."));

    /// <summary>
    /// S3: the next schedule from the card as the repository holds it locked, so two answers in
    /// flight apply one after the other. Whether a retired card stays retired is the repository's.
    /// </summary>
    private Func<VocabularyWord, ReviewSchedule> Schedule(bool isCorrect) => card =>
    {
        var (stage, interval, consecutive) = srs.Calculate(card.Stage, card.ConsecutiveCorrect, (double)card.IntervalDays, isCorrect);
        return new ReviewSchedule(stage, (decimal)interval, consecutive, srs.ShouldAutoRetire(stage, consecutive, interval));
    };

    public async Task<SyncResult> DueAsync(Guid userId, string? limit, CancellationToken ct)
    {
        if (ChangeFeed.Limit(limit, out var take) is { } invalid) return invalid;
        var due = await words.ListDueAsync(userId, take, ct);
        return SyncResult.Ok(due.Select(w => w.ToDto()).ToList());
    }

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, string? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => words.ListChangedAsync(userId, since, after, take, ct),
            w => (w.UpdatedAt, w.Id), w => w.ToDto());

    private static VocabularyExample NewExample(VocabularyWord card, VocabularyExampleRequest e)
    {
        var example = new VocabularyExample
        {
            Id = Guid.CreateVersion7(),
            WordId = card.Id,
            BookId = e.BookId,
            FileId = e.FileId,
            ChapterKey = e.ChapterKey,
            BookTitle = e.BookTitle,
            Sentence = e.Sentence!,
            ContextualTranslation = e.ContextualTranslation,
            OperationId = e.OperationId!.Value,
        };
        example.PayloadSha256 = VocabularyPayloads.ExampleSha256(card, example);
        return example;
    }

    /// <summary>An append that neither landed nor replayed: a reused operation id, a tombstone, or no card.</summary>
    private async Task<SyncResult> LossAsync(Guid userId, Guid wordId, WriteOutcome outcome, object? stored, CancellationToken ct) => outcome switch
    {
        WriteOutcome.OperationConflict => SyncResult.Written(outcome, stored),
        WriteOutcome.Deleted => await DeletedAsync(userId, wordId, ct),
        _ => SyncResult.NotFound,
    };

    private Task<SyncResult> DeletedAsync(Guid userId, Guid wordId, CancellationToken ct) => RespondAsync(userId, wordId, Deleted, ct);

    private static SyncResult Deleted(VocabularyWord tombstone) => SyncResult.Deleted(tombstone.Revision, tombstone.ToDto());

    /// <summary>The card as stored now, with its examples, answered by <paramref name="respond"/>; 404 when it is gone.</summary>
    private async Task<SyncResult> RespondAsync(Guid userId, Guid wordId, Func<VocabularyWord, SyncResult> respond, CancellationToken ct) =>
        await words.GetWordAsync(userId, wordId, ct) is { } card ? respond(card) : SyncResult.NotFound;
}
