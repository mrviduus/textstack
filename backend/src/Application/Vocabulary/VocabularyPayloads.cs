using Application.Common;

namespace Application.Vocabulary;

/// <summary>
/// The <c>payload_sha256</c> of a vocabulary append: the "Canonical JSON" table's Example and Review
/// rows, exactly these fields under these names, through <see cref="CanonicalPayload.Sha256"/>.
/// Public so the M3 ETL hashes a migrated row through the same two functions as the API.
/// </summary>
public static class VocabularyPayloads
{
    /// <summary>An example names its card by key, not id, so a save-by-key and an add-by-id hash alike.</summary>
    public static string ExampleSha256(
        string language, string wordKey, string sentence, string? contextualTranslation,
        Guid? bookId, Guid? fileId, string? chapterKey, string? bookTitle) =>
        CanonicalPayload.Sha256(new Example(language, wordKey, sentence, contextualTranslation, bookId, fileId, chapterKey, bookTitle));

    /// <summary>Not the stages: the server computes them.</summary>
    public static string ReviewSha256(Guid wordId, string reviewMode, bool isCorrect, int? responseTimeMs, DateTimeOffset clientRecordedAt) =>
        CanonicalPayload.Sha256(new Review(wordId, reviewMode, isCorrect, responseTimeMs, clientRecordedAt));

    private sealed record Example(
        string Language, string WordKey, string Sentence, string? ContextualTranslation, Guid? BookId, Guid? FileId, string? ChapterKey, string? BookTitle);

    private sealed record Review(Guid WordId, string ReviewMode, bool IsCorrect, int? ResponseTimeMs, DateTimeOffset ClientRecordedAt);
}
