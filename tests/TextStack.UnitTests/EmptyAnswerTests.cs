using System.Text.Json;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// A provider call that returns no text and no tool calls is a failure without an exception: translate
/// turns it into a 502 that reached nobody (#922). It must alarm — but not for Ollama's swallowed-failure
/// shape (zero tokens), which OllamaLlmClient has already reported itself.
/// </summary>
public class EmptyAnswerTests
{
    private static LlmResponse Response(string text, int inputTokens, int outputTokens, params ToolCall[] calls) =>
        new(text, calls, new LlmUsage(inputTokens, outputTokens, 0m), "model", Guid.NewGuid());

    [Fact]
    public void IsEmptyAnswer_ReasoningSpentAllTokens_IsEmpty() =>
        Assert.True(TracingDecorator.IsEmptyAnswer(Response("  ", inputTokens: 120, outputTokens: 512)));

    [Fact]
    public void IsEmptyAnswer_OllamaSwallowedFailure_IsNotReportedAgain() =>
        Assert.False(TracingDecorator.IsEmptyAnswer(Response("", inputTokens: 0, outputTokens: 0)));

    [Fact]
    public void IsEmptyAnswer_ToolCallWithoutText_IsNotEmpty() =>
        Assert.False(TracingDecorator.IsEmptyAnswer(Response("", 120, 30,
            new ToolCall("1", "search", JsonDocument.Parse("{}").RootElement))));

    [Fact]
    public void IsEmptyAnswer_NormalAnswer_IsNotEmpty() =>
        Assert.False(TracingDecorator.IsEmptyAnswer(Response("богиня", 120, 3)));
}
