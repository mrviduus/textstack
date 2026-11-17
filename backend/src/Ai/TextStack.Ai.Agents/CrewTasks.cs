using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;

namespace TextStack.Ai.Agents;

/// <summary>
/// Adapters that wrap a typed <see cref="IAgent{TIn,TOut}"/> as a <see cref="CrewTask{TState}"/> the
/// <see cref="CrewOrchestrator"/> can schedule (AI-040). Each task:
/// <list type="bullet">
/// <item>creates its OWN child DI scope from <c>ctx.Services</c> (the ToolDispatcher per-invocation-scope
///   rule — two parallel sub-agents must not share scoped services) and runs the agent under it;</item>
/// <item>on success, returns its fold as a deferred <see cref="Action"/> on the <see cref="CrewTaskOutcome"/>
///   — it never mutates the shared state in the parallel body, so the orchestrator can apply folds
///   sequentially in declaration order after <c>Task.WhenAll</c>;</item>
/// <item>maps budget-exhaustion / errors to a <see cref="CrewTaskResult"/> as DATA with a null fold (only
///   true cancellation propagates), so a failing peer never crashes the fan-out.</item>
/// </list>
/// </summary>
public static class CrewTasks
{
    private static readonly AgentUsage NoUsage = new(0, 0, 0, 0m, 0);

    /// <summary>
    /// Wraps <paramref name="agent"/> as a crew task: build its input from the shared state, run it, and
    /// (on success) hand back a deferred fold of its typed output. The fold is captured but executed later
    /// by the orchestrator (declaration-ordered, single-threaded) — never inline in the parallel body.
    /// </summary>
    public static CrewTask<TState> Of<TState, TIn, TOut>(
        string agentName,
        IAgent<TIn, TOut> agent,
        Func<TState, TIn> buildInput,
        Action<TState, TOut> fold)
    {
        return async (state, ctx, ct) =>
        {
            // Own DI scope per task: scoped services must not be shared across the
            // parallel fan-out. Mirrors ToolDispatcher.DispatchAsync.
            using var scope = ctx.Services.CreateScope();
            var scopedCtx = ctx with { Services = scope.ServiceProvider };

            try
            {
                var result = await agent.RunAsync(buildInput(state), scopedCtx, ct);

                // Defer the fold rather than mutating shared state mid-fan-out. The orchestrator runs folds
                // in declaration order on its own thread after Task.WhenAll, so they are ordered and non-racy.
                return new CrewTaskOutcome(
                    new CrewTaskResult(agentName, CrewRunRecordFactory.StatusCompleted, result.Steps, result.Usage, null),
                    () => fold(state, result.Output));
            }
            catch (AgentBudgetExhaustedException ex)
            {
                // Keep the partial transcript/usage the exception carries; do NOT fold (null fold).
                return new CrewTaskOutcome(
                    new CrewTaskResult(agentName, CrewRunRecordFactory.StatusBudgetExhausted, ex.Steps, ex.Usage, ex.Message),
                    null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw; // caller cancelled — propagate; the primitive persists nothing
            }
            catch (Exception ex)
            {
                // Any other failure is data (null fold): the peer fan-out completes, the crew then fails closed.
                return new CrewTaskOutcome(
                    new CrewTaskResult(agentName, CrewRunRecordFactory.StatusError, [], NoUsage, ex.Message),
                    null);
            }
        };
    }
}
