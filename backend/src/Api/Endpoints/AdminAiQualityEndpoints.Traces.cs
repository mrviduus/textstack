using Contracts.Admin;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static partial class AdminAiQualityEndpoints
{
    private static async Task<IResult> GetTraces(
        AppDbContext db,
        [FromQuery] string? feature,
        [FromQuery] string? q,
        [FromQuery] int limit = 50,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = db.LlmTraces.AsQueryable();
        if (!string.IsNullOrWhiteSpace(feature))
            query = query.Where(t => t.FeatureTag == feature);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var pattern = $"%{q.Trim()}%";
            query = query.Where(t =>
                (t.SystemPrompt != null && EF.Functions.ILike(t.SystemPrompt, pattern)) ||
                (t.ResponseText != null && EF.Functions.ILike(t.ResponseText, pattern)));
        }

        var total = await query.LongCountAsync(ct);
        var items = await query
            .OrderByDescending(t => t.CreatedAt)
            .Skip(offset).Take(limit)
            .Select(t => new TraceListItemDto(
                t.Id, t.FeatureTag, t.ModelId, t.TokensIn, t.TokensOut,
                t.CostUsd, t.LatencyMs, t.Error != null, t.CreatedAt))
            .ToListAsync(ct);

        return Results.Ok(new TracesPageDto(total, items));
    }

    // AI-045: list persisted agent_run rows for the admin transcript UI. Mirrors GetTraces
    // (newest-first, clamp, paged). The list projection omits StepsJson + Output (both big) and
    // truncates Goal. The `agent` filter matches exact OR prefix (so "crew." narrows to all crew
    // runs, "crew.autopublish"/"tutor" narrow to that one).
    private static async Task<IResult> GetAgentRuns(
        AppDbContext db,
        [FromQuery] string? agent,
        [FromQuery] int limit = 25,
        [FromQuery] int offset = 0,
        CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 100);
        offset = Math.Max(offset, 0);

        var query = db.AgentRuns.AsQueryable();
        if (!string.IsNullOrWhiteSpace(agent))
        {
            var a = agent.Trim();
            query = query.Where(r => r.Agent == a || r.Agent.StartsWith(a));
        }

        var total = await query.LongCountAsync(ct);
        var rows = await query
            .OrderByDescending(r => r.CreatedAt)
            .Skip(offset).Take(limit)
            .Select(r => new
            {
                r.Id,
                r.Agent,
                r.UserId,
                r.EditionId,
                r.Status,
                r.Goal,
                r.Iterations,
                r.TokensIn,
                r.TokensOut,
                r.CostUsd,
                r.LatencyMs,
                HasError = r.Error != null && r.Error != "",
                r.CreatedAt,
            })
            .ToListAsync(ct);

        var items = rows.Select(r => new AgentRunListItemDto(
            r.Id, r.Agent, r.UserId, r.EditionId, r.Status,
            r.Goal.Length > 120 ? r.Goal[..120] : r.Goal,
            r.Iterations, r.TokensIn, r.TokensOut, r.CostUsd, r.LatencyMs,
            r.HasError, r.CreatedAt)).ToList();

        return Results.Ok(new AgentRunsPageDto(total, items));
    }

    // AI-045: full transcript for one agent run (StepsJson shipped RAW; frontend parses).
    private static async Task<IResult> GetAgentRun(Guid id, AppDbContext db, CancellationToken ct)
    {
        var r = await db.AgentRuns.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (r is null) return Results.NotFound();
        return Results.Ok(new AgentRunDetailDto(
            r.Id, r.Agent, r.UserId, r.EditionId, r.Status, r.Goal, r.Output, r.StepsJson,
            r.Iterations, r.TokensIn, r.TokensOut, r.CostUsd, r.LatencyMs, r.Error, r.CreatedAt));
    }

    private static async Task<IResult> GetTrace(Guid id, AppDbContext db, CancellationToken ct)
    {
        var t = await db.LlmTraces.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (t is null) return Results.NotFound();
        return Results.Ok(new TraceDetailDto(
            t.Id, t.FeatureTag, t.ModelId, t.SystemPrompt, t.MessagesJson, t.ResponseText,
            t.ToolCallsJson, t.TokensIn, t.TokensOut, t.CostUsd, t.LatencyMs, t.Error, t.UserId, t.CreatedAt));
    }
}
