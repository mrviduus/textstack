using System.Runtime.CompilerServices;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// Cost-aware routing + per-feature daily budget enforcement in ModelGateway (Phase 12 RLOps
/// slice 4). Under budget → true primary; over + fallback (registered) → fallback key; over +
/// fallback (unregistered) → primary (no break); over + hardstop → BudgetExceededException; mode
/// off → primary regardless; tracker throws → primary (no break). Record fires exactly once per
/// call.
/// </summary>
public class ModelGatewayBudgetTests
{
    private static LlmRequest Req(string feature = "explain") =>
        new("sys", Array.Empty<LlmMessage>(), 10, FeatureTag: feature);

    [Fact]
    public async Task UnderBudget_RoutesToTruePrimary()
    {
        var (gateway, _) = Build(spent: 1.0m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: true);
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("primary", resp.ModelId);
    }

    [Fact]
    public async Task OverBudget_FallbackMode_RegisteredFallback_RoutesToFallback()
    {
        var (gateway, _) = Build(spent: 9.0m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: true);
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("fallback", resp.ModelId);
    }

    [Fact]
    public async Task OverBudget_FallbackMode_UnregisteredFallback_RoutesToPrimary_NoBreak()
    {
        var (gateway, _) = Build(spent: 9.0m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: false);
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("primary", resp.ModelId);
    }

    [Fact]
    public async Task OverBudget_HardStop_Throws()
    {
        var (gateway, _) = Build(spent: 9.0m, dailyUsd: 5m, mode: BudgetMode.HardStop, fallbackRegistered: false);
        var ex = await Assert.ThrowsAsync<BudgetExceededException>(
            () => gateway.CompleteAsync(Req(), CancellationToken.None));
        Assert.Equal("explain", ex.FeatureTag);
        Assert.Equal(5m, ex.DailyBudgetUsd);
    }

    [Fact]
    public async Task ModeOff_OverBudget_RoutesToPrimary()
    {
        var (gateway, _) = Build(spent: 999m, dailyUsd: 5m, mode: BudgetMode.Off, fallbackRegistered: true);
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("primary", resp.ModelId);
    }

    [Fact]
    public async Task TrackerThrows_RoutesToPrimary_NoBreak()
    {
        var (gateway, _) = Build(
            spent: 9m, dailyUsd: 5m, mode: BudgetMode.HardStop, fallbackRegistered: true,
            tracker: new ThrowingSpendTracker());
        // Tracker throws on read → budget logic swallows → true primary, NO BudgetExceededException.
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("primary", resp.ModelId);
    }

    [Fact]
    public async Task Record_CalledExactlyOnce_PerCompleteAsync()
    {
        var (gateway, tracker) = Build(spent: 0m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: true);
        await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal(1, tracker.RecordCalls);
        Assert.Equal("explain", tracker.LastRecordedFeature);
    }

    [Fact]
    public async Task Record_CalledOnce_EvenWhenBudgetRedirects()
    {
        var (gateway, tracker) = Build(spent: 9m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: true);
        var resp = await gateway.CompleteAsync(Req(), CancellationToken.None);
        Assert.Equal("fallback", resp.ModelId); // served by fallback
        Assert.Equal(1, tracker.RecordCalls);    // still recorded exactly once
    }

    [Fact]
    public async Task Record_CalledExactlyOnce_PerStreamAsync()
    {
        var (gateway, tracker) = Build(spent: 0m, dailyUsd: 5m, mode: BudgetMode.Fallback, fallbackRegistered: true);
        await foreach (var _ in gateway.StreamAsync(Req(), CancellationToken.None)) { }
        Assert.Equal(1, tracker.RecordCalls);
        Assert.Equal("explain", tracker.LastRecordedFeature);
        // Cost recorded is the streamed FinalUsage cost (0.001), not zero.
        Assert.Equal(0.001m, tracker.LastRecordedCost);
    }

    [Fact]
    public async Task Record_NotCalled_WhenStreamThrowsMidStream()
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "openai",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddKeyedSingleton<ILlmService>("openai", new ThrowingStreamLlm());
        var sp = services.BuildServiceProvider();

        var budgets = new BudgetOptions(
            new FeatureBudget(null, null, BudgetMode.Off),
            new Dictionary<string, FeatureBudget> { ["explain"] = new(5m, "ollama", BudgetMode.Fallback) });
        var tracker = new StubSpendTracker(0m);
        var gateway = new ModelGateway(
            sp, cfg,
            new StubRouteProvider(), tracker, budgets, NullLogger<ModelGateway>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await foreach (var _ in gateway.StreamAsync(Req(), CancellationToken.None)) { }
        });

        Assert.Equal(0, tracker.RecordCalls); // mid-stream throw → spend NOT recorded
    }

    // ---- harness ----

    private static (ModelGateway Gateway, StubSpendTracker Tracker) Build(
        decimal spent, decimal dailyUsd, BudgetMode mode, bool fallbackRegistered,
        ISpendTracker? tracker = null)
    {
        var cfg = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Ai:DefaultProvider"] = "openai",
                ["Ai:Routes:explain"] = "openai",
            })
            .Build();

        var services = new ServiceCollection();
        services.AddKeyedSingleton<ILlmService>("openai", new KeyEcho("primary"));
        if (fallbackRegistered)
            services.AddKeyedSingleton<ILlmService>("ollama", new KeyEcho("fallback"));
        var sp = services.BuildServiceProvider();

        var budgets = new BudgetOptions(
            new FeatureBudget(null, null, BudgetMode.Off),
            new Dictionary<string, FeatureBudget>
            {
                ["explain"] = new(dailyUsd, "ollama", mode),
            });

        var stub = new StubSpendTracker(spent);
        var gateway = new ModelGateway(
            sp, cfg,
            new StubRouteProvider(), tracker ?? stub, budgets, NullLogger<ModelGateway>.Instance);
        return (gateway, stub);
    }

    private sealed class StubRouteProvider : IModelRouteProvider
    {
        public string? PrimaryProviderKey(string featureTag) => null;
        public void Invalidate() { }
    }

    private sealed class StubSpendTracker(decimal spent) : ISpendTracker
    {
        public int RecordCalls { get; private set; }
        public string? LastRecordedFeature { get; private set; }
        public decimal LastRecordedCost { get; private set; }
        public decimal SpentTodayUsd(string featureTag) => spent;
        public void Record(string featureTag, decimal costUsd)
        {
            RecordCalls++;
            LastRecordedFeature = featureTag;
            LastRecordedCost = costUsd;
        }
    }

    private sealed class ThrowingStreamLlm : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            yield return new LlmDelta(TextDelta: "partial");
            await Task.Yield();
            throw new InvalidOperationException("stream boom");
        }
    }

    private sealed class ThrowingSpendTracker : ISpendTracker
    {
        public decimal SpentTodayUsd(string featureTag) => throw new InvalidOperationException("boom");
        public void Record(string featureTag, decimal costUsd) { }
    }

    private sealed class KeyEcho(string id) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse("", Array.Empty<ToolCall>(), new LlmUsage(1, 1, 0.001m), id, Guid.NewGuid()));

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield return new LlmDelta(FinalUsage: new LlmUsage(1, 1, 0.001m), ModelId: id);
        }
    }
}
