using System.Text.Json;
using Json.Schema;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;

namespace TextStack.Ai.Tools;

/// <summary>
/// Outcome of one tool dispatch. Failures are DATA, not exceptions — the result (or error) goes back
/// to the LLM as the tool message so the model can correct its arguments and retry (playbook Phase 5
/// risk mitigation). <see cref="Error"/> is model-facing: short, factual, no stack traces.
/// </summary>
public sealed record ToolResult(string CallId, string ToolName, bool Ok, JsonElement? Result, string? Error)
{
    public static ToolResult Success(ToolCall call, JsonElement result) =>
        new(call.Id, call.ToolName, true, result, null);

    public static ToolResult Failure(ToolCall call, string error) =>
        new(call.Id, call.ToolName, false, null, error);
}

/// <summary>
/// Validated tool dispatch (AI-030): resolves the tool from the <see cref="IToolRegistry"/>, evaluates
/// the call's arguments against the tool's JSON Schema (draft 2020-12, via JsonSchema.Net) and only
/// then invokes it. Unknown tool, invalid args, and tool exceptions all come back as failed
/// <see cref="ToolResult"/>s. Independent calls in a batch run in parallel (playbook scope).
/// </summary>
public sealed class ToolDispatcher(IToolRegistry registry)
{
    private static readonly EvaluationOptions SchemaOptions = new() { OutputFormat = OutputFormat.List };

    /// A JSON null to validate against when a call arrives with no arguments at
    /// all. Held once: JsonDocument owns unmanaged memory, and parsing "null"
    /// per call would allocate and leak a document on every tool invocation.
    private static readonly JsonElement NullInstance = JsonDocument.Parse("null").RootElement;

    public async Task<ToolResult> DispatchAsync(ToolCall call, ToolContext ctx, CancellationToken ct)
    {
        var tool = registry.Get(call.ToolName);
        if (tool is null)
            return ToolResult.Failure(call, $"Unknown tool '{call.ToolName}'. Available: {string.Join(", ", registry.Names)}.");

        var validationError = ValidateArgs(tool.ArgsSchema, call.Arguments);
        if (validationError is not null)
            return ToolResult.Failure(call, $"Invalid arguments: {validationError}");

        try
        {
            // Each invocation gets its OWN DI scope: tools resolve scoped services from
            // ToolContext.Services, and DispatchAllAsync runs calls in parallel — sharing the
            // request scope would make two tools use one scoped instance concurrently.
            using var scope = ctx.Services.CreateScope();
            var result = await tool.InvokeAsync(call.Arguments, ctx with { Services = scope.ServiceProvider }, ct);
            return ToolResult.Success(call, result);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw; // caller cancelled — propagate, don't feed back to the model
        }
        catch (Exception ex)
        {
            return ToolResult.Failure(call, $"Tool execution failed: {ex.Message}");
        }
    }

    /// <summary>Dispatches a batch concurrently (tools are independent by contract; Phase 5 scope).</summary>
    public Task<ToolResult[]> DispatchAllAsync(IReadOnlyList<ToolCall> calls, ToolContext ctx, CancellationToken ct) =>
        Task.WhenAll(calls.Select(c => DispatchAsync(c, ctx, ct)));

    /// <summary>
    /// Evaluates <paramref name="args"/> against <paramref name="schema"/>; null when valid, else a
    /// compact, model-readable list of violations ("path: message"). Pure — unit-tested directly.
    /// </summary>
    public static string? ValidateArgs(JsonElement schema, JsonElement args)
    {
        JsonSchema compiled;
        try
        {
            compiled = JsonSchema.FromText(schema.GetRawText());
        }
        catch (Exception ex)
        {
            return $"tool schema is invalid: {ex.Message}"; // a wiring bug, surfaced loudly
        }

        // JsonSchema.Net 9 evaluates a JsonElement directly; 7 took a JsonNode,
        // so this used to round-trip the arguments through JsonNode.Parse for no
        // reason other than the old signature. A missing argument object still
        // has to be validated as JSON null rather than skipped — a schema with
        // required properties must fail, not pass, when the model sends nothing.
        var instance = args.ValueKind == JsonValueKind.Undefined ? NullInstance : args;
        var evaluation = compiled.Evaluate(instance, SchemaOptions);
        if (evaluation.IsValid)
            return null;

        var violations = evaluation.Details
            .Where(d => d.Errors is { Count: > 0 })
            .SelectMany(d => d.Errors!.Select(e => $"{Location(d)}: {e.Value}"))
            .Distinct()
            .Take(5)
            .ToList();
        return violations.Count > 0 ? string.Join("; ", violations) : "arguments do not match the tool schema";

        // JsonSchema.Net 9 renamed JsonPointer.Count to SegmentCount.
        static string Location(EvaluationResults d) =>
            d.InstanceLocation.SegmentCount == 0 ? "$" : d.InstanceLocation.ToString();
    }
}
