using Domain.Vocabulary;

namespace Application.Vocabulary;

/// <summary>
/// The V2 vocabulary (tables <c>vocabulary_words</c> + <c>vocabulary_examples</c> +
/// <c>vocabulary_reviews</c>, one aggregate; ADR-031). Every method is scoped to <c>userId</c>
/// (docs/01-architecture/data-access.md rule 7); an entity naming another user, or a write naming a
/// card that is not the user's, is an <see cref="ArgumentException"/>. Neither the SRS math nor the
/// payload hash is here: a review arrives with the function that computes the schedule, an example or
/// review with its <c>PayloadSha256</c> (v2-sync-protocol.md, "operation_id rules"). A card's
/// <c>revision</c> moves only on explicit edit, delete and restore; every write the sync feed must
/// show bumps its <c>updated_at</c>. Input validation (hash format, text lengths, non-blank,
/// non-negative, provenance pointing at the user's own book and file) is the API's job: a caller bug
/// surfaces as a <c>PostgresException</c> from the schema (data-access.md rule 8).
/// </summary>
public interface IVocabularyRepository
{
    /// <summary>
    /// Saves the user's word: creates the card (<see cref="WordSaveOutcome.Created"/>), or finds the
    /// one already stored under the same language and <see cref="VocabularyWord.WordKey"/>, whatever
    /// its id (<see cref="WordSaveOutcome.Existing"/>), and adds <paramref name="example"/> to it, in
    /// one transaction. Saving again never changes the card: not its schedule, not its translation or
    /// definition (those are used only when the card is created; changing them is
    /// <see cref="UpdateWordAsync"/>). A deleted card is returned unchanged
    /// (<see cref="WordSaveOutcome.Deleted"/>) and takes no example, though a replay of one it took
    /// before is still answered (<see cref="WriteOutcome.Replayed"/>); <see cref="RestoreWordAsync"/>
    /// it first. The example is attached to the stored card, whatever its <c>WordId</c> says, and is
    /// idempotent as in <see cref="AddExampleAsync"/>.
    /// </summary>
    Task<SavedWord> SaveWordAsync(Guid userId, VocabularyWord word, VocabularyExample? example, CancellationToken ct);

    /// <summary>
    /// The explicit way to change a card's translation and definition (null clears). Guarded like
    /// every revisioned write: a stale <paramref name="expectedRevision"/> loses and the result
    /// carries the stored card (null when not the user's). A deleted card takes no update.
    /// </summary>
    Task<UpdateWordResult> UpdateWordAsync(
        Guid userId, Guid wordId, string? translation, string? definition, long expectedRevision, CancellationToken ct);

    /// <summary>Soft-deletes the card (sets <c>deleted_at</c>, bumps the revision); false when not the user's or already deleted.</summary>
    Task<bool> DeleteWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>Brings a deleted card back, schedule and examples intact; false when not the user's or not deleted.</summary>
    Task<bool> RestoreWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>One of the user's cards, deleted or not, with its examples; null when not the user's.</summary>
    Task<VocabularyWord?> GetWordAsync(Guid userId, Guid wordId, CancellationToken ct);

    /// <summary>
    /// Adds an example, once per <c>(UserId, OperationId)</c>. A retry with the same payload hash
    /// returns the stored row (<see cref="WriteOutcome.Replayed"/>) even when the card has been deleted
    /// since; one with a different hash is a <see cref="WriteOutcome.OperationConflict"/>. A new
    /// operation on a deleted card is <see cref="WriteOutcome.Deleted"/>. Only a created row changes anything.
    /// </summary>
    Task<WriteResult<VocabularyExample>> AddExampleAsync(Guid userId, VocabularyExample example, CancellationToken ct);

    /// <summary>
    /// Records an answer, once per <c>(UserId, OperationId)</c> with the outcomes of
    /// <see cref="AddExampleAsync"/>. In one transaction, with the card locked, <paramref name="schedule"/>
    /// computes the card's next schedule from its current row; the review stores the card's stage
    /// before and the schedule's stage after, and the card moves to the schedule. Two answers in flight
    /// on one card therefore apply one after the other. A replay, a conflict or a deleted card never
    /// calls <paramref name="schedule"/> and changes nothing.
    /// </summary>
    Task<WriteResult<VocabularyReview>> RecordReviewAsync(
        Guid userId, VocabularyReview review, Func<VocabularyWord, ReviewSchedule> schedule, CancellationToken ct);

    /// <summary>The user's cards that are not deleted and are due at <paramref name="now"/>, earliest first, at most <paramref name="limit"/>.</summary>
    Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct);
}

/// <summary>What became of a write keyed by an operation id (v2-sync-protocol.md, "operation_id rules").</summary>
public enum WriteOutcome
{
    /// <summary>First time this operation was seen: the row was stored.</summary>
    Created,

    /// <summary>A retry of a stored operation with the same payload: nothing changed.</summary>
    Replayed,

    /// <summary>The operation id is taken by a different payload: nothing changed (409 <c>operation_conflict</c>).</summary>
    OperationConflict,

    /// <summary>A new operation on a deleted card: nothing changed (409 <c>deleted</c>).</summary>
    Deleted,
}

/// <summary>
/// The outcome of an idempotent write and the stored row under its operation id: the new row
/// (<see cref="WriteOutcome.Created"/>), the one already there (<see cref="WriteOutcome.Replayed"/>,
/// <see cref="WriteOutcome.OperationConflict"/>), or null (<see cref="WriteOutcome.Deleted"/>).
/// </summary>
public sealed record WriteResult<T>(WriteOutcome Outcome, T? Row);

/// <summary>What <see cref="IVocabularyRepository.SaveWordAsync"/> found under the word's key.</summary>
public enum WordSaveOutcome
{
    /// <summary>Nothing: a new card was created.</summary>
    Created,

    /// <summary>A live card, now the one the caller holds (its id may differ from the caller's).</summary>
    Existing,

    /// <summary>A tombstone, returned unchanged (409 <c>deleted</c>; offer a restore).</summary>
    Deleted,
}

/// <summary>The stored card (its examples not loaded), and what became of the example (null: none given, or the card is deleted).</summary>
public sealed record SavedWord(WordSaveOutcome Outcome, VocabularyWord Word, WriteResult<VocabularyExample>? Example);

/// <summary>
/// <see cref="Accepted"/>: <see cref="Current"/> is the stored card with its new revision.
/// Otherwise the update lost and <see cref="Current"/> is what is stored instead (null: not the user's).
/// </summary>
public sealed record UpdateWordResult(bool Accepted, VocabularyWord? Current);

/// <summary>A card's schedule after an answer, as the SRS engine computes it.</summary>
public sealed record ReviewSchedule(int Stage, decimal IntervalDays, int ConsecutiveCorrect, DateTimeOffset NextReviewAt);
