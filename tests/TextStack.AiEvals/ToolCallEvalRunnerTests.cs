using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;
using TextStack.Ai.Tools;

namespace TextStack.AiEvals;

/// <summary>
/// Deterministic coverage for <see cref="ToolCallEvalRunner"/> (AI-033) with a fake LLM: load the
/// embedded goldens → issue round-1 per case with the production prompt + tool schemas → score.
/// Counts come from the dataset so the test survives the set growing.
/// </summary>
public class ToolCallEvalRunnerTests
{
    private static readonly IReadOnlyList<ToolCallGolden> Goldens = ToolCallGoldenSet.Load();
    private static readonly JsonElement AnySchema = JsonDocument.Parse("""{"type":"object"}""").RootElement;

    /// <summary>A registry stub exposing the Explain tool names (schemas only — never invoked).</summary>
    private sealed class SchemaTool(string name) : ITool
    {
        public string Name => name;
        public string Description => name;
        public JsonElement ArgsSchema => AnySchema;
        public Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct) =>
            throw new NotSupportedException("eval never executes tools");
    }

    private static IToolRegistry Registry() => new ToolRegistry(
    [
        new SchemaTool("get_chapter"), new SchemaTool("get_user_highlights"),
    ]);

    /// <summary>Answers each golden EXACTLY as expected (right tool + expected fragments, or no tool).</summary>
    private sealed class OracleLlm : ILlmService
    {
        public List<LlmRequest> Requests { get; } = [];

        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Requests.Add(request);
            // The user prompt is "Word: {word}\nSentence: {sentence}" — recover the golden by word.
            var word = request.Messages[0].Content.Split('\n')[0]["Word: ".Length..];
            var g = Goldens.First(x => x.Word == word);

            var calls = new List<ToolCall>();
            if (g.ExpectedTool is not null)
            {
                var args = g.ExpectedArgFragments is null
                    ? "{}"
                    : JsonSerializer.Serialize(g.ExpectedArgFragments.ToDictionary(kv => kv.Key, kv => (object)kv.Value));
                calls.Add(new ToolCall("c1", g.ExpectedTool, JsonDocument.Parse(args).RootElement));
            }
            return Task.FromResult(new LlmResponse(
                calls.Count == 0 ? "A direct answer." : "", calls, new LlmUsage(1, 1, 0m), "oracle", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    /// <summary>Always calls lookup_dictionary — wrong for every golden except the dictionary ones.</summary>
    private sealed class DictionaryHappyLlm : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            var word = request.Messages[0].Content.Split('\n')[0]["Word: ".Length..];
            var call = new ToolCall("c1", "lookup_dictionary",
                JsonDocument.Parse($"{{\"word\":\"{word}\"}}").RootElement);
            return Task.FromResult(new LlmResponse("", [call], new LlmUsage(1, 1, 0m), "happy", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    [Fact]
    public async Task RunAsync_OracleModel_PerfectAccuracy()
    {
        var llm = new OracleLlm();
        var runner = new ToolCallEvalRunner(NullLogger<ToolCallEvalRunner>.Instance);

        var result = await runner.RunAsync(llm, Registry(), persist: false, db: null, gitSha: null,
            TestContext.Current.CancellationToken);

        Assert.Equal(Goldens.Count, result.N);
        Assert.Equal(1.0, result.Accuracy, 12);
        Assert.All(result.Cases, c => Assert.True(c.Hit));

        // Pre-router semantics (mirrors production): no-signal sentences carry NO schemas and a
        // plain prompt; triggered sentences carry their expected tool + the tool-guidance prompt.
        var byWord = Goldens.ToDictionary(g => g.Word);
        Assert.All(llm.Requests, r =>
        {
            var word = r.Messages[0].Content.Split('\n')[0]["Word: ".Length..];
            if (byWord[word].ExpectedTool is null)
            {
                Assert.Null(r.Tools);
                Assert.DoesNotContain("You have access to tools", r.SystemPrompt);
            }
            else
            {
                Assert.NotNull(r.Tools);
                Assert.Contains(r.Tools!, t => t.Name == byWord[word].ExpectedTool);
                Assert.Contains("You have access to tools", r.SystemPrompt);
            }
        });
    }

    [Fact]
    public async Task RunAsync_OverEagerToolCaller_ScoresOnlyDictionaryCases()
    {
        var runner = new ToolCallEvalRunner(NullLogger<ToolCallEvalRunner>.Instance);

        var result = await runner.RunAsync(new DictionaryHappyLlm(), Registry(), persist: false, db: null,
            gitSha: null, TestContext.Current.CancellationToken);

        var expectedHits = Goldens.Count(g => g.ExpectedTool == "lookup_dictionary");
        Assert.Equal((double)expectedHits / Goldens.Count, result.Accuracy, 12);
        // No-tool goldens must be misses for an over-eager caller (over-calling is a failure).
        Assert.All(result.Cases.Where(c => c.ExpectedTool is null), c => Assert.False(c.Hit));
    }

    [Fact]
    public void GoldenSet_LoadsWithSaneShape()
    {
        Assert.True(Goldens.Count >= 30, $"DoD wants a 30-example set; got {Goldens.Count}");
        Assert.Contains(Goldens, g => g.ExpectedTool is null);                    // no-tool cases present
        Assert.Contains(Goldens, g => g.ExpectedTool == "get_chapter");
        Assert.Contains(Goldens, g => g.ExpectedTool == "get_user_highlights");
        Assert.All(Goldens, g => Assert.False(string.IsNullOrWhiteSpace(g.Sentence)));
    }
}
