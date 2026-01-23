using TextStack.Search.Contracts;

namespace TextStack.Search.Abstractions;

public interface ISearchIndexer
{
    Task IndexAsync(IndexDocument document, CancellationToken ct = default);

    Task IndexBatchAsync(IEnumerable<IndexDocument> documents, CancellationToken ct = default);

    Task RemoveAsync(string documentId, CancellationToken ct = default);

    Task RemoveBySiteAsync(Guid siteId, CancellationToken ct = default);
}
