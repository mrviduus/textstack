using Domain.Entities;
using TextStack.Ai.Llm;
using Worker.Services;

namespace TextStack.UnitTests;

public class ModelPricingEmbeddingTests
{
    [Fact]
    public void IsPriced_EmbeddingModel_True()
        => Assert.True(ModelPricing.IsPriced("text-embedding-3-small"));

    [Theory]
    [InlineData(1_000_000, 0.02)] // $0.02 / 1M input tokens
    [InlineData(500_000, 0.01)]
    [InlineData(0, 0.0)]
    public void CostUsd_EmbeddingInputOnly_ComputesInputPrice(int inputTokens, double expected)
        => Assert.Equal((decimal)expected, ModelPricing.CostUsd("text-embedding-3-small", inputTokens, outputTokens: 0));

    [Fact]
    public void CostUsd_EmbeddingIgnoresOutputTokens()
        // Embeddings have no output price, so output tokens must not add cost.
        => Assert.Equal(0.02m, ModelPricing.CostUsd("text-embedding-3-small", 1_000_000, 9_999));

    [Fact]
    public void CostUsd_UnknownModel_Zero()
        => Assert.Equal(0m, ModelPricing.CostUsd("text-embedding-unknown", 1_000_000, 0));
}
