using System.Text.RegularExpressions;

namespace TextStack.Search.Chunking;

/// <summary>
/// Splits documents into overlapping chunks with sentence boundary detection.
/// Designed for vector search embeddings.
/// </summary>
public sealed partial class OverlappingChunker : IDocumentChunker
{
    /// <summary>
    /// Default chunk size in tokens (approximately 300 tokens ~ 1200 chars).
    /// </summary>
    public const int DefaultChunkSize = 300;

    /// <summary>
    /// Default overlap in tokens (20% of chunk size).
    /// </summary>
    public const int DefaultOverlap = 60;

    /// <summary>
    /// Approximate characters per token (for estimation).
    /// </summary>
    private const double CharsPerToken = 4.0;

    private readonly int _defaultChunkSize;
    private readonly int _defaultOverlap;

    public OverlappingChunker(int defaultChunkSize = DefaultChunkSize, int defaultOverlap = DefaultOverlap)
    {
        _defaultChunkSize = defaultChunkSize;
        _defaultOverlap = defaultOverlap;
    }

    public IReadOnlyList<DocumentChunk> Chunk(string text) =>
        Chunk(text, _defaultChunkSize, _defaultOverlap);

    public IReadOnlyList<DocumentChunk> Chunk(string text, int chunkSize, int overlap)
    {
        if (string.IsNullOrWhiteSpace(text))
            return [];

        if (chunkSize <= 0)
            throw new ArgumentOutOfRangeException(nameof(chunkSize), "Chunk size must be positive");

        if (overlap < 0 || overlap >= chunkSize)
            throw new ArgumentOutOfRangeException(nameof(overlap), "Overlap must be >= 0 and < chunk size");

        // Split into sentences
        var sentences = SplitIntoSentences(text);
        if (sentences.Count == 0)
            return [];

        // Calculate target chunk size in characters
        var targetCharsPerChunk = (int)(chunkSize * CharsPerToken);
        var overlapChars = (int)(overlap * CharsPerToken);

        var chunks = new List<DocumentChunk>();
        var currentChunk = new List<SentenceInfo>();
        var currentChunkChars = 0;
        var chunkIndex = 0;
        var chunkStartOffset = 0;

        foreach (var sentence in sentences)
        {
            // If adding this sentence would exceed target size and we have content
            if (currentChunkChars + sentence.Length > targetCharsPerChunk && currentChunk.Count > 0)
            {
                // Create chunk from current sentences
                var chunk = CreateChunk(currentChunk, chunkIndex, chunkStartOffset);
                chunks.Add(chunk);
                chunkIndex++;

                // Calculate overlap: keep sentences from the end that fit within overlap
                var overlapSentences = GetOverlapSentences(currentChunk, overlapChars);
                currentChunk = overlapSentences;
                currentChunkChars = overlapSentences.Sum(s => s.Length);

                if (overlapSentences.Count > 0)
                {
                    chunkStartOffset = overlapSentences[0].StartOffset;
                }
                else
                {
                    chunkStartOffset = sentence.StartOffset;
                }
            }

            currentChunk.Add(sentence);
            currentChunkChars += sentence.Length;
        }

        // Add final chunk if there's remaining content
        if (currentChunk.Count > 0)
        {
            var finalChunk = CreateChunk(currentChunk, chunkIndex, chunkStartOffset);
            chunks.Add(finalChunk);
        }

        return chunks;
    }

    private static List<SentenceInfo> SplitIntoSentences(string text)
    {
        var sentences = new List<SentenceInfo>();
        var matches = SentenceRegex().Matches(text);

        foreach (Match match in matches)
        {
            var content = match.Value.Trim();
            if (!string.IsNullOrEmpty(content))
            {
                sentences.Add(new SentenceInfo(content, match.Index, content.Length));
            }
        }

        // If no sentences found (no punctuation), treat paragraphs as units
        if (sentences.Count == 0)
        {
            var paragraphs = ParagraphRegex().Split(text);
            var offset = 0;

            foreach (var para in paragraphs)
            {
                var trimmed = para.Trim();
                if (!string.IsNullOrEmpty(trimmed))
                {
                    var startIndex = text.IndexOf(trimmed, offset, StringComparison.Ordinal);
                    if (startIndex >= 0)
                    {
                        sentences.Add(new SentenceInfo(trimmed, startIndex, trimmed.Length));
                        offset = startIndex + trimmed.Length;
                    }
                }
            }
        }

        // If still nothing, return the whole text as one sentence
        if (sentences.Count == 0 && !string.IsNullOrWhiteSpace(text))
        {
            sentences.Add(new SentenceInfo(text.Trim(), 0, text.Trim().Length));
        }

        return sentences;
    }

    private static List<SentenceInfo> GetOverlapSentences(List<SentenceInfo> sentences, int overlapChars)
    {
        var result = new List<SentenceInfo>();
        var totalChars = 0;

        // Take sentences from the end until we reach overlap target
        for (var i = sentences.Count - 1; i >= 0; i--)
        {
            if (totalChars >= overlapChars)
                break;

            result.Insert(0, sentences[i]);
            totalChars += sentences[i].Length;
        }

        return result;
    }

    private static DocumentChunk CreateChunk(List<SentenceInfo> sentences, int index, int startOffset)
    {
        var content = string.Join(" ", sentences.Select(s => s.Content));
        var tokenCount = EstimateTokenCount(content);
        return DocumentChunk.Create(index, content, startOffset, tokenCount);
    }

    private static int EstimateTokenCount(string text) =>
        (int)Math.Ceiling(text.Length / CharsPerToken);

    /// <summary>
    /// Matches sentences ending with punctuation (.!?) followed by space or end of string.
    /// Also handles quotes and parentheses.
    /// </summary>
    [GeneratedRegex(@"[^.!?]*[.!?]+(?:\s|$|[""'\)])", RegexOptions.Compiled)]
    private static partial Regex SentenceRegex();

    /// <summary>
    /// Matches paragraph breaks (double newlines).
    /// </summary>
    [GeneratedRegex(@"\n\s*\n", RegexOptions.Compiled)]
    private static partial Regex ParagraphRegex();

    private sealed record SentenceInfo(string Content, int StartOffset, int Length);
}
