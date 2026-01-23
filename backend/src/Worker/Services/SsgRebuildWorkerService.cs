using System.Diagnostics;
using System.Text.Json;
using Application.SsgRebuild;
using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

public class SsgRebuildWorkerService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly ILogger<SsgRebuildWorkerService> _logger;

    // Script path - relative to working directory
    private const string ScriptPath = "apps/web/scripts/prerender.mjs";

    public SsgRebuildWorkerService(
        IDbContextFactory<AppDbContext> dbFactory,
        ILogger<SsgRebuildWorkerService> logger)
    {
        _dbFactory = dbFactory;
        _logger = logger;
    }

    public async Task<SsgRebuildJob?> GetNextJobAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.SsgRebuildJobs
            .Where(j => j.Status == SsgRebuildJobStatus.Running)
            .OrderBy(j => j.StartedAt)
            .FirstOrDefaultAsync(ct);
    }

    public async Task ProcessJobAsync(Guid jobId, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);

        var job = await db.SsgRebuildJobs
            .Include(j => j.Site)
            .FirstOrDefaultAsync(j => j.Id == jobId, ct);

        if (job == null)
        {
            _logger.LogWarning("Job {JobId} not found", jobId);
            return;
        }

        if (job.Status != SsgRebuildJobStatus.Running)
        {
            _logger.LogWarning("Job {JobId} is not in Running status (was {Status})", jobId, job.Status);
            return;
        }

        _logger.LogInformation("Starting SSG rebuild for job {JobId}, site {SiteCode}, mode {Mode}",
            jobId, job.Site.Code, job.Mode);

        try
        {
            await RunPrerenderAsync(job, ct);

            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SsgRebuildJobStatus.Completed;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogInformation("SSG rebuild completed for job {JobId}", jobId);
        }
        catch (OperationCanceledException)
        {
            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SsgRebuildJobStatus.Cancelled;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogInformation("SSG rebuild cancelled for job {JobId}", jobId);
        }
        catch (Exception ex)
        {
            await using var dbUpdate = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var jobToUpdate = await dbUpdate.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (jobToUpdate != null)
            {
                jobToUpdate.Status = SsgRebuildJobStatus.Failed;
                jobToUpdate.Error = ex.Message;
                jobToUpdate.FinishedAt = DateTimeOffset.UtcNow;
                await dbUpdate.SaveChangesAsync(CancellationToken.None);
            }

            _logger.LogError(ex, "SSG rebuild failed for job {JobId}", jobId);
        }
    }

    private async Task RunPrerenderAsync(SsgRebuildJob job, CancellationToken ct)
    {
        // Get routes from service
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var service = new SsgRebuildService(db);

        var bookSlugs = job.BookSlugsJson != null ? JsonSerializer.Deserialize<string[]>(job.BookSlugsJson) : null;
        var authorSlugs = job.AuthorSlugsJson != null ? JsonSerializer.Deserialize<string[]>(job.AuthorSlugsJson) : null;
        var genreSlugs = job.GenreSlugsJson != null ? JsonSerializer.Deserialize<string[]>(job.GenreSlugsJson) : null;

        var routes = await service.GetRoutesAsync(job.SiteId, job.Mode, bookSlugs, authorSlugs, genreSlugs, ct);

        if (routes.Count == 0)
        {
            _logger.LogWarning("No routes to render for job {JobId}", job.Id);
            return;
        }

        // Write routes to temp file
        var routesFile = Path.Combine(Path.GetTempPath(), $"ssg-routes-{job.Id}.json");
        var outputFile = Path.Combine(Path.GetTempPath(), $"ssg-results-{job.Id}.json");

        var routesJson = JsonSerializer.Serialize(routes.Select(r => new { r.Route, r.RouteType }));
        await File.WriteAllTextAsync(routesFile, routesJson, ct);

        try
        {
            // Build process args
            var args = $"{ScriptPath} --routes-file {routesFile} --output {outputFile} --concurrency {job.Concurrency}";

            // Get site domain for API_HOST
            var apiHost = job.Site.PrimaryDomain ?? "general.localhost";

            _logger.LogInformation("Spawning prerender: node {Args}", args);

            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = args,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Environment.CurrentDirectory
            };

            psi.Environment["API_URL"] = Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080";
            psi.Environment["API_HOST"] = apiHost;
            psi.Environment["CONCURRENCY"] = job.Concurrency.ToString();

            using var process = new Process { StartInfo = psi };

            var outputLock = new object();
            var renderedCount = 0;
            var failedCount = 0;

            process.OutputDataReceived += (sender, e) =>
            {
                if (string.IsNullOrEmpty(e.Data)) return;

                // Try to parse progress event
                if (e.Data.StartsWith("{"))
                {
                    try
                    {
                        var evt = JsonSerializer.Deserialize<ProgressEvent>(e.Data);
                        if (evt?.Event == "progress")
                        {
                            lock (outputLock)
                            {
                                renderedCount = evt.Rendered;
                                failedCount = evt.Failed;
                            }

                            // Fire and forget progress update
                            _ = UpdateJobProgressAsync(job.Id, renderedCount, failedCount);
                        }
                        else if (evt?.Event == "result")
                        {
                            // Fire and forget result save
                            _ = SaveResultAsync(job.Id, evt);
                        }
                    }
                    catch
                    {
                        // Not a JSON event, just log
                        _logger.LogDebug("[prerender] {Line}", e.Data);
                    }
                }
                else
                {
                    _logger.LogDebug("[prerender] {Line}", e.Data);
                }
            };

            process.ErrorDataReceived += (sender, e) =>
            {
                if (!string.IsNullOrEmpty(e.Data))
                    _logger.LogWarning("[prerender stderr] {Line}", e.Data);
            };

            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            // Wait for process with cancellation
            while (!process.HasExited)
            {
                if (ct.IsCancellationRequested)
                {
                    process.Kill(entireProcessTree: true);
                    throw new OperationCanceledException();
                }

                await Task.Delay(100, CancellationToken.None);
            }

            if (process.ExitCode != 0)
            {
                throw new Exception($"Prerender script exited with code {process.ExitCode}");
            }

            // Parse final results if output file exists
            if (File.Exists(outputFile))
            {
                var resultsJson = await File.ReadAllTextAsync(outputFile, CancellationToken.None);
                var results = JsonSerializer.Deserialize<List<RenderResult>>(resultsJson);

                if (results != null)
                {
                    foreach (var result in results)
                    {
                        await SaveRenderResultAsync(job.Id, result);
                    }

                    // Final progress update
                    var finalRendered = results.Count(r => r.Success);
                    var finalFailed = results.Count(r => !r.Success);
                    await UpdateJobProgressAsync(job.Id, finalRendered, finalFailed);
                }
            }
        }
        finally
        {
            // Cleanup temp files
            if (File.Exists(routesFile)) File.Delete(routesFile);
            if (File.Exists(outputFile)) File.Delete(outputFile);
        }
    }

    private async Task UpdateJobProgressAsync(Guid jobId, int renderedCount, int failedCount)
    {
        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var job = await db.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (job != null)
            {
                job.RenderedCount = renderedCount;
                job.FailedCount = failedCount;
                await db.SaveChangesAsync(CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to update job progress");
        }
    }

    private async Task SaveResultAsync(Guid jobId, ProgressEvent evt)
    {
        if (string.IsNullOrEmpty(evt.Route)) return;

        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            db.SsgRebuildResults.Add(new SsgRebuildResult
            {
                Id = Guid.NewGuid(),
                JobId = jobId,
                Route = evt.Route,
                RouteType = evt.RouteType ?? "unknown",
                Success = evt.Success,
                RenderTimeMs = evt.RenderTimeMs,
                Error = evt.Error,
                RenderedAt = DateTimeOffset.UtcNow
            });
            await db.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to save result for route {Route}", evt.Route);
        }
    }

    private async Task SaveRenderResultAsync(Guid jobId, RenderResult result)
    {
        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);

            // Check if already exists
            var exists = await db.SsgRebuildResults.AnyAsync(
                r => r.JobId == jobId && r.Route == result.Route,
                CancellationToken.None);

            if (!exists)
            {
                db.SsgRebuildResults.Add(new SsgRebuildResult
                {
                    Id = Guid.NewGuid(),
                    JobId = jobId,
                    Route = result.Route,
                    RouteType = result.RouteType ?? "unknown",
                    Success = result.Success,
                    RenderTimeMs = result.RenderTimeMs,
                    Error = result.Error,
                    RenderedAt = DateTimeOffset.UtcNow
                });
                await db.SaveChangesAsync(CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to save render result for route {Route}", result.Route);
        }
    }

    private record ProgressEvent
    {
        public string Event { get; init; } = "";
        public int Rendered { get; init; }
        public int Failed { get; init; }
        public int Total { get; init; }
        public string? Route { get; init; }
        public string? RouteType { get; init; }
        public bool Success { get; init; }
        public int? RenderTimeMs { get; init; }
        public string? Error { get; init; }
    }

    private record RenderResult
    {
        public string Route { get; init; } = "";
        public string? RouteType { get; init; }
        public bool Success { get; init; }
        public int? RenderTimeMs { get; init; }
        public string? Error { get; init; }
    }
}
