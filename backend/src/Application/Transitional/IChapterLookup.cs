using Domain.Transitional;

namespace Application.Transitional;

/// <summary>
/// Transitional's public port for the other features (ADR-034 rule 4): a file version's table of contents
/// and whether it has a chapter. Implemented by <see cref="ChapterReadService"/>.
/// </summary>
public interface IChapterLookup
{
    /// <inheritdoc cref="IBookChapterRepository.ListTocAsync"/>
    Task<IReadOnlyList<BookChapterHeading>> ListTocAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <inheritdoc cref="IBookChapterRepository.ExistsAsync"/>
    Task<bool> ExistsAsync(Guid userId, Guid fileId, string chapterKey, CancellationToken ct);
}
