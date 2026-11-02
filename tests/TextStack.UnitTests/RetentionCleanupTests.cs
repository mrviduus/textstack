using Domain.Entities;
using Worker.Services;

namespace TextStack.UnitTests;

/// <summary>The daily retention sweep deletes only rows past their rule, never a live one.</summary>
public class RetentionCleanupTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 5, 12, 0, 0, TimeSpan.Zero);

    private static bool IsOldSsgJob(DateTimeOffset? finishedAt) =>
        RetentionCleanupWorker.OldSsgRebuildJob(Now).Compile()(
            new SsgRebuildJob { CreatedAt = Now.AddYears(-1), FinishedAt = finishedAt });

    [Fact]
    public void OldSsgRebuildJob_FinishedLongAgo_Deleted() =>
        Assert.True(IsOldSsgJob(Now.AddDays(-31)));

    [Fact]
    public void OldSsgRebuildJob_NeverFinished_Kept() =>
        Assert.False(IsOldSsgJob(null));

    [Fact]
    public void OldSsgRebuildJob_FinishedRecently_Kept() =>
        Assert.False(IsOldSsgJob(Now.AddDays(-29)));

    private static bool IsOldTutorSession(DateTimeOffset updatedAt) =>
        RetentionCleanupWorker.OldTutorSession(Now).Compile()(
            new TutorSession { PlanJson = "{}", UpdatedAt = updatedAt });

    [Fact]
    public void OldTutorSession_IdleOver90Days_Deleted() =>
        Assert.True(IsOldTutorSession(Now.AddDays(-91)));

    [Fact]
    public void OldTutorSession_UsedRecently_Kept() =>
        Assert.False(IsOldTutorSession(Now.AddDays(-89)));

    private static LlmTrace Trace(DateTimeOffset createdAt, string messages = "[{\"role\":\"user\"}]", string? response = "text") =>
        new() { FeatureTag = "f", ModelId = "m", PromptHash = "h", MessagesJson = messages, ResponseText = response, CreatedAt = createdAt };

    [Fact]
    public void LlmTraceTextToScrub_OldWithText_Selected()
    {
        var rule = RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile();
        Assert.True(rule(Trace(Now.AddDays(-31))));
    }

    [Fact]
    public void LlmTraceTextToScrub_Recent_Kept() =>
        Assert.False(RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile()(Trace(Now.AddDays(-29))));

    [Fact]
    public void LlmTraceTextToScrub_AlreadyScrubbed_NotRewrittenDaily() =>
        Assert.False(RetentionCleanupWorker.LlmTraceTextToScrub(Now).Compile()(
            Trace(Now.AddDays(-31), RetentionCleanupWorker.ScrubbedMessages, response: null)));

    private static AgentRun Run(DateTimeOffset at) =>
        new() { Agent = "a", Goal = "g", Status = "done", StepsJson = "[]", CreatedAt = at };

    [Fact]
    public void OldAgentRun_Over30Days_Deleted() =>
        Assert.True(RetentionCleanupWorker.OldAgentRun(Now).Compile()(Run(Now.AddDays(-31))));

    [Fact]
    public void OldAgentRun_Recent_Kept() =>
        Assert.False(RetentionCleanupWorker.OldAgentRun(Now).Compile()(Run(Now.AddDays(-29))));
}
