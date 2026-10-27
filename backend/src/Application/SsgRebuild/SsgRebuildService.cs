using Application.Common.Interfaces;
using Contracts.Admin;
using Domain.Entities;
using Domain.Enums;
using Microsoft.EntityFrameworkCore;

namespace Application.SsgRebuild;

/// <summary>
/// Route model for SSG prerendering.
/// </summary>
public record SsgRoute(string Route, string RouteType);

/// <summary>
/// Manages SSG rebuild jobs - creation, status, stats, results.
/// Uses ISsgRouteProvider for route generation (SRP).
/// </summary>
public class SsgRebuildService : ISsgJobService
{
    private readonly IAppDbContext _db;
    private readonly ISsgRouteProvider _routeProvider;

    public SsgRebuildService(IAppDbContext db, ISsgRouteProvider routeProvider)
    {
        _db = db;
        _routeProvider = routeProvider;
    }

    public async Task<SsgRebuildPreviewDto> GetPreviewAsync(
        Guid siteId,
        CancellationToken ct)
    {
        var routes = await _routeProvider.GetRoutesAsync(siteId, ct);

        return new SsgRebuildPreviewDto(
            TotalRoutes: routes.Count,
            BookCount: routes.Count(r => r.RouteType == "book"),
            AuthorCount: routes.Count(r => r.RouteType == "author"),
            GenreCount: routes.Count(r => r.RouteType == "genre"),
            StaticCount: routes.Count(r => r.RouteType == "static")
        );
    }

    public async Task<SsgRebuildJob> CreateJobAsync(CreateSsgRebuildJobRequest request, CancellationToken ct)
    {
        var siteExists = await _db.Sites.AnyAsync(s => s.Id == request.SiteId, ct);
        if (!siteExists)
            throw new ArgumentException($"Site with ID {request.SiteId} not found");

        var routes = await _routeProvider.GetRoutesAsync(request.SiteId, ct);

        var job = new SsgRebuildJob
        {
            Id = Guid.NewGuid(),
            SiteId = request.SiteId,
            Concurrency = request.Concurrency ?? 4,
            Status = SsgRebuildJobStatus.Queued,
            TotalRoutes = routes.Count,
            CreatedAt = DateTimeOffset.UtcNow
        };

        _db.SsgRebuildJobs.Add(job);
        await _db.SaveChangesAsync(ct);
        return job;
    }

    public async Task<SsgRebuildJobDetailDto?> GetJobAsync(Guid id, CancellationToken ct)
    {
        var job = await _db.SsgRebuildJobs
            .AsNoTracking()
            .Include(j => j.Site)
            .FirstOrDefaultAsync(j => j.Id == id, ct);

        return job == null ? null : MapToDetail(job);
    }

    public async Task<(int Total, List<SsgRebuildJobListDto> Items)> GetJobsAsync(
        Guid? siteId, string? status, int offset, int limit, CancellationToken ct)
    {
        var query = _db.SsgRebuildJobs
            .AsNoTracking()
            .Include(j => j.Site)
            .AsQueryable();

        if (!string.IsNullOrEmpty(status) && Enum.TryParse<SsgRebuildJobStatus>(status, true, out var statusEnum))
            query = query.Where(j => j.Status == statusEnum);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderByDescending(j => j.CreatedAt)
            .Skip(offset)
            .Take(Math.Min(limit, 100))
            .Select(j => new SsgRebuildJobListDto(
                j.Id,
                j.SiteId,
                j.Site.Code,
                j.Status.ToString(),
                j.TotalRoutes,
                j.RenderedCount,
                j.FailedCount,
                j.Concurrency,
                j.CreatedAt,
                j.StartedAt,
                j.FinishedAt
            ))
            .ToListAsync(ct);

        return (total, items);
    }

    public async Task<bool> CancelJobAsync(Guid id, CancellationToken ct)
    {
        var job = await _db.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job == null)
            return false;

        if (job.Status == SsgRebuildJobStatus.Queued || job.Status == SsgRebuildJobStatus.Running)
        {
            job.Status = SsgRebuildJobStatus.Cancelled;
            job.FinishedAt = DateTimeOffset.UtcNow;
            await _db.SaveChangesAsync(ct);
            return true;
        }

        return false;
    }

    public async Task<SsgRebuildJob?> EnqueueFullRebuildAsync(Guid siteId, CancellationToken ct)
    {
        // A Queued Full covers this call: ssg-worker has not read its routes yet. A Running one blocks
        // too: re-rendering every route right after it is wasted work (~20 min, ~2000 IndexNow URLs),
        // and an edit made during the run waits for the next nightly — or the admin "New Rebuild"
        // button, which creates a job without this check. `make rebuild-ssg` waits it out and asks again.
        if (await _db.SsgRebuildJobs.AnyAsync(j =>
                j.Status == SsgRebuildJobStatus.Queued || j.Status == SsgRebuildJobStatus.Running, ct))
            return null;

        // Queued is the whole enqueue: ssg-worker claims it (FOR UPDATE SKIP LOCKED) and sets Running.
        return await CreateJobAsync(new CreateSsgRebuildJobRequest(siteId, Concurrency: 4), ct);
    }

    #region Private Helpers

    private static SsgRebuildJobDetailDto MapToDetail(SsgRebuildJob job) =>
        new(
            job.Id,
            job.SiteId,
            job.Site.Code,
            job.Status.ToString(),
            job.TotalRoutes,
            job.RenderedCount,
            job.FailedCount,
            job.Concurrency,
            job.Error,
            job.CreatedAt,
            job.StartedAt,
            job.FinishedAt
        );

    #endregion
}
