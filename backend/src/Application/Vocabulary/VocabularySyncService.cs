using System.Text.Json;
using Application.Common;
using Application.Library;
using Application.Sync;
using Contracts.V2;
using Domain.Vocabulary;
using TextStack.Vocabulary;
using static Application.Sync.SyncValidation;

namespace Application.Vocabulary;

/// <summary>
/// The /me/v2 vocabulary use cases (v2-sync-protocol.md "Payloads → Vocabulary", M2.3 rows). The
/// server owns the key (<see cref="WordKeys"/>) and the schedule (S3: the answer is applied to the
/// locked card by <see cref="ISrsEngine"/>). An example's book and file are checked before any
/// write (M1.3 delta 8): the schema would refuse a bad one only at commit, as a 500 an outbox retries
/// forever. A removed book still accepts examples (owner decision 11).
/// </summary>
public sealed class VocabularySyncService(
    ILibraryRepository library, IVocabularyRepository words, IVocabularyFeedRepository feed, ISrsEngine srs)
{
    public async Task<SyncResult> SaveWordAsync(Guid userId, SaveVocabularyWordRequest r, CancellationToken ct)
    {
        if (Word(r) is { } invalid) return invalid;
        if (r.Example is { } provenance && await MissingProvenanceAsync(userId, provenance, ct) is { } missing) return missing;

        var saved = await words.SaveWordAsync(userId, new VocabularyWord
        {
            Id = r.Id!.Value,
            Language = r.Language!,
            Word = r.Word!,
            WordKey = WordKeys.Of(r.Word!),
            Translation = r.Translation,
            Definition = r.Definition,
        }, ct);
        if (saved.Outcome == WordSaveOutcome.IdConflict) return SyncResult.IdConflict;
        // The tombstone wins over the save and its example: restoring is the reader's call.
        if (saved.Outcome == WordSaveOutcome.Deleted) return await DeletedAsync(userId, saved.Word!.Id, ct);

        string? example = null;
        if (r.Example is { } sent)
        {
            var added = await words.AddExampleAsync(userId, NewExample(saved.Word!, sent), ct);
            if (added.Outcome is not (WriteOutcome.Created or WriteOutcome.Replayed))
                return await LossAsync(userId, saved.Word!.Id, added.Outcome, added.Row?.ToDto(), ct);
            example = added.Outcome == WriteOutcome.Created ? "added" : "replayed";
        }
        var card = await WithExamplesAsync(userId, saved.Word!, ct);
        return saved.Outcome == WordSaveOutcome.Created ? SyncResult.Created(card.ToDto(example)) : SyncResult.Ok(card.ToDto(example));
    }

    public async Task<SyncResult> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct) =>
        await words.GetWordAsync(userId, wordId, ct) is { } card ? SyncResult.Ok(card.ToDto()) : SyncResult.NotFound;

    public async Task<SyncResult> UpdateWordAsync(Guid userId, Guid wordId, PatchVocabularyWordRequest r, CancellationToken ct)
    {
        if (Required(r.ExpectedRevision, "expectedRevision") is { } missing) return missing;
        var stored = await words.GetWordAsync(userId, wordId, ct);
        if (stored is null) return SyncResult.NotFound;
        if (stored.DeletedAt is not null) return Deleted(stored);
        if (!TryMerge(stored, r, out var translation, out var definition, out var invalid)) return invalid!;

        var result = await words.UpdateWordAsync(userId, wordId, translation, definition, r.ExpectedRevision!.Value, ct);
        if (result.Current is not { } card) return SyncResult.NotFound;
        card.Examples = stored.Examples;
        if (card.DeletedAt is not null) return Deleted(card);
        // Not accepted but already as sent: a retry of an edit that landed, whose response was lost.
        return result.Accepted || (card.Translation, card.Definition) == (translation, definition)
            ? SyncResult.Ok(card.ToDto())
            : SyncResult.StaleRevision(card.Revision, card.ToDto());
    }

    // Merge-patch: an absent member keeps the stored value, null clears it.
    private static bool TryMerge(VocabularyWord stored, PatchVocabularyWordRequest r, out string? translation, out string? definition, out SyncResult? invalid)
    {
        (translation, definition) = (null, null);
        try
        {
            static string? Merged(JsonElement e, string? kept) => e.ValueKind == JsonValueKind.Undefined ? kept : e.Deserialize<string?>();
            (translation, definition) = (Merged(r.Translation, stored.Translation), Merged(r.Definition, stored.Definition));
            invalid = Text(translation, "translation") ?? Text(definition, "definition");
            return invalid is null;
        }
        // A wrong type, or an escaped lone surrogate a string cannot even be read from.
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            invalid = SyncResult.Invalid("translation", "translation and definition are strings or null.");
            return false;
        }
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
        var card = await WithExamplesAsync(userId, result.Current, ct);
        // A live card here may be this client's own restore whose response was lost: the client tells (PDD "own write").
        return result.Accepted ? SyncResult.Ok(card.ToDto()) : SyncResult.StaleRevision(card.Revision, card.ToDto());
    }

    public async Task<SyncResult> AddExampleAsync(Guid userId, Guid wordId, VocabularyExampleRequest r, CancellationToken ct)
    {
        if (Example(r) is { } invalid) return invalid;
        // Read first: the hash names the card by its key, as a save-by-key does (M1.3 delta 5).
        var card = await words.GetWordAsync(userId, wordId, ct);
        if (card is null) return SyncResult.NotFound;
        if (await MissingProvenanceAsync(userId, r, ct) is { } missing) return missing;

        var added = await words.AddExampleAsync(userId, NewExample(card, r), ct);
        return added.Outcome switch
        {
            WriteOutcome.Created => SyncResult.Created(added.Row!.ToDto()),
            WriteOutcome.Replayed => SyncResult.Ok(added.Row!.ToDto()),
            _ => await LossAsync(userId, wordId, added.Outcome, added.Row?.ToDto(), ct),
        };
    }

    public async Task<SyncResult> RecordReviewAsync(Guid userId, VocabularyReviewRequest r, CancellationToken ct)
    {
        if (Review(r) is { } invalid) return invalid;
        var review = new VocabularyReview
        {
            Id = Guid.CreateVersion7(),
            WordId = r.WordId!.Value,
            OperationId = r.OperationId!.Value,
            ReviewMode = r.ReviewMode!,
            IsCorrect = r.IsCorrect!.Value,
            ResponseTimeMs = r.ResponseTimeMs,
            ClientRecordedAt = r.ClientRecordedAt!.Value,
            PayloadSha256 = CanonicalPayload.Sha256(new ReviewPayload(
                r.WordId.Value, r.ReviewMode!, r.IsCorrect.Value, r.ResponseTimeMs, r.ClientRecordedAt.Value)),
        };
        var result = await words.RecordReviewAsync(userId, review, Schedule(review.IsCorrect), ct);
        if (result.Outcome is not (WriteOutcome.Created or WriteOutcome.Replayed))
            return await LossAsync(userId, review.WordId, result.Outcome, result.Row?.ToDto(), ct);

        if (await words.GetWordAsync(userId, review.WordId, ct) is not { } card) return SyncResult.NotFound;
        var body = new RecordedReviewDto(result.Row!.ToDto(), card.ToDto());
        return result.Outcome == WriteOutcome.Created ? SyncResult.Created(body) : SyncResult.Ok(body);
    }

    /// <summary>
    /// S3: the next schedule from the card as the repository holds it locked, so two answers in
    /// flight apply one after the other. A mastered card is retired, once (owner decision 1); a
    /// retired one is never brought back by an answer.
    /// </summary>
    private Func<VocabularyWord, ReviewSchedule> Schedule(bool isCorrect) => card =>
    {
        var (stage, interval, consecutive) = srs.Calculate(card.Stage, card.ConsecutiveCorrect, (double)card.IntervalDays, isCorrect);
        return new ReviewSchedule(stage, (decimal)interval, consecutive, card.RetiredAt is null && srs.ShouldAutoRetire(stage, consecutive, interval));
    };

    public async Task<SyncResult> DueAsync(Guid userId, string? limit, CancellationToken ct)
    {
        if (ChangeFeed.Limit(limit, out var take) is { } invalid) return invalid;
        var due = await feed.ListDueAsync(userId, DateTimeOffset.UtcNow, take, ct);
        return SyncResult.Ok(due.Select(w => w.ToDto()).ToList());
    }

    public Task<SyncResult> ChangesAsync(Guid userId, string? cursor, string? limit, CancellationToken ct) =>
        ChangeFeed.PageAsync(cursor, limit,
            (since, after, take) => feed.ListChangedAsync(userId, since, after, take, ct),
            w => (w.UpdatedAt, w.Id), w => w.ToDto());

    /// <summary>The book is the user's (removed or not) and the file one of its versions, current or not.</summary>
    private async Task<SyncResult?> MissingProvenanceAsync(Guid userId, VocabularyExampleRequest e, CancellationToken ct)
    {
        if (e.BookId is not { } bookId) return null;
        if (!await library.ExistsAsync(userId, bookId, ct)) return SyncResult.BookNotFound;
        return e.FileId is { } fileId && await library.GetFileAsync(userId, bookId, fileId, ct) is null ? SyncResult.UnknownFile : null;
    }

    private static VocabularyExample NewExample(VocabularyWord card, VocabularyExampleRequest e) => new()
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
        PayloadSha256 = CanonicalPayload.Sha256(new ExamplePayload(
            card.Language, card.WordKey, e.Sentence!, e.ContextualTranslation, e.BookId, e.FileId, e.ChapterKey, e.BookTitle)),
    };

    // The "Canonical JSON" table's rows: exactly these fields, by these names, are hashed.
    private sealed record ExamplePayload(
        string Language, string WordKey, string Sentence, string? ContextualTranslation, Guid? BookId, Guid? FileId, string? ChapterKey, string? BookTitle);

    private sealed record ReviewPayload(Guid WordId, string ReviewMode, bool IsCorrect, int? ResponseTimeMs, DateTimeOffset ClientRecordedAt);

    /// <summary>An append that neither landed nor replayed: a reused operation id, a tombstone, or no card.</summary>
    private async Task<SyncResult> LossAsync(Guid userId, Guid wordId, WriteOutcome outcome, object? stored, CancellationToken ct) => outcome switch
    {
        WriteOutcome.OperationConflict => SyncResult.Fail(SyncCodes.OperationConflict, current: stored),
        WriteOutcome.Deleted => await DeletedAsync(userId, wordId, ct),
        _ => SyncResult.NotFound,
    };

    private async Task<SyncResult> DeletedAsync(Guid userId, Guid wordId, CancellationToken ct) =>
        await words.GetWordAsync(userId, wordId, ct) is { } tombstone ? Deleted(tombstone) : SyncResult.NotFound;

    private static SyncResult Deleted(VocabularyWord tombstone) => SyncResult.Fail(SyncCodes.Deleted, tombstone.Revision, tombstone.ToDto());

    // A write returns the card alone; every response carries its live examples.
    private async Task<VocabularyWord> WithExamplesAsync(Guid userId, VocabularyWord card, CancellationToken ct)
    {
        card.Examples = (await words.GetWordAsync(userId, card.Id, ct))?.Examples ?? [];
        return card;
    }
}
