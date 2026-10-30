using System.Collections.Concurrent;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// AI-040 — the generic <see cref="CrewOrchestrator"/>, driven by deterministic fake <see cref="IAgent{TIn,TOut}"/>s
/// (no LLM, no AgentLoop, no tools): sequential stage ordering with state hand-off, parallel fan-out folded in
/// DECLARATION order, the parallelism bound, per-task DI scopes, the post-stage cost cap, fail-closed on a
/// sub-agent error, budget-exhaustion capture, and cancellation propagation.
/// </summary>
public class CrewOrchestratorTests
{
    // Shared mutable crew state: an ordered log of folds the sub-agents performed.
    private sealed class State
    {
        public List<string> Log { get; } = [];
    }

    private static AgentUsage Usage(decimal cost = 0m, int input = 10, int output = 5) =>
        new(1, input, output, cost, 0);

    /// <summary>A fake agent that, on run, returns a fixed tag; the fold appends it to the state log.</summary>
    private sealed class TagAgent(string tag, decimal cost = 0m) : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct) =>
            Task.FromResult(new AgentResult<string>(tag, [Step()], Usage(cost)));
    }

    /// <summary>A fake that blocks until released, so peers can finish out of order in fan-out tests.</summary>
    private sealed class GatedAgent(string tag, Task gate) : IAgent<int, string>
    {
        public async Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            await gate;
            return new AgentResult<string>(tag, [Step()], Usage());
        }
    }

    private sealed class ThrowingAgent(Exception ex) : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct) =>
            throw ex;
    }

    private sealed class BudgetAgent(AgentBudgetExhaustedException ex) : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct) =>
            throw ex;
    }

    private static AgentStep Step() =>
        new(0, "final", System.Text.Json.JsonSerializer.SerializeToElement(new { ok = true }), DateTimeOffset.UtcNow);

    private static AgentContext Ctx(IServiceProvider? sp = null) =>
        new(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), sp ?? new ServiceCollection().BuildServiceProvider());

    private static CrewTask<State> Wrap(string name, IAgent<int, string> agent) =>
        CrewTasks.Of<State, int, string>(name, agent, _ => 0, (s, o) => s.Log.Add(o));

    private static CrewStage<State> Stage(string name, params CrewTask<State>[] tasks) =>
        new(name, tasks);

    // 1. Sequential ordering — 3 single-task stages run strictly in order, each sees prior folds.
    [Fact]
    public async Task RunAsync_ThreeSequentialStages_RunsInOrderWithStateHandoff()
    {
        var state = new State();
        // The agent records what it saw in the state at run time, proving the previous stage already folded.
        State seenAtB = new();
        var plan = new CrewPlan<State>("seq",
        [
            Stage("s1", Wrap("a", new TagAgent("A"))),
            Stage("s2", CrewTasks.Of<State, int, string>("b", new TagAgent("B"),
                s => { seenAtB.Log.AddRange(s.Log); return 0; }, (s, o) => s.Log.Add(o))),
            Stage("s3", Wrap("c", new TagAgent("C"))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, state, Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.Equal(["A", "B", "C"], result.State.Log);
        Assert.Equal(["A"], seenAtB.Log); // stage 2 observed stage 1's fold already applied
        Assert.Equal(["s1", "s2", "s3"], result.Steps.Select(e => e.Stage));
        Assert.Equal([0, 1, 2], result.Steps.Select(e => e.Index));
        Assert.Equal(3, result.Usage.Iterations); // 3 sub-agent invocations
    }

    // 2. Parallel fan-out — tasks finish OUT of order but folds + transcript stay in DECLARATION order.
    [Fact]
    public async Task RunAsync_ParallelFanOut_FoldsInDeclarationOrder()
    {
        var gateA = new TaskCompletionSource();
        var gateB = new TaskCompletionSource();
        var gateC = new TaskCompletionSource();

        var plan = new CrewPlan<State>("fan",
        [
            Stage("s1",
                Wrap("a", new GatedAgent("A", gateA.Task)),
                Wrap("b", new GatedAgent("B", gateB.Task)),
                Wrap("c", new GatedAgent("C", gateC.Task))),
        ], new CrewOptions(MaxParallelism: 4));

        var run = new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        // Release in reverse order: C, then B, then A.
        gateC.SetResult();
        gateB.SetResult();
        gateA.SetResult();

        var result = await run;

        Assert.Equal(["A", "B", "C"], result.State.Log);                 // folds in declaration order
        Assert.Equal(["a", "b", "c"], result.Steps.Select(e => e.AgentName)); // transcript in declaration order
    }

    // 3. Concurrency bound — MaxParallelism=2 → peak concurrency never exceeds 2.
    [Fact]
    public async Task RunAsync_MaxParallelismTwo_PeakConcurrencyNeverExceedsTwo()
    {
        var current = 0;
        var peak = 0;
        var sync = new object();

        sealed_CounterAgent Make(string tag) => new(tag, () =>
        {
            lock (sync) { current++; peak = Math.Max(peak, current); }
        }, () => { lock (sync) { current--; } });

        var plan = new CrewPlan<State>("bound",
        [
            Stage("s1",
                Wrap("a", Make("A")), Wrap("b", Make("B")),
                Wrap("c", Make("C")), Wrap("d", Make("D")), Wrap("e", Make("E"))),
        ], new CrewOptions(MaxParallelism: 2));

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.True(peak <= 2, $"peak concurrency was {peak}, expected <= 2");
        Assert.Equal(5, result.Steps.Count);
    }

    private sealed class sealed_CounterAgent(string tag, Action enter, Action exit) : IAgent<int, string>
    {
        public async Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            enter();
            try { await Task.Delay(20, ct); }
            finally { exit(); }
            return new AgentResult<string>(tag, [Step()], Usage());
        }
    }

    // 4. Per-task DI scope — each parallel task resolves a DISTINCT scoped IServiceProvider.
    [Fact]
    public async Task RunAsync_ParallelTasks_EachGetsDistinctScope()
    {
        var providers = new ConcurrentBag<IServiceProvider>();
        var root = new ServiceCollection().BuildServiceProvider();

        var agent = new ScopeCapturingAgent(providers);
        var plan = new CrewPlan<State>("scopes",
        [
            Stage("s1", Wrap("a", agent), Wrap("b", agent), Wrap("c", agent)),
        ], new CrewOptions());

        await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(root), TestContext.Current.CancellationToken);

        Assert.Equal(3, providers.Count);
        Assert.Equal(3, providers.Distinct().Count()); // all distinct scopes
        Assert.DoesNotContain(root, providers);        // none is the root provider
    }

    private sealed class ScopeCapturingAgent(ConcurrentBag<IServiceProvider> sink) : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            sink.Add(ctx.Services);
            return Task.FromResult(new AgentResult<string>("x", [Step()], Usage()));
        }
    }

    // 5. Cost cap trips mid-crew — cap crossed after stage 1 → budget_exhausted, stage 2 never runs.
    [Fact]
    public async Task RunAsync_CostCapCrossedAfterStageOne_StopsBeforeStageTwo()
    {
        var ranStage2 = false;
        var plan = new CrewPlan<State>("cap",
        [
            Stage("s1", Wrap("a", new TagAgent("A", cost: 0.50m))),
            Stage("s2", CrewTasks.Of<State, int, string>("b", new TagAgent("B"),
                s => { ranStage2 = true; return 0; }, (s, o) => s.Log.Add(o))),
        ], new CrewOptions(CostCapUsd: 0.40m));

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Status);
        Assert.False(ranStage2);
        Assert.Equal(["A"], result.State.Log);
        Assert.Single(result.Steps);
        Assert.Equal("s1", result.Steps[0].Stage);
        Assert.Equal(0.50m, result.Usage.CostUsdTotal);
    }

    // 6. Sub-agent error → status "error" entry, peer completes, crew fails closed, next stage skipped.
    [Fact]
    public async Task RunAsync_SubAgentThrows_PeerCompletesCrewFailsClosedNextStageSkipped()
    {
        var ranStage2 = false;
        var plan = new CrewPlan<State>("err",
        [
            Stage("s1",
                Wrap("ok", new TagAgent("OK")),
                Wrap("boom", new ThrowingAgent(new InvalidOperationException("kaboom")))),
            Stage("s2", CrewTasks.Of<State, int, string>("b", new TagAgent("B"),
                s => { ranStage2 = true; return 0; }, (s, o) => s.Log.Add(o))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusError, result.Status);
        Assert.False(ranStage2);
        Assert.Equal(2, result.Steps.Count); // both peers recorded
        Assert.Contains(result.Steps, e => e is { AgentName: "ok", Status: "completed" });
        var boom = Assert.Single(result.Steps, e => e.AgentName == "boom");
        Assert.Equal(CrewRunRecordFactory.StatusError, boom.Status);
        Assert.Contains("kaboom", boom.Error);
        Assert.Equal(["OK"], result.State.Log); // the ok peer still folded
    }

    // 7. Sub-agent AgentBudgetExhaustedException → wrapper captures ex.Steps/ex.Usage into the result.
    [Fact]
    public async Task RunAsync_SubAgentBudgetExhausted_CapturesPartialTranscript()
    {
        var partialSteps = new[] { Step(), Step() };
        var partialUsage = new AgentUsage(2, 100, 50, 0.02m, 7);
        var ex = new AgentBudgetExhaustedException("hit cap", partialSteps, partialUsage);

        var plan = new CrewPlan<State>("budget",
        [
            Stage("s1", Wrap("a", new BudgetAgent(ex))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        // The recorded entry carries the partial transcript the exception held (independent of fail-closed).
        var entry = Assert.Single(result.Steps);
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, entry.Status);
        Assert.Equal(2, entry.Steps.Count);
        Assert.Equal(partialUsage, entry.Usage);
        Assert.Equal("hit cap", entry.Error);
        Assert.Empty(result.State.Log); // no fold on budget exhaustion
    }

    // 8. Cancellation mid-stage → OperationCanceledException propagates.
    [Fact]
    public async Task RunAsync_CancelledMidStage_Propagates()
    {
        var cts = new CancellationTokenSource();
        var agent = new CancelObservingAgent(cts);
        var plan = new CrewPlan<State>("cancel",
        [
            Stage("s1", Wrap("a", agent)),
        ], new CrewOptions());

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), cts.Token));
    }

    private sealed class CancelObservingAgent(CancellationTokenSource cts) : IAgent<int, string>
    {
        public async Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            cts.Cancel();
            ct.ThrowIfCancellationRequested();
            await Task.Yield();
            return new AgentResult<string>("x", [Step()], Usage());
        }
    }

    // 9. CrewRunRecordFactory — crew.{name}, "sub_agent" steps with nested sub-transcript + aggregate usage.
    [Fact]
    public async Task CrewRunRecordFactory_From_MapsToAgentRunRecord()
    {
        var plan = new CrewPlan<State>("metadata",
        [
            Stage("s1", Wrap("genre", new TagAgent("Fantasy", cost: 0.01m))),
            Stage("s2", Wrap("desc", new TagAgent("A tale.", cost: 0.02m))),
        ], new CrewOptions());

        var userId = Guid.NewGuid();
        var editionId = Guid.NewGuid();
        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        var id = Guid.NewGuid();
        var record = CrewRunRecordFactory.From(id, "metadata", userId, editionId, "enrich book", "summary text", result);

        Assert.Equal(id, record.Id);
        Assert.Equal("crew.metadata", record.Agent);
        Assert.Equal(userId, record.UserId);
        Assert.Equal(editionId, record.EditionId);
        Assert.Equal("enrich book", record.Goal);
        Assert.Equal("summary text", record.Output);
        Assert.Equal(CrewRunRecordFactory.StatusCompleted, record.Status);
        Assert.Null(record.Error);

        // Aggregate usage: 2 invocations, summed cost.
        Assert.Equal(2, record.Usage.Iterations);
        Assert.Equal(0.03m, record.Usage.CostUsdTotal);

        // Each crew step → one "sub_agent" AgentStep with the sub-agent transcript nested under payload.steps.
        Assert.Equal(2, record.Steps.Count);
        Assert.All(record.Steps, s => Assert.Equal(CrewRunRecordFactory.SubAgentStepKind, s.Kind));
        Assert.Equal([0, 1], record.Steps.Select(s => s.Index));

        var payload = record.Steps[0].Payload;
        Assert.Equal("s1", payload.GetProperty("stage").GetString());
        Assert.Equal("genre", payload.GetProperty("agentName").GetString());
        Assert.Equal("completed", payload.GetProperty("status").GetString());
        Assert.True(payload.TryGetProperty("steps", out var nested));
        Assert.Equal(System.Text.Json.JsonValueKind.Array, nested.ValueKind);
        Assert.True(nested.GetArrayLength() >= 1); // nested sub-agent transcript present
    }

    // ---------------------------------------------------------------------------------------------
    // Adversarial / hardening tests added during QA review (AI-040).
    // ---------------------------------------------------------------------------------------------

    // A1. STRESS determinism: many parallel tasks released in RANDOM order, repeated runs — folds and
    //     transcript must be STRICTLY declaration order every single time, regardless of finish order.
    [Fact]
    public async Task RunAsync_ParallelFanOut_RandomReleaseOrder_AlwaysDeclarationOrder()
    {
        const int taskCount = 12;
        var expected = Enumerable.Range(0, taskCount).Select(i => $"T{i}").ToList();

        for (var run = 0; run < 40; run++)
        {
            var gates = Enumerable.Range(0, taskCount).Select(_ => new TaskCompletionSource()).ToArray();
            var tasks = new CrewTask<State>[taskCount];
            for (var i = 0; i < taskCount; i++)
                tasks[i] = Wrap($"a{i}", new GatedAgent($"T{i}", gates[i].Task));

            var plan = new CrewPlan<State>("stress",
                [new CrewStage<State>("s1", tasks)],
                new CrewOptions(MaxParallelism: taskCount));

            var exec = new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

            // Release completions in a shuffled order seeded by the run index (deterministic test, random finish).
            var order = Enumerable.Range(0, taskCount).OrderBy(x => (x * 7 + run * 13) % taskCount).ToArray();
            foreach (var idx in order)
                gates[idx].SetResult();

            var result = await exec;

            Assert.Equal(expected, result.State.Log);
            Assert.Equal(expected, result.Steps.Select(e => e.AgentName.Replace("a", "T")).ToList());
            Assert.Equal(Enumerable.Range(0, taskCount), result.Steps.Select(e => e.Index));
        }
    }

    // A2. MaxParallelism <= 0 must NOT deadlock (SemaphoreSlim(0) would). It is clamped to >= 1.
    [Theory]
    [InlineData(0)]
    [InlineData(-5)]
    public async Task RunAsync_MaxParallelismNonPositive_DoesNotDeadlock(int maxParallelism)
    {
        var plan = new CrewPlan<State>("clamp",
        [
            Stage("s1", Wrap("a", new TagAgent("A")), Wrap("b", new TagAgent("B"))),
        ], new CrewOptions(MaxParallelism: maxParallelism));

        // If clamping were missing this would hang; assert it finishes well under any sane timeout.
        var run = new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);
        var finished = await Task.WhenAny(run, Task.Delay(5000, TestContext.Current.CancellationToken));
        Assert.Same(run, finished);

        var result = await run;
        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.Equal(["A", "B"], result.State.Log);
    }

    // A3. Full persistence round-trip: the record produced by CrewRunRecordFactory must survive the
    //     DbAgentRunWriter path — JsonSerializer.Serialize(steps) then re-parse — with the nested
    //     sub-agent transcript intact (this is what actually lands in agent_run.steps jsonb).
    [Fact]
    public async Task CrewRunRecordFactory_From_RoundTripsThroughJsonSerializer()
    {
        var plan = new CrewPlan<State>("rt",
        [
            Stage("s1", Wrap("genre", new TagAgent("Fantasy", cost: 0.01m)), Wrap("year", new TagAgent("1999"))),
            Stage("s2", Wrap("desc", new TagAgent("A tale.", cost: 0.02m))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);
        var record = CrewRunRecordFactory.From(Guid.NewGuid(), "rt", null, null, "goal", "out", result);

        // Exactly what DbAgentRunWriter does: serialize the step transcript to a jsonb string.
        var json = System.Text.Json.JsonSerializer.Serialize(record.Steps);
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var arr = doc.RootElement;

        Assert.Equal(System.Text.Json.JsonValueKind.Array, arr.ValueKind);
        Assert.Equal(3, arr.GetArrayLength());

        var first = arr[0];
        Assert.Equal(CrewRunRecordFactory.SubAgentStepKind, first.GetProperty("Kind").GetString());
        var payload = first.GetProperty("Payload");
        Assert.Equal("s1", payload.GetProperty("stage").GetString());
        Assert.Equal("genre", payload.GetProperty("agentName").GetString());
        // Nested sub-agent transcript survives the double serialization.
        Assert.Equal(System.Text.Json.JsonValueKind.Array, payload.GetProperty("steps").ValueKind);
        Assert.True(payload.GetProperty("steps").GetArrayLength() >= 1);
        // Indexes preserved across the whole transcript.
        Assert.Equal([0, 1, 2], arr.EnumerateArray().Select(e => e.GetProperty("Index").GetInt32()));
    }

    // A4. Per-task DI scope must be DISPOSED on every path, including when the sub-agent throws.
    [Fact]
    public async Task RunAsync_SubAgentThrows_ChildScopeStillDisposed()
    {
        var tracker = new ScopeTracker();
        var root = new ServiceCollection()
            .AddSingleton(tracker)
            .AddScoped<ScopeProbe>()
            .BuildServiceProvider();

        var plan = new CrewPlan<State>("dispose",
        [
            Stage("s1",
                Wrap("ok", new ProbeAgent()),
                Wrap("boom", new ProbeThenThrowAgent())),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(root), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusError, result.Status);
        // Both child scopes were created AND disposed — no scope leak on the error path.
        Assert.Equal(2, tracker.Created);
        Assert.Equal(2, tracker.Disposed);
    }

    private sealed class ScopeTracker
    {
        private int _created;
        private int _disposed;
        public int Created => _created;
        public int Disposed => _disposed;
        public void OnCreate() => Interlocked.Increment(ref _created);
        public void OnDispose() => Interlocked.Increment(ref _disposed);
    }

    // A scoped service that records its create/dispose against the singleton tracker.
    private sealed class ScopeProbe : IDisposable
    {
        private readonly ScopeTracker _tracker;
        public ScopeProbe(ScopeTracker tracker) { _tracker = tracker; _tracker.OnCreate(); }
        public void Dispose() => _tracker.OnDispose();
    }

    private sealed class ProbeAgent : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            ctx.Services.GetRequiredService<ScopeProbe>(); // force the scoped service to materialize
            return Task.FromResult(new AgentResult<string>("ok", [Step()], Usage()));
        }
    }

    private sealed class ProbeThenThrowAgent : IAgent<int, string>
    {
        public Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            ctx.Services.GetRequiredService<ScopeProbe>();
            throw new InvalidOperationException("boom");
        }
    }

    // A5. FAIL-CLOSED: a sub-agent that hits AgentBudgetExhaustedException is crew-terminating. The crew
    //     halts (next stage never runs) and reports the distinct "budget_exhausted" status (NOT "error"),
    //     keeping the partial transcript; that sub-agent's fold never applied.
    [Fact]
    public async Task RunAsync_SubAgentBudgetExhausted_CrewHaltsFailClosed_NextStageSkipped()
    {
        var ex = new AgentBudgetExhaustedException("hit cap", [Step()], new AgentUsage(1, 10, 5, 0m, 0));
        var ranStage2 = false;

        var plan = new CrewPlan<State>("budget-halt",
        [
            Stage("s1", Wrap("broke", new BudgetAgent(ex))),
            Stage("s2", CrewTasks.Of<State, int, string>("b", new TagAgent("B"),
                s => { ranStage2 = true; return 0; }, (s, o) => s.Log.Add(o))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        // The crew failed closed on the budget-exhausted sub-agent — stage 2 never ran.
        Assert.False(ranStage2);
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Status);
        // Partial transcript holds only s1; its fold did NOT apply (no "broke" tag, no "B").
        Assert.Single(result.Steps);
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Steps[0].Status);
        Assert.Empty(result.State.Log);
        Assert.Contains("broke", result.Error);
        Assert.Contains("s1", result.Error);
    }

    // A6. Precedence: when a stage BOTH errors and trips the cost cap, "error" wins (checked first).
    [Fact]
    public async Task RunAsync_StageErrorsAndTripsCap_ErrorTakesPrecedence()
    {
        var plan = new CrewPlan<State>("prec",
        [
            Stage("s1",
                Wrap("spendy", new TagAgent("S", cost: 1.00m)),
                Wrap("boom", new ThrowingAgent(new InvalidOperationException("x")))),
        ], new CrewOptions(CostCapUsd: 0.10m));

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusError, result.Status);
        Assert.Equal("One or more sub-agents failed.", result.Error);
    }

    // A7. Empty plan (no stages) → completes with no steps, no usage, original state untouched.
    [Fact]
    public async Task RunAsync_EmptyPlan_CompletesWithNoSteps()
    {
        var plan = new CrewPlan<State>("empty", [], new CrewOptions());
        var state = new State();

        var result = await new CrewOrchestrator().RunAsync(plan, state, Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.Empty(result.Steps);
        Assert.Equal(0, result.Usage.Iterations);
        Assert.Same(state, result.State);
        Assert.Empty(result.State.Log);
    }

    // A8. Latency is WALL-CLOCK, not the sum of sub-agent durations: two parallel 200ms agents finish in
    //     ~200ms, not ~400ms. (Guards the "latency = wall-clock for parallel" claim.)
    [Fact]
    public async Task RunAsync_ParallelStage_LatencyIsWallClockNotSum()
    {
        var plan = new CrewPlan<State>("latency",
        [
            Stage("s1", Wrap("a", new DelayAgent("A", 200)), Wrap("b", new DelayAgent("B", 200))),
        ], new CrewOptions(MaxParallelism: 2));

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        // Sequential would be >= 400ms; the bound sits 100ms above wall-clock so scheduler jitter on a
        // shared runner (60ms agents under a 110ms bound measured 113ms, #1074) cannot cross it.
        Assert.True(result.Usage.LatencyMs < 300, $"latency {result.Usage.LatencyMs}ms looks like a sum, not wall-clock");
    }

    private sealed class DelayAgent(string tag, int ms) : IAgent<int, string>
    {
        public async Task<AgentResult<string>> RunAsync(int input, AgentContext ctx, CancellationToken ct)
        {
            await Task.Delay(ms, ct);
            return new AgentResult<string>(tag, [Step()], Usage());
        }
    }

    // A9. Empty stage (zero tasks) must not crash or hang. It currently goes through the N-task path
    //     (Task.WhenAll over an empty array) → no folds, no steps for that stage.
    [Fact]
    public async Task RunAsync_StageWithNoTasks_IsNoOpAndCrewCompletes()
    {
        var plan = new CrewPlan<State>("emptystage",
        [
            new CrewStage<State>("s1", []),
            Stage("s2", Wrap("a", new TagAgent("A"))),
        ], new CrewOptions());

        var result = await new CrewOrchestrator().RunAsync(plan, new State(), Ctx(), TestContext.Current.CancellationToken);

        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.Equal(["A"], result.State.Log);
        Assert.Single(result.Steps);             // only s2 produced a step
        Assert.Equal("s2", result.Steps[0].Stage);
        Assert.Equal(0, result.Steps[0].Index);  // index counter unaffected by the empty stage
    }
}
