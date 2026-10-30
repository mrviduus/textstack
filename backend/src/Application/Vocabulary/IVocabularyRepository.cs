using Application.Common;
using Domain.Vocabulary;

namespace Application.Vocabulary;

/// <summary>
/// The V2 vocabulary (tables <c>vocabulary_words</c> + <c>vocabulary_examples</c> +
/// <c>vocabulary_reviews</c>, one aggregate; ADR-031). Every method is scoped to <c>userId</c>
/// (docs/01-architecture/data-access.md rule 7): an entity whose <c>UserId</c> is not
/// <c>userId</c> is an <see cref="ArgumentException"/>, a card that is not the user's reads as not found.
/// Neither the SRS math nor the payload hash is here: a review arrives with the function that computes
/// the schedule, an example or review with its <c>PayloadSha256</c> (v2-sync-protocol.md,
/// "operation_id rules"). A card's <c>revision</c> moves only on explicit edit, delete and restore;
/// every write the sync feed must show bumps its <c>updated_at</c>. Input validation (hash format,
/// text lengths, non-blank, non-negative, provenance pointing at the user's own book and file) is the
/// API's job: a caller bug surfaces as a <c>PostgresException</c> from the schema (data-access.md rule 8).
/// </summary>
public interface IVocabularyRepository
{
    /// <summary>
    /// Saves the user's word: creates the card (<see cref="WordSaveOutcome.Created"/>), or finds the
    /// one already stored under the same language and <see cref="VocabularyWord.WordKey"/>, whatever
    /// its id (<see cref="WordSaveOutcome.Existing"/>, <see cref="WordSaveOutcome.Deleted"/>). Saving
    /// again never changes the card: not its schedule, not its translation or definition (those are
    /// used only when the card is created; changing them is <see cref="UpdateWordAsync"/>). A client id
    /// already taken by another card, with no card under the key, is
    /// <see cref="WordSaveOutcome.IdConflict"/> and writes nothing. The example is a second call,
    /// <see cref="AddExampleAsync"/> on the returned card: both are idempotent, so a crash between them
    /// is repaired by the client's retry.
    /// </summary>
    Task<SavedWord> SaveWordAsync(Guid userId, VocabularyWord word, CancellationToken ct);

    /// <summary>
    /// The explicit way to change a card's translation and definition (null clears). Guarded like
    /// every revisioned write: a stale <paramref name="expectedRevision"/> loses and the result
    /// carries the stored card, without its examples (null when not the user's). A deleted card takes
    /// no update.
    /// </summary>
    Task<RevisionedWrite<VocabularyWord>> UpdateWordAsync(
        Guid userId, Guid wordId, string? translation, string? definition, long expectedRevision, CancellationToken ct);

    /// <summary>Soft-deletes the card (sets <c>deleted_at</c>, bumps the revision); false when not the user's or already deleted.</summary>
    Task<bool> DeleteWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>Brings a deleted card back, schedule and examples intact; false when not the user's or not deleted.</summary>
    Task<bool> RestoreWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>One of the user's cards, deleted or not, with its examples; null when not the user's.</summary>
    Task<VocabularyWord?> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>
    /// Adds an example to a card and bumps the card's <c>updated_at</c>, once per
    /// <c>(UserId, OperationId)</c>. A retry with the same payload hash returns the stored row
    /// (<see cref="WriteOutcome.Replayed"/>), even when the card has been deleted since; one with a
    /// different hash is a <see cref="WriteOutcome.OperationConflict"/>. A new operation on a deleted
    /// card is <see cref="WriteOutcome.Deleted"/>, on a card the user does not have
    /// <see cref="WriteOutcome.NotFound"/>. Only a created row changes anything.
    /// </summary>
    Task<WriteResult<VocabularyExample>> AddExampleAsync(Guid userId, VocabularyExample example, CancellationToken ct);

    /// <summary>
    /// Records an answer, once per <c>(UserId, OperationId)</c> with the outcomes of
    /// <see cref="AddExampleAsync"/>. In one transaction, with the card locked, <paramref name="schedule"/>
    /// computes the next schedule from the card's current row; the review stores the card's stage
    /// before and the schedule's stage after (set on <paramref name="review"/>), and the card moves to
    /// the schedule, due at the server's time plus the interval. Two answers in flight on one card
    /// therefore apply one after the other. <paramref name="schedule"/> must be pure: it may run on a
    /// replay or a conflict on a live card, and its result is then discarded. A replay, a conflict, a
    /// deleted or a missing card changes nothing; the last two never call it.
    /// </summary>
    Task<WriteResult<VocabularyReview>> RecordReviewAsync(
        Guid userId, VocabularyReview review, Func<VocabularyWord, ReviewSchedule> schedule, CancellationToken ct);

    /// <summary>The user's cards that are not deleted and are due at <paramref name="now"/>, earliest first, at most <paramref name="limit"/>.</summary>
    Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct);
}

/// <summary>What <see cref="IVocabularyRepository.SaveWordAsync"/> found under the word's key.</summary>
public enum WordSaveOutcome
{
    /// <summary>Nothing: a new card was created.</summary>
    Created,

    /// <summary>A live card, now the one the caller holds (its id may differ from the caller's).</summary>
    Existing,

    /// <summary>A tombstone, returned unchanged (409 <c>deleted</c>; offer a restore).</summary>
    Deleted,

    /// <summary>No card under the key, and the client's id is another card's: nothing written (409 <c>id_conflict</c>).</summary>
    IdConflict,
}

/// <summary>The stored card, its examples not loaded; null only for <see cref="WordSaveOutcome.IdConflict"/>.</summary>
public sealed record SavedWord(WordSaveOutcome Outcome, VocabularyWord? Word);

/// <summary>A card's schedule after an answer, as the SRS engine computes it; the due time follows from the interval.</summary>
public sealed record ReviewSchedule(int Stage, decimal IntervalDays, int ConsecutiveCorrect);
