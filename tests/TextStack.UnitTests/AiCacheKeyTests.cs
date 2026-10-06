using Api.Endpoints;
using Application.Ai;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests;

/// <summary>
/// Explain + Translate file caches must miss after a prompt or model change — otherwise a prompt fix
/// (#712, language names) stays invisible for the 30-day cache TTL.
/// </summary>
public class AiCacheKeyTests
{
    [Fact]
    public void ExplainCacheKey_PromptVersionChanges_KeyChanges()
    {
        var a = ExplainEndpoints.ComputeCacheKey("w", "s", null, "uk", "gpt-4.1-mini", promptVersion: 1);
        var b = ExplainEndpoints.ComputeCacheKey("w", "s", null, "uk", "gpt-4.1-mini", promptVersion: 2);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void ExplainCacheKey_ModelChanges_KeyChanges()
    {
        var a = ExplainEndpoints.ComputeCacheKey("w", "s", null, "uk", "gpt-4.1-mini", ExplainPrompt.Version);
        var b = ExplainEndpoints.ComputeCacheKey("w", "s", null, "uk", "gpt-4.1-nano", ExplainPrompt.Version);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void TranslateCacheKey_PromptVersionChanges_KeyChanges()
    {
        var a = TranslationEndpoints.ComputeCacheKey("w", "en", "uk", null, null, "gpt-4.1-nano", promptVersion: 1);
        var b = TranslationEndpoints.ComputeCacheKey("w", "en", "uk", null, null, "gpt-4.1-nano", promptVersion: 2);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void TranslateCacheKey_ModelChanges_KeyChanges()
    {
        var a = TranslationEndpoints.ComputeCacheKey("w", "en", "uk", null, null, "gpt-4.1-nano", TranslatePrompt.Version);
        var b = TranslationEndpoints.ComputeCacheKey("w", "en", "uk", null, null, "gpt-4.1-mini", TranslatePrompt.Version);
        Assert.NotEqual(a, b);
    }

    [Fact]
    public void CacheModelId_ConfigUnsetOrSet_ResolvesSameModelAsProvider()
    {
        var empty = new ConfigurationBuilder().Build();
        Assert.Equal("gpt-4.1-mini", ExplainEndpoints.CacheModelId(empty));
        Assert.Equal("gpt-4.1-nano", TranslationEndpoints.CacheModelId(empty));

        var set = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["OpenAI:Explain:Model"] = "x",
            ["OpenAI:Model"] = "y",
        }).Build();
        Assert.Equal("x", ExplainEndpoints.CacheModelId(set));
        Assert.Equal("y", TranslationEndpoints.CacheModelId(set));
    }
}
