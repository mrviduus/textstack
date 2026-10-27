using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// The 2026-07-14 incident regression suite. The Worker's <c>Ai:Routes</c> had no <c>pdf.parse</c>
/// entry, so PDF vision parsing fell through to <c>Ai:DefaultProvider: ollama</c> — nothing threw,
/// nothing logged an error, and the only symptom was a CPU-pegged container. The gateway now reports
/// WHY it picked a provider, so "route matched" and "silently defaulted" are distinguishable.
///
/// Also locks that the refactor which produced the reason did not change the resolved key.
/// </summary>
public class ModelGatewayRouteReasonTests
{
    /// <summary>Records route decisions instead of shipping them to Sentry.</summary>
    private sealed class RecordingRouteAlarm : IRouteAlarm
    {
        public List<(string? Tag, string Key, RouteReason Reason)> Calls { get; } = [];

        public void OnRouteResolved(string? featureTag, string resolvedKey, RouteReason reason) =>
            Calls.Add((featureTag, resolvedKey, reason));
    }

    private sealed class NoopSpendTracker : ISpendTracker
    {
        public decimal SpentTodayUsd(string featureTag) => 0m;
        public void Record(string featureTag, decimal costUsd) { }
    }

    private sealed class StubRouteProvider(Dictionary<string, string>? routes = null) : IModelRouteProvider
    {
        private readonly Dictionary<string, string> _routes = routes ?? new();
        public string? PrimaryProviderKey(string featureTag) =>
            _routes.TryGetValue(featureTag, out var k) ? k : null;
        public void Invalidate() { }
    }

    private sealed class KeyEchoLlm(string key) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse(key, [], new LlmUsage(0, 0, 0m), key, Guid.NewGuid()));

        public async IAsyncEnumerable<LlmDelta> StreamAsync(
            LlmRequest request,
            [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
        {
            yield return new LlmDelta(key, null, null, key);
            await Task.CompletedTask;
        }
    }

    private static (ModelGateway Gateway, RecordingRouteAlarm Alarm) Build(
        Dictionary<string, string?> config,
        Dictionary<string, string>? registryRoutes = null)
    {
        var cfg = new ConfigurationBuilder().AddInMemoryCollection(config).Build();

        var services = new ServiceCollection();
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEchoLlm("openai"));
        services.AddKeyedSingleton<ILlmService>("ollama", new KeyEchoLlm("ollama"));
        services.AddKeyedSingleton<ILlmService>("openai-pdf", new KeyEchoLlm("openai-pdf"));
        var sp = services.BuildServiceProvider();

        var alarm = new RecordingRouteAlarm();
        var gateway = new ModelGateway(
            sp, cfg,
            new StubRouteProvider(registryRoutes),
            new NoopSpendTracker(), BudgetOptions.Empty,
            NullLogger<ModelGateway>.Instance, alarm);

        return (gateway, alarm);
    }

    private static async Task<(string Provider, RecordingRouteAlarm Alarm)> RouteAsync(
        Dictionary<string, string?> config, string? featureTag,
        Dictionary<string, string>? registryRoutes = null)
    {
        var (gateway, alarm) = Build(config, registryRoutes);
        var response = await gateway.CompleteAsync(
            new LlmRequest(string.Empty, [new LlmMessage("user", "hi")], 16, FeatureTag: featureTag),
            TestContext.Current.CancellationToken);
        return (response.ModelId, alarm);
    }

    [Fact]
    public async Task Route_ConfigRouteHit_ReportsRouteMatched()
    {
        var (provider, alarm) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "ollama", ["Ai:Routes:pdf.parse"] = "openai-pdf" },
            "pdf.parse");

        Assert.Equal("openai-pdf", provider);
        Assert.Equal(RouteReason.RouteMatched, alarm.Calls.Single().Reason);
    }

    [Fact]
    public async Task Route_RegistryHit_ReportsRouteMatched()
    {
        var (provider, alarm) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "ollama" },
            "pdf.parse",
            registryRoutes: new() { ["pdf.parse"] = "openai-pdf" });

        Assert.Equal("openai-pdf", provider);
        Assert.Equal(RouteReason.RouteMatched, alarm.Calls.Single().Reason);
    }

    /// <summary>The incident configuration verbatim: the Worker had a default but no pdf.parse route.</summary>
    [Fact]
    public async Task Route_NoRouteForFeature_ReportsDefaultFallback()
    {
        var (provider, alarm) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "ollama", ["Ai:Routes:explain"] = "openai" },
            "pdf.parse");

        Assert.Equal("ollama", provider);
        var call = alarm.Calls.Single();
        Assert.Equal("pdf.parse", call.Tag);
        Assert.Equal("ollama", call.Key);
        Assert.Equal(RouteReason.DefaultFallback, call.Reason);
    }

    [Fact]
    public async Task Route_NoFeatureTag_ReportsDefaultFallback()
    {
        var (provider, alarm) = await RouteAsync(new() { ["Ai:DefaultProvider"] = "openai" }, featureTag: null);

        Assert.Equal("openai", provider);
        Assert.Equal(RouteReason.DefaultFallback, alarm.Calls.Single().Reason);
    }

    /// <summary>No default configured at all → the hardcoded "openai", still reported as a fallback.</summary>
    [Fact]
    public async Task Route_NoRouteNoDefault_FallsBackToOpenAi()
    {
        var (provider, alarm) = await RouteAsync(new(), "some.feature");

        Assert.Equal("openai", provider);
        Assert.Equal(RouteReason.DefaultFallback, alarm.Calls.Single().Reason);
    }

    /// <summary>
    /// Behavior-preservation lock for the ResolveRoute extraction: the RESOLVED KEY for every
    /// precedence case must be exactly what the pre-refactor expression produced
    /// (registry ?? config ?? default ?? "openai").
    /// </summary>
    [Theory]
    [InlineData("explain", "openai")]      // config route wins over the default
    [InlineData("distractor", "ollama")]   // config route
    [InlineData("unmapped", "openai")]     // no route → default
    [InlineData(null, "openai")]           // no tag → default
    public async Task Route_ResolvedKey_MatchesPrecedence(string? featureTag, string expected)
    {
        var (provider, _) = await RouteAsync(
            new()
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "openai",
                ["Ai:Routes:distractor"] = "ollama",
            },
            featureTag);

        Assert.Equal(expected, provider);
    }

    [Fact]
    public async Task Route_RegistryOverridesConfig_MatchesPrecedence()
    {
        var (provider, _) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "openai", ["Ai:Routes:explain"] = "openai" },
            "explain",
            registryRoutes: new() { ["explain"] = "ollama" });

        Assert.Equal("ollama", provider);
    }

    /// <summary>
    /// A registry row naming a provider key with no keyed registration must never throw — it falls
    /// back to the config route, and the reported reason follows the ACTUAL landing place.
    /// </summary>
    [Fact]
    public async Task Route_UnknownRegistryKey_FallsBackToConfigRouteAndReportsMatched()
    {
        var (provider, alarm) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "openai", ["Ai:Routes:explain"] = "ollama" },
            "explain",
            registryRoutes: new() { ["explain"] = "provider-that-does-not-exist" });

        Assert.Equal("ollama", provider);
        Assert.Equal(RouteReason.RouteMatched, alarm.Calls.Single().Reason);
    }

    [Fact]
    public async Task Route_UnknownRegistryKeyWithoutConfigRoute_ReportsDefaultFallback()
    {
        var (provider, alarm) = await RouteAsync(
            new() { ["Ai:DefaultProvider"] = "openai" },
            "explain",
            registryRoutes: new() { ["explain"] = "provider-that-does-not-exist" });

        Assert.Equal("openai", provider);
        Assert.Equal(RouteReason.DefaultFallback, alarm.Calls.Single().Reason);
    }

    /// <summary>
    /// The alarm is fired per gateway call, so the throttle inside SentryRouteAlarm — not the gateway —
    /// is what keeps a 106-page PDF from raising 106 events. Guards against someone "optimising" the
    /// throttle away by asserting the gateway really does report every call.
    /// </summary>
    [Fact]
    public async Task Route_EveryCall_ReportsToAlarm()
    {
        var (gateway, alarm) = Build(new() { ["Ai:DefaultProvider"] = "ollama" });

        for (var i = 0; i < 5; i++)
        {
            await gateway.CompleteAsync(
                new LlmRequest(string.Empty, [new LlmMessage("user", "hi")], 16, FeatureTag: "pdf.parse"),
                TestContext.Current.CancellationToken);
        }

        Assert.Equal(5, alarm.Calls.Count);
        Assert.All(alarm.Calls, c => Assert.Equal(RouteReason.DefaultFallback, c.Reason));
    }
}
