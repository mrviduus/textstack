namespace TextStack.Search.Chunking;

/// <summary>
/// Interface for splitting documents into chunks for vector search.
/// </summary>
public interface IDocumentChunker
{
    /// <summary>
    /// Splits a document into overlapping chunks.
    /// </summary>
    /// <param name="text">The document text to chunk.</param>
    /// <returns>List of document chunks.</returns>
    IReadOnlyList<DocumentChunk> Chunk(string text);

    /// <summary>
    /// Splits a document into overlapping chunks with custom parameters.
    /// </summary>
    /// <param name="text">The document text to chunk.</param>
    /// <param name="chunkSize">Target chunk size in tokens.</param>
    /// <param name="overlap">Number of overlapping tokens between chunks.</param>
    /// <returns>List of document chunks.</returns>
    IReadOnlyList<DocumentChunk> Chunk(string text, int chunkSize, int overlap);
}
