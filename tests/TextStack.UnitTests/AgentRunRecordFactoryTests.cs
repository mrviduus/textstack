using System.Text.Json;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// AI-036 — the pure factory that turns a run outcome into a persistable <see cref="AgentRunRecord"/>:
/// completed, budget-exhausted (keeps the partial transcript), and errored.
/// </summary>
public class AgentRunRecordFactoryTests
{
    private static AgentStep Step(int i, string kind) =>
        new(i, kind, JsonDocument.Parse("""{"x":1}""").RootElement, DateTimeOffset.UtcNow);

    private static readonly Guid Id = Guid.NewGuid();
    private static readonly Guid User = Guid.NewGuid();
    private static readonly Guid Edition = Guid.NewGuid();

    [Fact]
    public void Completed_CarriesOutputStepsAndUsage()
    {
        var result = new AgentResult<string>(
            "Final answer.", [Step(0, "llm_response")], new AgentUsage(2, 30, 12, 0.004m, 850));

        var record = AgentRunRecordFactory.Completed(Id, "tutor", User, Edition, "passage", result);

        Assert.Equal("completed", record.Status);
        Assert.Equal("Final answer.", record.Output);
        Assert.Null(record.Error);
        Assert.Single(record.Steps);
        Assert.Equal(2, record.Usage.Iterations);
        Assert.Equal(0.004m, record.Usage.CostUsdTotal);
        Assert.Equal(Id, record.Id);
        Assert.NotEqual(default, record.CreatedAt);
    }

    [Fact]
    public void BudgetExhausted_KeepsPartialTranscriptAndUsage_NoOutput()
    {
        var ex = new AgentBudgetExhaustedException(
            "cap exceeded",
            [Step(0, "llm_response"), Step(0, "tool_result")],
            new AgentUsage(1, 50, 20, 0.05m, 1200));

        var record = AgentRunRecordFactory.BudgetExhausted(Id, "tutor", User, Edition, "passage", ex);

        Assert.Equal("budget_exhausted", record.Status);
        Assert.Null(record.Output);
        Assert.Equal("cap exceeded", record.Error);
        Assert.Equal(2, record.Steps.Count);          // partial transcript preserved
        Assert.Equal(0.05m, record.Usage.CostUsdTotal);
    }

    [Fact]
    public void Failed_EmptyTranscriptZeroUsage_WithError()
    {
        var record = AgentRunRecordFactory.Failed(
            Id, "tutor", User, Edition, "passage", new InvalidOperationException("boom"));

        Assert.Equal("error", record.Status);
        Assert.Null(record.Output);
        Assert.Equal("boom", record.Error);
        Assert.Empty(record.Steps);
        Assert.Equal(0, record.Usage.Iterations);
    }
}
