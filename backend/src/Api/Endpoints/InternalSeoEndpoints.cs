using Api.Extensions;
using Application.Common.Interfaces;
using Application.Seo;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

/// <summary>
/// Endpoints consumed by the systemd seo-backfill-poll.sh script. Docker-network only
/// (same IP allow-list as InternalEndpoints). Not listed in public API docs.
/// </summary>
public static class InternalSeoEndpoints
{
    public static void MapInternalSeoEndpoints(this WebApplication app)
    {
        app.MapGet("/internal/seo/enabled", Enabled).ExcludeFromDescription();
        app.MapPost("/internal/seo/jobs/claim", Claim).ExcludeFromDescription();
        app.MapGet("/internal/seo/jobs/{id:guid}/context", GetContext).ExcludeFromDescription();
        app.MapPost("/internal/seo/jobs/{id:guid}/apply", Apply).ExcludeFromDescription();
        app.MapPost("/internal/seo/jobs/{id:guid}/fail", Fail).ExcludeFromDescription();
    }

    private static async Task<IResult> Enabled(HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        var s = await db.SeoBackfillSettings.AsNoTracking().FirstOrDefaultAsync(ct);
        return Results.Ok(new { enabled = s?.Enabled ?? false, jobsPerRun = s?.JobsPerRun ?? 5, intervalSeconds = s?.IntervalSeconds ?? 60 });
    }

    private static async Task<IResult> Claim(
        HttpContext ctx,
        SeoJobProcessor processor,
        [FromQuery] int limit = 1,
        CancellationToken ct = default)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        var ids = await processor.ClaimNextAsync(limit, ct);
        return Results.Ok(new { claimed = ids });
    }

    private static async Task<IResult> GetContext(
        Guid id,
        HttpContext ctx,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        try
        {
            var context = await processor.GetContextAsync(id, ct);
            return Results.Ok(context);
        }
        catch (InvalidOperationException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    public record ApplyRequest(Dictionary<string, string> FieldOutputs);

    private static async Task<IResult> Apply(
        Guid id,
        [FromBody] ApplyRequest req,
        HttpContext ctx,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        try
        {
            var status = await processor.ApplyAsync(id, req.FieldOutputs, ct);
            return Results.Ok(new { status });
        }
        catch (InvalidOperationException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }

    public record FailRequest(string Error);

    private static async Task<IResult> Fail(
        Guid id,
        [FromBody] FailRequest req,
        HttpContext ctx,
        SeoJobProcessor processor,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        try
        {
            await processor.FailAsync(id, req.Error, ct);
            return Results.Ok();
        }
        catch (InvalidOperationException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }
}
