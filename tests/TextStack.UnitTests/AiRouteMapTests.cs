using Microsoft.Extensions.Configuration;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// Reading the route table for startup validation. The precedence here deliberately mirrors
/// <c>ModelGateway.ResolveRoute</c> minus the registry tier (which needs a DB at startup), so these
/// tests double as the guard against the two drifting.
/// </summary>
public class AiRouteMapTests
{
    /// <summary>The Worker's real route table, which is where a dead Ollama actually bites.</summary>
    private static IConfiguration WorkerRoutes() =>
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Ai:DefaultProvider"] = "ollama",
            ["Ai:Routes:distractor"] = "ollama",
            ["Ai:Routes:bookmeta"] = "ollama",
            ["Ai:Routes:bookmeta.agent"] = "openai-explain",
            ["Ai:Routes:tagsuggestion"] = "ollama",
            ["Ai:Routes:pdf.parse"] = "openai-pdf",
            ["Ai:Routes:rag.summarize"] = "openai",
            ["Ai:Routes:_SummarizeComment"] = "a documentation key, not a route",
        }).Build();

    [Fact]
    public void Build_GroupsFeatureTagsByProvider()
    {
        var map = AiRouteMap.Build(WorkerRoutes());

        Assert.Equal(
            [AiRouteMap.DefaultProviderTag, "bookmeta", "distractor", "tagsuggestion"],
            map["ollama"]);
        Assert.Equal(["bookmeta.agent"], map["openai-explain"]);
        Assert.Equal(["pdf.parse"], map["openai-pdf"]);
    }

    [Fact]
    public void Build_SkipsUnderscoreCommentKeys()
    {
        var map = AiRouteMap.Build(WorkerRoutes());

        Assert.DoesNotContain(map, kv => kv.Value.Any(t => t.StartsWith('_')));
    }

    [Fact]
    public void Build_SkipsBlankRouteValues()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Ai:Routes:explain"] = "   ",
        }).Build();

        Assert.Empty(AiRouteMap.Build(config));
    }

    [Theory]
    [InlineData("bookmeta", "ollama")]
    [InlineData("bookmeta.agent", "openai-explain")]   // a dot is not a config separator
    [InlineData("pdf.parse", "openai-pdf")]
    [InlineData("never-routed", "ollama")]             // → DefaultProvider
    [InlineData(null, "ollama")]
    public void ResolveProviderKey_FollowsGatewayPrecedence(string? featureTag, string expected) =>
        Assert.Equal(expected, AiRouteMap.ResolveProviderKey(WorkerRoutes(), featureTag));

    [Fact]
    public void ResolveProviderKey_NoRouteNoDefault_FallsBackToOpenAi()
    {
        var empty = new ConfigurationBuilder().AddInMemoryCollection([]).Build();

        Assert.Equal("openai", AiRouteMap.ResolveProviderKey(empty, "anything"));
    }

    /// <summary>
    /// Regression for the drift that made the previous startup check useless: its hardcoded
    /// provider set omitted <c>openai-pdf</c>, so the most expensive route was never validated.
    /// A prefix rule cannot drift.
    /// </summary>
    [Fact]
    public void ProbeKindFor_EveryRegisteredProviderKey_IsClassified()
    {
        foreach (var key in AiProviderKeys.Registered)
            Assert.NotEqual(ProviderProbeKind.Unknown, AiRouteMap.ProbeKindFor(key));
    }

    [Theory]
    [InlineData("ollama", ProviderProbeKind.OllamaHttp)]
    [InlineData("openai", ProviderProbeKind.OpenAiKey)]
    [InlineData("openai-pdf", ProviderProbeKind.OpenAiKey)]
    [InlineData("openai-whatever-we-add-next", ProviderProbeKind.OpenAiKey)]
    [InlineData("anthropic", ProviderProbeKind.Unknown)]
    public void ProbeKindFor_ClassifiesByPrefix(string key, ProviderProbeKind expected) =>
        Assert.Equal(expected, AiRouteMap.ProbeKindFor(key));

    [Fact]
    public void FormatUnreachable_ReadsAsAnOperatorSentence() =>
        Assert.Equal(
            "bookmeta, distractor, tagsuggestion → ollama (unreachable)",
            AiRouteMap.FormatUnreachable("ollama", ["bookmeta", "distractor", "tagsuggestion"], "unreachable"));
}
