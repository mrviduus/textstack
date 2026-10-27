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
                ["Ai:Routes:translate"] = "openai",
                ["Ai:Routes:distractor"] = "ollama",
            })
            .Build();

        var services = new ServiceCollection();
        // Stub providers keyed like the real decorated registrations; each echoes
        // its key back as ModelId so we can assert which provider answered.
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEchoLlm("openai"));
        services.AddKeyedSingleton<ILlmService>("ollama", new KeyEchoLlm("ollama"));
        var sp = services.BuildServiceProvider();

        // No registry routes → falls through to the config route (these tests cover config routing).
        var routes = new StubRouteProvider();
        // Budgets OFF → routing unaffected (budget routing covered in ModelGatewayBudgetTests).
        return new ModelGateway(
            sp, cfg, routes,
            new NoopSpendTracker(), BudgetOptions.Empty, NullLogger<ModelGateway>.Instance);
    }

    /// <summary>No-op tracker: budgets are off for these routing-precedence tests.</summary>
    private sealed class NoopSpendTracker : ISpendTracker
    {
        public decimal SpentTodayUsd(string featureTag) => 0m;
        public void Record(string featureTag, decimal costUsd) { }
    }

    /// <summary>Registry route provider returning a fixed map (empty = no registry hit).</summary>
    private sealed class StubRouteProvider(Dictionary<string, string>? routes = null) : IModelRouteProvider
    {
        private readonly Dictionary<string, string> _routes = routes ?? new();
        public string? PrimaryProviderKey(string featureTag) =>
            _routes.TryGetValue(featureTag, out var k) ? k : null;
        public void Invalidate() { }
    }

    [Theory]
    [InlineData("explain", "openai")]
    [InlineData("translate", "openai")]
    [InlineData("distractor", "ollama")]
    [InlineData("no-such-feature", "openai")] // unmapped → default
    [InlineData(null, "openai")]               // no tag → default
    public async Task CompleteAsync_RoutesByFeatureTag(string? feature, string expectedProvider)
    {
        var gateway = BuildGateway();
        var request = new LlmRequest("system", Array.Empty<LlmMessage>(), 10, FeatureTag: feature);

        var response = await gateway.CompleteAsync(request, CancellationToken.None);

        Assert.Equal(expectedProvider, response.ModelId);
    }

    // ── Table-driven primary routing precedence (Phase 12 RLOps) ──────────────────

    // Build a gateway with an explicit route provider + the standard openai/ollama stubs.
    private static ModelGateway BuildGateway(IModelRouteProvider routes)
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "openai",       // config route
                ["Ai:Routes:distractor"] = "ollama",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEchoLlm("openai"));
        services.AddKeyedSingleton<ILlmService>("ollama", new KeyEchoLlm("ollama"));
        var sp = services.BuildServiceProvider();

        return new ModelGateway(
            sp, cfg, routes,
            new NoopSpendTracker(), BudgetOptions.Empty, NullLogger<ModelGateway>.Instance);
    }

    [Fact]
    public async Task Route_RegistryHit_BeatsConfigRoute()
    {
        // Config says explain→openai, registry overrides to ollama → registry wins.
        var routes = new StubRouteProvider(new() { ["explain"] = "ollama" });
        var gateway = BuildGateway(routes);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "explain"), CancellationToken.None);

        Assert.Equal("ollama", resp.ModelId);
    }

    [Fact]
    public async Task Route_NoRegistry_FallsBackToConfigRoute()
    {
        var routes = new StubRouteProvider(); // empty → no registry hit
        var gateway = BuildGateway(routes);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "explain"), CancellationToken.None);

        Assert.Equal("openai", resp.ModelId); // config route
    }

    [Fact]
    public async Task Route_NoRegistryNoConfig_FallsBackToDefaultProvider()
    {
        var routes = new StubRouteProvider();
        var gateway = BuildGateway(routes);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "no-route-feature"), CancellationToken.None);

        Assert.Equal("openai", resp.ModelId); // DefaultProvider
    }

    [Fact]
    public async Task Route_RegistryUnknownProviderKey_FallsBackToConfig_NoThrow()
    {
        // Registry names a provider key with no keyed registration → must NOT throw; the
        // gateway falls back to the config route (explain→openai).
        var routes = new StubRouteProvider(new() { ["explain"] = "ghost-provider" });
        var gateway = BuildGateway(routes);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "explain"), CancellationToken.None);

        Assert.Equal("openai", resp.ModelId);
    }

    [Fact]
    public async Task Route_RouteProviderThrows_GatewayStillResolvesViaConfig()
    {
        // The provider contract is never-throws, but the gateway ALSO guards the lookup so a
        // misbehaving provider can't break a real call — it falls through to the config route.
        var routes = new ThrowingRouteProvider();
        var gateway = BuildGateway(routes);

        var resp = await gateway.CompleteAsync(
            new LlmRequest("s", Array.Empty<LlmMessage>(), 10, FeatureTag: "explain"), CancellationToken.None);

        Assert.Equal("openai", resp.ModelId); // config route, no throw
    }

    /// <summary>A deliberately-broken provider (violates the never-throw contract) — used to
    /// document that a thrown lookup propagates rather than being silently swallowed by the
    /// gateway (the contract puts the never-throw guarantee in the IMPL, not the gateway).</summary>
    private sealed class ThrowingRouteProvider : IModelRouteProvider
    {
        public string? PrimaryProviderKey(string featureTag) => throw new InvalidOperationException("boom");
        public void Invalidate() { }
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
