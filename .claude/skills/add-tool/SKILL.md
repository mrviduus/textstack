---
name: add-tool
description: Add a new agent/function-calling tool (ITool) to TextStack. Use when adding a capability the LLM or an agent can call — e.g. fetch data, search, look something up. Covers schema, InvokeAsync, registry auto-discovery, and tests.
---

# Add a new ITool

Tools live in `backend/src/Application/Tools/`, implement `TextStack.Ai.Core.ITool`, and are
**auto-discovered** by the assembly scan (`AddAiTools`) — no manual registration. Dispatch is
JSON-Schema-validated before invoke; the agent/Explain decides when to call them.

## Steps

1. **Create `backend/src/Application/Tools/<Name>Tool.cs`** — copy the shape of `GetChapterTool.cs`:
   - `public sealed class <Name>Tool : ITool`, a stable snake_case `Name`, a clear `Description`
     (the model reads it to decide when to call), and an `ArgsSchema` built once with
     `ToolJson.Schema("""{ "type":"object", "properties": {...}, "required":[...],
     "additionalProperties": false }""")` — **always `additionalProperties:false`**.
   - `InvokeAsync(args, ctx, ct)`: read args via `ToolJson.GetString/GetInt` (shape is guaranteed by
     validation); resolve scoped services from **`ctx.Services`** (`GetRequiredService<IAppDbContext>()`,
     `IRagService`, etc.) — the dispatcher gives each call its own DI scope. Return `ToolJson.Result(new {...})`.
   - **Not-found / no-user / no-edition = data, not exceptions** where the model can recover
     (`{ found = false, ... }`); throw only for a genuine missing context the tool needs.
   - Spoiler-gate retrieval with the shared `ReadingProgressGate.ResolveLastReadOrdAsync` (don't re-copy it).

2. **Stateless** — the tool is a singleton; per-request state arrives via `ctx`. No fields holding scoped deps.

3. **Wire it to a consumer if needed**: Explain gates tools via `ExplainToolTriggers` + `ExplainEndpoints.ResolveTools`. A tool can exist in
   the registry without being offered to a given feature.

4. **Tests** (`tests/TextStack.UnitTests`): add a
   schema-validity case (happy path passes `ToolDispatcher.ValidateArgs`, malformed + unknown-prop fail).
   DB/RAG behaviour is covered by integration/e2e, not unit.

5. **Verify**: `dotnet build backend/src/Api/Api.csproj` · `dotnet test tests/TextStack.UnitTests`
   · `dotnet format --verify-no-changes`.

## Gotchas
- The assembly scan registers EVERY concrete `ITool` — a duplicate `Name` fails fast at registry
  construction. Keep names unique (also across test fakes).
- Tool args validation happens at dispatch; don't re-validate shape in `InvokeAsync`.
