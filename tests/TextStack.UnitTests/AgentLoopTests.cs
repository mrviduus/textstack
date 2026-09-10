using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-034 — the generic plan→act→observe loop, driven by a scripted fake LLM: direct answer,
/// tool round then answer, message threading, usage accumulation, iteration cap, cost cap, and
/// tool failures fed back as data (loop recovers rather than throwing).
/// </summary>
public class AgentLoopTests
{
    private static readonly JsonElement AnySchema = JsonDocument.Parse("""{"type":"object"}""").RootElement;

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement;

    private sealed class EchoTool : ITool
    {
        public string Name => "agent-echo";
        public string Description => "echoes";
        public JsonElement ArgsSchema => AnySchema;
        public Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct) =>
            Task.FromResult(Json("""{"echoed":true}"""));
    }

    /// <summary>Each CompleteAsync consumes the next script turn; requests are recorded.</summary>
    private sealed class ScriptedLlm(params object[][] turns) : ILlmService
    {
        private int _turn;
        public List<LlmRequest> Requests { get; } = [];

        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            Requests.Add(request);
            var entries = _turn < turns.Length ? turns[_turn] : ["fallback final"];
            _turn++;
            var text = string.Concat(entries.OfType<string>());
            var calls = entries.OfType<ToolCall>().ToList();
            return Task.FromResult(new LlmResponse(text, calls, new LlmUsage(10, 5, 0.001m), "m", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private static AgentLoop Loop(ILlmService llm, params ITool[] tools) =>
        new(llm, new ToolRegistry(tools), new ToolDispatcher(new ToolRegistry(tools)));

    private static AgentContext Ctx() =>
        new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), new ServiceCollection().BuildServiceProvider());

    private static AgentInput Input() =>
        new("Explain this passage.", "You are a reading tutor.", ["agent-echo"], "tutor");

    private static ToolCall Call(string name = "agent-echo", string args = "{}") => new("call-1", name, Json(args));

    [Fact]
    public async Task Run_DirectAnswer_OneIteration()
    {
        var llm = new ScriptedLlm(["The answer."]);
        var result = await Loop(llm, new EchoTool()).RunAsync(
            Input(), Ctx(), new AgentLoopOptions(), TestContext.Current.CancellationToken);

        Assert.Equal("The answer.", result.Output);
        Assert.Equal(1, result.Usage.Iterations);
        Assert.Single(llm.Requests);
        Assert.Single(result.Steps);
        Assert.Equal("llm_response", result.Steps[0].Kind);
    }

    [Fact]
    public async Task Run_ToolThenAnswer_ThreadsMessagesAndRecordsSteps()
    {
        var llm = new ScriptedLlm(
            [Call(args: """{"x":1}""")], // turn 1: request a tool
            ["Grounded answer."]);        // turn 2: final
        var result = await Loop(llm, new EchoTool()).RunAsync(
            Input(), Ctx(), new AgentLoopOptions(), TestContext.Current.CancellationToken);

        Assert.Equal("Grounded answer.", result.Output);
        Assert.Equal(2, result.Usage.Iterations);
        Assert.Equal(["llm_response", "tool_result", "llm_response"], result.Steps.Select(s => s.Kind));

        // Turn 2's request carries the user goal, the assistant tool-call turn, and the tool result.
        var followUp = llm.Requests[1];
        Assert.Equal("user", followUp.Messages[0].Role);
        Assert.Equal("assistant", followUp.Messages[1].Role);
        Assert.Equal("tool", followUp.Messages[2].Role);
        Assert.Equal("call-1", followUp.Messages[2].ToolCalls![0].Id);
        Assert.Contains("echoed", followUp.Messages[2].Content);
    }

    [Fact]
    public async Task Run_AccumulatesUsageAcrossIterations()
    {
        var llm = new ScriptedLlm([Call()], ["done"]);
        var result = await Loop(llm, new EchoTool()).RunAsync(
            Input(), Ctx(), new AgentLoopOptions(), TestContext.Current.CancellationToken);

        Assert.Equal(2, result.Usage.Iterations);
        Assert.Equal(20, result.Usage.InputTokensTotal);   // 10 * 2
        Assert.Equal(10, result.Usage.OutputTokensTotal);  // 5 * 2
        Assert.Equal(0.002m, result.Usage.CostUsdTotal);   // 0.001 * 2
    }

    [Fact]
    public async Task Run_MaxStepsWithoutFinal_ThrowsBudgetExhaustedWithTranscript()
    {
        // Every turn requests a tool → never terminates on its own.
        var llm = new ScriptedLlm([Call()], [Call()], [Call()]);
        var ex = await Assert.ThrowsAsync<AgentBudgetExhaustedException>(() =>
            Loop(llm, new EchoTool()).RunAsync(
                Input(), Ctx(), new AgentLoopOptions(MaxSteps: 3), TestContext.Current.CancellationToken));

        // The exception carries the partial transcript + usage so the run can still be persisted (AI-036).
        Assert.Equal(3, ex.Usage.Iterations);
        Assert.NotEmpty(ex.Steps);
        Assert.Equal(0.003m, ex.Usage.CostUsdTotal); // 3 iterations * 0.001
    }

    [Fact]
    public async Task Run_CostCapExceeded_ThrowsBudgetExhausted()
    {
        var llm = new ScriptedLlm([Call()], [Call()], [Call()], [Call()], [Call()], ["late"]);
        // Each iteration costs 0.001; cap 0.0015 trips after the 2nd.
        await Assert.ThrowsAsync<AgentBudgetExhaustedException>(() =>
            Loop(llm, new EchoTool()).RunAsync(
                Input(), Ctx(), new AgentLoopOptions(MaxSteps: 6, CostCapUsd: 0.0015m),
                TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task Stream_EmitsStepEventsThenTerminalDone()
    {
        var llm = new ScriptedLlm(
            [Call(args: """{"x":1}""")], // turn 1: tool
            ["Final."]);                  // turn 2: answer
        var events = new List<AgentEvent>();
        await foreach (var e in Loop(llm, new EchoTool()).StreamAsync(
            Input(), Ctx(), new AgentLoopOptions(), TestContext.Current.CancellationToken))
        {
            events.Add(e);
        }

        // step (llm) → step (tool) → step (llm) → done; exactly one terminal result.
        Assert.Equal(3, events.Count(e => e.Step is not null));
        var done = Assert.Single(events.Where(e => e.Result is not null));
        Assert.Equal("Final.", done.Result!.Output);
        Assert.Equal(2, done.Result.Usage.Iterations);
        Assert.Same(events[^1], done); // done is the last event
    }

    [Fact]
    public async Task Stream_BudgetExhausted_StreamsPartialSteps_ThenThrows()
    {
        var llm = new ScriptedLlm([Call()], [Call()], [Call()]); // never answers
        var streamed = new List<AgentEvent>();

        await Assert.ThrowsAsync<AgentBudgetExhaustedException>(async () =>
        {
            await foreach (var e in Loop(llm, new EchoTool()).StreamAsync(
                Input(), Ctx(), new AgentLoopOptions(MaxSteps: 3), TestContext.Current.CancellationToken))
            {
                streamed.Add(e);
            }
        });

        Assert.NotEmpty(streamed);                          // partial steps reached the consumer
        Assert.All(streamed, e => Assert.Null(e.Result));   // no Done event on exhaustion
    }

    [Fact]
    public async Task Run_UnknownTool_FedBackAsData_LoopRecovers()
    {
        var llm = new ScriptedLlm(
            [Call("missing")],   // model asks for a tool that doesn't exist
            ["Recovered answer."]);
        var result = await Loop(llm, new EchoTool()).RunAsync(
            Input(), Ctx(), new AgentLoopOptions(), TestContext.Current.CancellationToken);

        Assert.Equal("Recovered answer.", result.Output);
        var toolMsg = llm.Requests[1].Messages[2];
        Assert.Equal("tool", toolMsg.Role);
        Assert.Contains("Unknown tool", toolMsg.Content); // error surfaced to the model, not thrown
    }
}
