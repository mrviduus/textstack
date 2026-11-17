using System.Diagnostics;
using TextStack.Ai.Core;

namespace TextStack.Ai.Agents;

/// <summary>
/// The generic multi-agent orchestration engine (Phase 7, AI-040) — the crew-level analogue of
/// <see cref="AgentLoop"/>. Runs a <see cref="CrewPlan{TState}"/> stage by stage over a shared mutable
/// <typeparamref name="TState"/>: a single-task stage runs sequentially, a multi-task stage fans out in
/// parallel bounded by <see cref="CrewOptions.MaxParallelism"/> (a <see cref="SemaphoreSlim"/>, mirroring
/// <c>ToolDispatcher.DispatchAllAsync</c>). Each task gets its own DI scope (via <c>CrewTasks.Of</c>) so
/// parallel sub-agents never share scoped services.
///
/// Determinism &amp; budgets: each task hands back a <see cref="CrewTaskOutcome"/> (its transcript result +
/// a deferred fold); after <c>Task.WhenAll</c> the orchestrator runs the folds single-threaded in task
/// DECLARATION order (never completion order), then appends the transcript in the same order. Usage is
/// summed across every sub-agent (Iterations = total sub-agent invocations, latency = wall-clock). The cost
/// cap is checked AFTER each stage (the next stage is simply not started). A sub-agent error fails the crew
/// closed (status <c>error</c>); a budget-exhausted sub-agent also halts the crew (status
/// <c>budget_exhausted</c>) — both record the stage first and keep the partial transcript, exactly like
/// <see cref="AgentLoop"/>. Cancellation propagates raw: the primitive persists nothing (the caller owns
/// persistence, AI-036/agent_run).
///
/// Stateless singleton — per-run state lives on the stack of <see cref="RunAsync"/>.
/// </summary>
public sealed class CrewOrchestrator
{
    public async Task<CrewResult<TState>> RunAsync<TState>(
        CrewPlan<TState> plan, TState state, AgentContext ctx, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var steps = new List<CrewStepEntry>();

        int inputTokens = 0, outputTokens = 0, invocations = 0;
        decimal cost = 0m;

        foreach (var stage in plan.Stages)
        {
            ct.ThrowIfCancellationRequested();

            // Run the stage's tasks (1 → directly, N → bounded parallel). Outcomes come back in task
            // DECLARATION order (Task.WhenAll preserves input order) so folds + transcript are deterministic.
            var outcomes = await RunStageAsync(stage, state, ctx, plan.Options.MaxParallelism, ct);

            // Apply folds sequentially, on this thread, in declaration order — never concurrently.
            foreach (var o in outcomes)
                o.Fold?.Invoke();

            var stageHadError = false;
            string? budgetExhaustedAgent = null;
            for (var i = 0; i < outcomes.Count; i++)
            {
                var r = outcomes[i].Result;
                steps.Add(new CrewStepEntry(invocations, stage.Name, r.AgentName, r.Status, r.Steps, r.Usage, r.Error));
                invocations++;

                inputTokens += r.Usage.InputTokensTotal;
                outputTokens += r.Usage.OutputTokensTotal;
                cost += r.Usage.CostUsdTotal;

                if (r.Status == CrewRunRecordFactory.StatusError)
                    stageHadError = true;
                else if (r.Status == CrewRunRecordFactory.StatusBudgetExhausted)
                    budgetExhaustedAgent ??= r.AgentName;
            }

            // Fail closed: a sub-agent error terminates the crew after the stage is recorded; peers
            // already completed (they were awaited). The next stage does not start.
            if (stageHadError)
            {
                return new CrewResult<TState>(
                    state, CrewRunRecordFactory.StatusError, steps,
                    Usage(invocations, inputTokens, outputTokens, cost, sw),
                    "One or more sub-agents failed.");
            }

            // Fail closed on a budget-exhausted sub-agent too — but keep the distinct budget_exhausted
            // status so the transcript stays diagnosable. Next stage does not start; partial transcript kept.
            if (budgetExhaustedAgent is not null)
            {
                return new CrewResult<TState>(
                    state, CrewRunRecordFactory.StatusBudgetExhausted, steps,
                    Usage(invocations, inputTokens, outputTokens, cost, sw),
                    $"Sub-agent '{budgetExhaustedAgent}' exhausted its budget in stage '{stage.Name}'; crew halted.");
            }

            // Cost cap checked AFTER the stage — keep the partial transcript, don't start the next stage.
            if (plan.Options.CostCapUsd is { } cap && cost >= cap)
            {
                return new CrewResult<TState>(
                    state, CrewRunRecordFactory.StatusBudgetExhausted, steps,
                    Usage(invocations, inputTokens, outputTokens, cost, sw),
                    $"Crew cost cap ${cap} exceeded after stage '{stage.Name}' (${cost}).");
            }
        }

        return new CrewResult<TState>(
            state, CrewRunRecordFactory.StatusCompleted, steps,
            Usage(invocations, inputTokens, outputTokens, cost, sw),
            null);
    }

    /// <summary>
    /// Runs one stage and returns the per-task outcomes in task DECLARATION order. One task → awaited
    /// directly. N tasks → <c>Task.WhenAll</c> bounded by a semaphore. Each task creates its own child DI
    /// scope inside <c>CrewTasks.Of</c>, so the orchestrator just hands every task the same <paramref name="ctx"/>.
    /// </summary>
    private static async Task<IReadOnlyList<CrewTaskOutcome>> RunStageAsync<TState>(
        CrewStage<TState> stage, TState state, AgentContext ctx, int maxParallelism, CancellationToken ct)
    {
        var tasks = stage.Tasks;

        if (tasks.Count == 1)
        {
            var outcome = await tasks[0](state, ctx, ct);
            return new[] { outcome };
        }

        using var gate = new SemaphoreSlim(Math.Max(1, maxParallelism));
        var running = new Task<CrewTaskOutcome>[tasks.Count];
        for (var i = 0; i < tasks.Count; i++)
        {
            var task = tasks[i];
            running[i] = RunBoundedAsync(gate, () => task(state, ctx, ct), ct);
        }

        // WhenAll preserves the input array order → outcomes are in declaration order.
        return await Task.WhenAll(running);
    }

    private static async Task<CrewTaskOutcome> RunBoundedAsync(
        SemaphoreSlim gate, Func<Task<CrewTaskOutcome>> run, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { return await run(); }
        finally { gate.Release(); }
    }

    private static AgentUsage Usage(int invocations, int inputTokens, int outputTokens, decimal cost, Stopwatch sw) =>
        new(invocations, inputTokens, outputTokens, cost, (int)sw.ElapsedMilliseconds);
}
