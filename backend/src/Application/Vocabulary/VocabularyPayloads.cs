using Application.Common;
using Domain.Vocabulary;

namespace Application.Vocabulary;

/// <summary>
/// The <c>payload_sha256</c> of a vocabulary append: the "Canonical JSON" table's Example and Review
/// rows, exactly these fields under these names, through <see cref="CanonicalPayload.Sha256"/>.
/// Public so the M3 ETL hashes a migrated row through the same two functions as the API.
/// </summary>
public static class VocabularyPayloads
{
    /// <summary>An example names its card by the card's stored key, not its id, so a save-by-key and an add-by-id hash alike.</summary>
    public static string ExampleSha256(VocabularyWord card, VocabularyExample e) =>
        CanonicalPayload.Sha256(new Example(card.Language, card.WordKey, e.Sentence, e.ContextualTranslation, e.BookId, e.FileId, e.ChapterKey, e.BookTitle));

    /// <summary>Not the stages: the server computes them.</summary>
    public static string ReviewSha256(VocabularyReview r) =>
        CanonicalPayload.Sha256(new Review(r.WordId, r.ReviewMode, r.IsCorrect, r.ResponseTimeMs, r.ClientRecordedAt));

    private sealed record Example(
        string Language, string WordKey, string Sentence, string? ContextualTranslation, Guid? BookId, Guid? FileId, string? ChapterKey, string? BookTitle);

    private sealed record Review(Guid WordId, string ReviewMode, bool IsCorrect, int? ResponseTimeMs, DateTimeOffset ClientRecordedAt);
}
