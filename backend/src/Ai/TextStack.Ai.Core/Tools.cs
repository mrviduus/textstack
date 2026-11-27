using System.Text.Json;

namespace TextStack.Ai.Core;

/// <summary>One tool invocation requested by the model; arguments are raw JSON.</summary>
public record ToolCall(string Id, string ToolName, JsonElement Arguments);

/// <summary>The schema-only view of a tool — sent to the LLM during function-calling. No invocation logic here.</summary>
public record ToolSchema(string Name, string Description, JsonElement ArgsSchema);

