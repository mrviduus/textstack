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
            Mode = SsgRebuildMode.Full,
            Concurrency = request.Concurrency ?? 4,
            TimeoutMs = 30000,
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
                j.Mode.ToString(),
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

    public async Task<SsgRebuildJobStatsDto?> GetJobStatsAsync(Guid jobId, CancellationToken ct)
    {
        var jobExists = await _db.SsgRebuildJobs.AnyAsync(j => j.Id == jobId, ct);
        if (!jobExists)
            return null;

        var results = _db.SsgRebuildResults
            .AsNoTracking()
            .Where(r => r.JobId == jobId);

        var total = await results.CountAsync(ct);
        var successful = await results.CountAsync(r => r.Success, ct);
        var failed = await results.CountAsync(r => !r.Success, ct);

        var bookRoutes = await results.CountAsync(r => r.RouteType == "book", ct);
        var authorRoutes = await results.CountAsync(r => r.RouteType == "author", ct);
        var genreRoutes = await results.CountAsync(r => r.RouteType == "genre", ct);
        var staticRoutes = await results.CountAsync(r => r.RouteType == "static", ct);

        var avgTime = total > 0
            ? await results.Where(r => r.RenderTimeMs.HasValue).AverageAsync(r => (double?)r.RenderTimeMs, ct) ?? 0
            : 0;

        return new SsgRebuildJobStatsDto(
            Total: total,
            Successful: successful,
            Failed: failed,
            BookRoutes: bookRoutes,
            AuthorRoutes: authorRoutes,
            GenreRoutes: genreRoutes,
            StaticRoutes: staticRoutes,
            AvgRenderTimeMs: avgTime
        );
    }

    public async Task<(int Total, List<SsgRebuildResultDto> Items)> GetResultsAsync(
        Guid jobId, SsgRebuildResultsFilter filter, CancellationToken ct)
    {
        var query = _db.SsgRebuildResults
            .AsNoTracking()
            .Where(r => r.JobId == jobId);

        if (filter.Failed == true)
            query = query.Where(r => !r.Success);
        else if (filter.Failed == false)
            query = query.Where(r => r.Success);

        if (!string.IsNullOrEmpty(filter.RouteType))
            query = query.Where(r => r.RouteType == filter.RouteType);

        var total = await query.CountAsync(ct);
        var items = await query
            .OrderBy(r => r.RouteType)
            .ThenBy(r => r.Route)
            .Skip(filter.Offset)
            .Take(Math.Min(filter.Limit, 100))
            .Select(r => new SsgRebuildResultDto(
                r.Id,
                r.Route,
                r.RouteType,
                r.Success,
                r.RenderTimeMs,
                r.Error,
                r.RenderedAt
            ))
            .ToListAsync(ct);

        return (total, items);
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
            job.Mode.ToString(),
            job.Status.ToString(),
            job.TotalRoutes,
            job.RenderedCount,
            job.FailedCount,
            job.Concurrency,
            job.TimeoutMs,
            job.Error,
            job.CreatedAt,
            job.StartedAt,
            job.FinishedAt
        );

    #endregion
}
