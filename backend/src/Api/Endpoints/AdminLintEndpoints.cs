using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class AdminLintEndpoints
{
    public static void MapAdminLintEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin").WithTags("Admin Lint");

        group.MapGet("/editions/{id:guid}/lint", GetEditionLintResults)
            .WithName("GetEditionLintResults")
            .WithDescription("Get lint results for an edition");

        group.MapDelete("/editions/{id:guid}/lint", ClearEditionLintResults)
            .WithName("ClearEditionLintResults")
            .WithDescription("Clear lint results for an edition");
    }

    private static async Task<IResult> GetEditionLintResults(
        Guid id,
        IAppDbContext db,
        CancellationToken ct)
    {
        var edition = await db.Editions.AnyAsync(e => e.Id == id, ct);
        if (!edition)
            return Results.NotFound(new { error = "Edition not found" });

        var results = await db.LintResults
            .Where(r => r.EditionId == id)
            .OrderBy(r => r.ChapterNumber)
            .ThenBy(r => r.LineNumber)
            .Select(r => new
            {
                r.Id,
                r.Severity,
                r.Code,
                r.Message,
                r.ChapterNumber,
                r.LineNumber,
                r.Context,
                r.CreatedAt
            })
            .ToListAsync(ct);

        var summary = new
        {
            total = results.Count,
            errors = results.Count(r => r.Severity.ToString() == "Error"),
            warnings = results.Count(r => r.Severity.ToString() == "Warning"),
            info = results.Count(r => r.Severity.ToString() == "Info")
        };

        return Results.Ok(new { summary, results });
    }

    private static async Task<IResult> ClearEditionLintResults(
        Guid id,
        IAppDbContext db,
        CancellationToken ct)
    {
        var edition = await db.Editions.AnyAsync(e => e.Id == id, ct);
        if (!edition)
            return Results.NotFound(new { error = "Edition not found" });

        var results = await db.LintResults
            .Where(r => r.EditionId == id)
            .ToListAsync(ct);

        db.LintResults.RemoveRange(results);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { deleted = results.Count });
    }
}
