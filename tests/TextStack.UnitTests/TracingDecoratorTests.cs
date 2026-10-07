using System.Runtime.CompilerServices;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;
using TextStack.Observability;

namespace TextStack.UnitTests;

public class TracingDecoratorTests
{
    private static LlmRequest Req(string? feature = "explain") =>
        new("system prompt", new[] { new LlmMessage("user", "hello") }, 100, FeatureTag: feature);

    private static LlmResponse Resp() =>
        new("the answer", Array.Empty<ToolCall>(), new LlmUsage(10, 5, 0.0001m), "gpt-4.1-nano", Guid.NewGuid());

    // ---- ShouldSample ----

    [Fact]
    public void ShouldSample_Error_AlwaysTrue_EvenAtZeroRate()
    {
        var opts = new TracingOptions(DefaultSampleRate: 0.0);
        Assert.True(TracingDecorator.ShouldSample("explain", isError: true, opts));
    }

    [Theory]
    [InlineData(1.0, true)]
    [InlineData(0.0, false)]
    public void ShouldSample_NonError_HonorsDeterministicRate(double rate, bool expected)
    {
        var opts = new TracingOptions(DefaultSampleRate: rate);
        Assert.Equal(expected, TracingDecorator.ShouldSample("translate", isError: false, opts));
    }

    [Fact]
    public void ShouldSample_PerFeatureOverride_BeatsDefault()
    {
        var opts = new TracingOptions(
            DefaultSampleRate: 1.0,
            PerFeatureRates: new Dictionary<string, double> { ["explain"] = 0.0 });
        Assert.False(TracingDecorator.ShouldSample("explain", isError: false, opts)); // overridden to 0
        Assert.True(TracingDecorator.ShouldSample("rag", isError: false, opts));       // default 1.0
    }

    // ---- BuildTrace ----

    [Fact]
    public void BuildTrace_Success_PopulatesFromResponse()
    {
        var resp = Resp();
        var trace = TracingDecorator.BuildTrace(Req(), resp, latencyMs: 42, error: null);

        Assert.Equal(resp.TraceId, trace.Id);
        Assert.Equal("explain", trace.FeatureTag);
        Assert.Equal("gpt-4.1-nano", trace.ModelId);
        Assert.Equal(10, trace.TokensIn);
        Assert.Equal(5, trace.TokensOut);
        Assert.Equal(0.0001m, trace.CostUsd);
        Assert.Equal(42, trace.LatencyMs);
        Assert.Null(trace.Error);
        Assert.False(string.IsNullOrEmpty(trace.PromptHash));
        Assert.Contains("hello", trace.MessagesJson);
    }

    [Fact]
    public void BuildTrace_Error_NoResponse_DefaultsAndZeros()
    {
        var trace = TracingDecorator.BuildTrace(Req(), response: null, latencyMs: 5, error: "boom");

        Assert.Equal("unknown", trace.ModelId);
        Assert.Equal("boom", trace.Error);
        Assert.Equal(0, trace.TokensIn);
        Assert.Equal(0m, trace.CostUsd);
        Assert.NotEqual(Guid.Empty, trace.Id);
    }

    [Fact]
    public void BuildTrace_NullFeatureTag_DefaultsToUnknown()
    {
        var trace = TracingDecorator.BuildTrace(Req(feature: null), Resp(), 1, null);
        Assert.Equal("unknown", trace.FeatureTag);
    }

    // ---- TraceRedactor ----

    [Fact]
    public void Redact_MasksEmailAndPhone()
    {
        var red = TraceRedactor.Redact("reach me at john.doe@example.com or +1 (415) 555-2671 today");
        Assert.DoesNotContain("john.doe@example.com", red);
        Assert.DoesNotContain("555-2671", red);
        Assert.Contains("[redacted-email]", red);
        Assert.Contains("[redacted-phone]", red);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void Redact_NullOrEmpty_PassesThrough(string? input)
    {
        Assert.Equal(input, TraceRedactor.Redact(input));
    }

    // ---- pass-through (response unchanged; trace write is fire-and-forget) ----

    [Fact]
    public async Task CompleteAsync_ReturnsInnerResponseUnchanged()
    {
        var services = new ServiceCollection();
        services.AddScoped<ILlmTraceWriter, NoOpWriter>();
        using var sp = services.BuildServiceProvider();

        var resp = Resp();
        var decorator = new TracingDecorator(
            new StubLlm(resp),
            sp.GetRequiredService<IServiceScopeFactory>(),
            new TracingOptions(),
            NullLogger<TracingDecorator>.Instance);

        var result = await decorator.CompleteAsync(Req(), CancellationToken.None);

        Assert.Equal(resp.Text, result.Text);
        Assert.Equal(resp.ModelId, result.ModelId);
        Assert.Equal(resp.Usage.InputTokens, result.Usage.InputTokens);
    }

    // ---- BuildStreamedResponse (stream → traceable response) ----

    [Fact]
    public void BuildStreamedResponse_AssemblesAccumulatedStream()
    {
        var id = Guid.NewGuid();
        var resp = TracingDecorator.BuildStreamedResponse(
            "Hello world", [], new LlmUsage(7, 3, 0.002m), "gpt-4.1-nano", id);

        Assert.Equal("Hello world", resp.Text);
        Assert.Equal(7, resp.Usage.InputTokens);
        Assert.Equal("gpt-4.1-nano", resp.ModelId);
        Assert.Equal(id, resp.TraceId);
        Assert.Empty(resp.ToolCalls);
    }

    [Fact]
    public void BuildStreamedResponse_NullUsageAndModel_DefaultsLikeFailedCall()
    {
        var resp = TracingDecorator.BuildStreamedResponse("", [], usage: null, modelId: null, Guid.NewGuid());
        Assert.Equal("unknown", resp.ModelId);
        Assert.Equal(0, resp.Usage.OutputTokens);
        Assert.Equal(0m, resp.Usage.CostUsd);
    }

    // ---- StreamAsync (re-yields every delta; persists one trace on completion) ----

    [Fact]
    public async Task StreamAsync_ReYieldsAllDeltasInOrder()
    {
        var deltas = new[]
        {
            new LlmDelta(TextDelta: "Hel"),
            new LlmDelta(TextDelta: "lo"),
            new LlmDelta(FinalUsage: new LlmUsage(5, 2, 0.001m), ModelId: "gpt-4.1-nano"),
        };
        var decorator = Decorator(new StreamingStub(deltas), new NoOpWriter());

        var seen = new List<LlmDelta>();
        await foreach (var d in decorator.StreamAsync(Req(), TestContext.Current.CancellationToken))
            seen.Add(d);

        Assert.Equal(deltas, seen);
    }

    [Fact]
    public async Task StreamAsync_PersistsTraceWithAccumulatedTextAndUsage()
    {
        var deltas = new[]
        {
            new LlmDelta(TextDelta: "Hel"),
            new LlmDelta(TextDelta: "lo world"),
            new LlmDelta(FinalUsage: new LlmUsage(5, 2, 0.001m), ModelId: "gpt-4.1-nano"),
        };
        var writer = new CapturingWriter();
        var decorator = Decorator(new StreamingStub(deltas), writer);

        var ct = TestContext.Current.CancellationToken;
        await foreach (var _ in decorator.StreamAsync(Req(), ct)) { }

        var trace = await writer.Captured.Task.WaitAsync(TimeSpan.FromSeconds(5), ct);
        Assert.Equal("Hello world", trace.ResponseText);
        Assert.Equal("gpt-4.1-nano", trace.ModelId);
        Assert.Equal(5, trace.TokensIn);
        Assert.Equal(2, trace.TokensOut);
        Assert.Equal(0.001m, trace.CostUsd);
        Assert.Null(trace.Error);
    }

    [Fact]
    public async Task StreamAsync_ToolCallDeltas_LandInTraceToolCallsJson()
    {
        var deltas = new[]
        {
            new LlmDelta(ToolCallDelta: new ToolCall(
                "call-1", "search_book", System.Text.Json.JsonDocument.Parse("""{"query":"lsm"}""").RootElement)),
            new LlmDelta(FinalUsage: new LlmUsage(5, 2, 0.001m), ModelId: "gpt-4.1-nano"),
        };
        var writer = new CapturingWriter();
        var decorator = Decorator(new StreamingStub(deltas), writer);

        await foreach (var _ in decorator.StreamAsync(Req(), TestContext.Current.CancellationToken)) { }

        var trace = await writer.Captured.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.NotNull(trace.ToolCallsJson);
        Assert.Contains("search_book", trace.ToolCallsJson);
    }

    // ---- cancellation is not an error (SSE disconnects must not pollute the error rate) ----

    [Fact]
    public async Task CompleteAsync_CallerCancels_RethrowsWithoutTracing()
    {
        var writer = new CapturingWriter();
        var decorator = Decorator(new ThrowingLlm(ct => throw new OperationCanceledException(ct)), writer);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => decorator.CompleteAsync(Req(), cts.Token));
        Assert.False(writer.Captured.Task.IsCompleted); // no trace scheduled for a caller cancel
    }

    [Fact]
    public async Task CompleteAsync_ModelError_PersistsErrorTrace()
    {
        var writer = new CapturingWriter();
        var decorator = Decorator(new ThrowingLlm(_ => throw new InvalidOperationException("boom")), writer);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => decorator.CompleteAsync(Req(), TestContext.Current.CancellationToken));

        var trace = await writer.Captured.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        Assert.Equal("boom", trace.Error);
    }

    [Fact]
    public async Task StreamAsync_CallerCancels_RethrowsWithoutTracing()
    {
        var writer = new CapturingWriter();
        var decorator = Decorator(new ThrowingLlm(ct => throw new OperationCanceledException(ct)), writer);
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var _ in decorator.StreamAsync(Req(), cts.Token)) { }
        });
        Assert.False(writer.Captured.Task.IsCompleted); // no error trace for a stream the client abandoned
    }

    private static TracingDecorator Decorator(ILlmService inner, ILlmTraceWriter writer)
    {
        var services = new ServiceCollection();
        services.AddScoped(_ => writer);
        var sp = services.BuildServiceProvider();
        return new TracingDecorator(
            inner, sp.GetRequiredService<IServiceScopeFactory>(),
            new TracingOptions(), NullLogger<TracingDecorator>.Instance);
    }

    private sealed class StubLlm(LlmResponse resp) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) => Task.FromResult(resp);

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.CompletedTask;
            yield return new LlmDelta(TextDelta: resp.Text);
        }
    }

    private sealed class StreamingStub(IReadOnlyList<LlmDelta> deltas) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();

        public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            foreach (var d in deltas)
            {
                await Task.Yield();
                yield return d;
            }
        }
    }

    private sealed class NoOpWriter : ILlmTraceWriter
    {
        public Task WriteAsync(LlmTrace trace, CancellationToken ct) => Task.CompletedTask;
    }

    /// <summary>Throws whatever <paramref name="throw"/> produces, from both the one-shot and the stream path.</summary>
    private sealed class ThrowingLlm(Func<CancellationToken, Exception> @throw) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) => throw @throw(ct);

        public async IAsyncEnumerable<LlmDelta> StreamAsync(
            LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
        {
            await Task.Yield();
            throw @throw(ct);
#pragma warning disable CS0162 // unreachable — needed so the method is an iterator
            yield break;
#pragma warning restore CS0162
        }
    }

    private sealed class CapturingWriter : ILlmTraceWriter
    {
        public TaskCompletionSource<LlmTrace> Captured { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task WriteAsync(LlmTrace trace, CancellationToken ct)
        {
            Captured.TrySetResult(trace);
            return Task.CompletedTask;
        }
    }
}
