using System.Runtime.CompilerServices;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

public class ModelGatewayTests
{
    // Routing config mirrors the appsettings shape.
    private static ModelGateway BuildGateway()
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "openai",
                ["Ai:Routes:translate"] = "openai-translate",
            })
            .Build();

        var services = new ServiceCollection();
        // Stub providers keyed like the real decorated registrations; each echoes
        // its key back as ModelId so we can assert which provider answered.
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEchoLlm("openai"));
        services.AddKeyedSingleton<ILlmService>("openai-translate", new KeyEchoLlm("openai-translate"));
        var sp = services.BuildServiceProvider();

        // Budgets OFF → routing unaffected (budget routing covered in ModelGatewayBudgetTests).
        return new ModelGateway(
            sp, cfg,
            new NoopSpendTracker(), BudgetOptions.Empty, NullLogger<ModelGateway>.Instance);
    }

    /// <summary>No-op tracker: budgets are off for these routing-precedence tests.</summary>
    private sealed class NoopSpendTracker : ISpendTracker
    {
        public decimal SpentTodayUsd(string featureTag) => 0m;
        public void Record(string featureTag, decimal costUsd) { }
    }

    [Theory]
    [InlineData("explain", "openai")]
    [InlineData("translate", "openai-translate")]
    [InlineData("no-such-feature", "openai")] // unmapped → default
    [InlineData(null, "openai")]               // no tag → default
    public async Task CompleteAsync_RoutesByFeatureTag(string? feature, string expectedProvider)
    {
        var gateway = BuildGateway();
        var request = new LlmRequest("system", Array.Empty<LlmMessage>(), 10, FeatureTag: feature);

        var response = await gateway.CompleteAsync(request, CancellationToken.None);

        Assert.Equal(expectedProvider, response.ModelId);
    }

    [Fact]
    public async Task Route_ConfigRouteNamesUnknownProvider_FallsBackToDefault_NoThrow()
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "ghost-provider",
            })
            .Build();
        var services = new ServiceCollection();
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEchoLlm("openai"));
        var gateway = new ModelGateway(
            services.BuildServiceProvider(), cfg,
            new NoopSpendTracker(), BudgetOptions.Empty, NullLogger<ModelGateway>.Instance);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "explain"), CancellationToken.None);

        Assert.Equal("openai", resp.ModelId);
    }

    private sealed class KeyEchoLlm(string key) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse("", Array.Empty<ToolCall>(), new LlmUsage(0, 0, 0m), key, Guid.NewGuid()));

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield return new LlmDelta(TextDelta: key);
        }
    }
}
