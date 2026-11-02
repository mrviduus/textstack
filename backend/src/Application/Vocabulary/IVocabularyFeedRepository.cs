using Domain.Vocabulary;

namespace Application.Vocabulary;

/// <summary>
/// Pages of the user's vocabulary cards, each with its live examples (oldest first), as the two
/// multi-card reads need them: the review queue and the sync feed (v2-sync-protocol.md "Pull and
/// push", M1.3 delta 3). Split from <see cref="IVocabularyRepository"/>, which writes and reads one
/// card; same tables, same ownership rule (data-access.md rule 7).
/// </summary>
public interface IVocabularyFeedRepository
{
    /// <summary>The user's cards that are neither deleted nor retired and are due at <paramref name="now"/>, earliest first, at most <paramref name="limit"/>.</summary>
    Task<IReadOnlyList<VocabularyWord>> ListDueAsync(Guid userId, DateTimeOffset now, int limit, CancellationToken ct);

    /// <summary>
    /// The user's cards changed after <c>(since, afterId)</c>, tombstones included, ordered by
    /// <c>(updated_at, id)</c>: one page of the vocabulary feed.
    /// </summary>
    Task<IReadOnlyList<VocabularyWord>> ListChangedAsync(Guid userId, DateTimeOffset since, Guid afterId, int limit, CancellationToken ct);
}
