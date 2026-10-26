using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using OpenAI;
using OpenAI.Embeddings;
using TextStack.Ai.Core;

namespace TextStack.Ai.Llm;

/// <summary>
/// OpenAI implementation of <see cref="IEmbeddingService"/> (vocabulary concept clusters, AI-058; the RAG it was built for is gone). Wraps the OpenAI
/// SDK <see cref="EmbeddingClient"/> for <c>text-embedding-3-small</c> (1536-d), mirroring
/// <see cref="OpenAiLlmClient"/>'s config/construction. Stateless and thread-safe; registered
/// as a singleton. Cost is logged per batch via <see cref="ModelPricing"/>.
/// </summary>
public sealed class OpenAiEmbeddingClient : IEmbeddingService
{
    private const string DefaultModel = "text-embedding-3-small";

    private readonly EmbeddingClient _client;
    private readonly string _model;
    private readonly ILogger<OpenAiEmbeddingClient> _logger;

    public int Dimensions => 1536;

    public OpenAiEmbeddingClient(IConfiguration config, ILogger<OpenAiEmbeddingClient> logger)
    {
        _logger = logger;

        // Same empty-key trap guard as OpenAiLlmClient — an empty string flows into the SDK
        // and surfaces as a cryptic "Value cannot be an empty string" deep in the stack.
        var apiKey = config["OpenAI:ApiKey"];
        if (string.IsNullOrWhiteSpace(apiKey))
            apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey))
            throw new InvalidOperationException("OPENAI_API_KEY not configured (OpenAI:ApiKey / OPENAI_API_KEY is empty)");

        _model = config["OpenAI:Embedding:Model"]
            ?? Environment.GetEnvironmentVariable("OPENAI_EMBEDDING_MODEL")
            ?? DefaultModel;

        _client = new OpenAIClient(apiKey).GetEmbeddingClient(_model);
    }

    public async Task<float[]> EmbedAsync(string text, CancellationToken ct)
        => (await EmbedBatchAsync([text], ct))[0];

    public async Task<IReadOnlyList<float[]>> EmbedBatchAsync(IReadOnlyList<string> texts, CancellationToken ct)
    {
        if (texts.Count == 0)
            return [];

        var options = new EmbeddingGenerationOptions { Dimensions = Dimensions };
        var result = await _client.GenerateEmbeddingsAsync(texts, options, ct);
        var collection = result.Value;

        // Order by Index defensively (the API returns request order, but don't rely on it).
        var vectors = collection
            .OrderBy(e => e.Index)
            .Select(e => e.ToFloats().ToArray())
            .ToArray();

        var inputTokens = collection.Usage?.InputTokenCount ?? 0;
        if (!ModelPricing.IsPriced(_model))
            _logger.LogWarning("No pricing entry for embedding model {Model}; cost recorded as 0", _model);
        var cost = ModelPricing.CostUsd(_model, inputTokens, 0);
        _logger.LogInformation(
            "Embedded {Count} texts ({Tokens} tokens) via {Model} — ${Cost:F6}",
            vectors.Length, inputTokens, _model, cost);

        return vectors;
    }
}
