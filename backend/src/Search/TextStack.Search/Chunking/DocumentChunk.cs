namespace TextStack.Search.Chunking;

/// <summary>
/// Represents a chunk of a document for vector search indexing.
/// </summary>
public sealed record DocumentChunk(
    /// <summary>
    /// Zero-based index of this chunk within the document.
    /// </summary>
    int Index,

    /// <summary>
    /// The text content of this chunk.
    /// </summary>
    string Content,

    /// <summary>
    /// Character offset from the start of the original document.
    /// </summary>
    int StartOffset,

    /// <summary>
    /// Character offset of the end of this chunk in the original document.
    /// </summary>
    int EndOffset,

    /// <summary>
    /// Approximate token count for this chunk.
    /// </summary>
    int TokenCount
)
{
    /// <summary>
    /// Length of the chunk content in characters.
    /// </summary>
    public int Length => Content.Length;

    /// <summary>
    /// Creates a chunk with calculated offsets.
    /// </summary>
    public static DocumentChunk Create(int index, string content, int startOffset, int tokenCount) =>
        new(index, content, startOffset, startOffset + content.Length, tokenCount);
}
