using System.Diagnostics;
using System.Text.Json;
using Application.SsgRebuild;
using Domain.Entities;
using Domain.Enums;
using Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Worker.Services;

/// <summary>
/// Executes SSG rebuild jobs by spawning Node prerender process.
/// </summary>
public class SsgRebuildWorkerService
{
    private readonly IDbContextFactory<AppDbContext> _dbFactory;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<SsgRebuildWorkerService> _logger;
    private readonly bool _nodeAvailable;

    private const string ScriptPath = "apps/web/scripts/prerender.mjs";

    public SsgRebuildWorkerService(
        IDbContextFactory<AppDbContext> dbFactory,
        IServiceScopeFactory scopeFactory,
        ILogger<SsgRebuildWorkerService> logger)
    {
        _dbFactory = dbFactory;
        _scopeFactory = scopeFactory;
        _logger = logger;
        _nodeAvailable = CheckNodeAvailable();

        if (!_nodeAvailable)
            _logger.LogWarning("Node.js not found - SSG rebuild jobs will be skipped. Use 'make rebuild-ssg' manually.");
    }

    private static bool CheckNodeAvailable()
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = "--version",
                RedirectStandardOutput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            using var process = Process.Start(psi);
            process?.WaitForExit(1000);
            return process?.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Gets next running job to process.</summary>
    public async Task<SsgRebuildJob?> GetNextJobAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.SsgRebuildJobs
            .Where(j => j.Status == SsgRebuildJobStatus.Running)
            .OrderBy(j => j.StartedAt)
            .FirstOrDefaultAsync(ct);
    }

    /// <summary>Processes a job: spawns prerender, tracks progress, saves results.</summary>
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
            _logger.LogWarning("Job {JobId} is not Running (was {Status})", jobId, job.Status);
            return;
        }

        if (!_nodeAvailable)
        {
            await SetJobStatusAsync(jobId, SsgRebuildJobStatus.Failed, "Node.js not available in Worker container. Use 'make rebuild-ssg' manually.");
            _logger.LogWarning("Skipping SSG job {JobId} - Node.js not available", jobId);
            return;
        }

        _logger.LogInformation("Starting SSG rebuild job {JobId}, site {SiteCode}, mode {Mode}",
            jobId, job.Site.Code, job.Mode);

        try
        {
            await RunPrerenderAsync(job, ct);
            await SetJobStatusAsync(jobId, SsgRebuildJobStatus.Completed);
            _logger.LogInformation("SSG rebuild completed for job {JobId}", jobId);
        }
        catch (OperationCanceledException)
        {
            await SetJobStatusAsync(jobId, SsgRebuildJobStatus.Cancelled);
            _logger.LogInformation("SSG rebuild cancelled for job {JobId}", jobId);
        }
        catch (Exception ex)
        {
            await SetJobStatusAsync(jobId, SsgRebuildJobStatus.Failed, ex.Message);
            _logger.LogError(ex, "SSG rebuild failed for job {JobId}", jobId);
        }
    }

    #region Private Methods

    private async Task RunPrerenderAsync(SsgRebuildJob job, CancellationToken ct)
    {
        var routes = await GetJobRoutesAsync(job, ct);
        if (routes.Count == 0)
        {
            _logger.LogWarning("No routes for job {JobId}", job.Id);
            return;
        }

        var routesFile = Path.Combine(Path.GetTempPath(), $"ssg-routes-{job.Id}.json");
        var outputFile = Path.Combine(Path.GetTempPath(), $"ssg-results-{job.Id}.json");

        await WriteRoutesFileAsync(routes, routesFile, ct);

        try
        {
            await SpawnPrerenderProcessAsync(job, routesFile, outputFile, ct);
            await ProcessOutputFileAsync(job.Id, outputFile);
        }
        finally
        {
            CleanupTempFiles(routesFile, outputFile);
        }
    }

    private async Task<List<SsgRoute>> GetJobRoutesAsync(SsgRebuildJob job, CancellationToken ct)
    {
        var bookSlugs = DeserializeSlugs(job.BookSlugsJson);
        var authorSlugs = DeserializeSlugs(job.AuthorSlugsJson);
        var genreSlugs = DeserializeSlugs(job.GenreSlugsJson);

        using var scope = _scopeFactory.CreateScope();
        var routeProvider = scope.ServiceProvider.GetRequiredService<ISsgRouteProvider>();
        return await routeProvider.GetRoutesAsync(
            job.SiteId, job.Mode, bookSlugs, authorSlugs, genreSlugs, ct);
    }

    private static async Task WriteRoutesFileAsync(List<SsgRoute> routes, string path, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(routes.Select(r => new { r.Route, r.RouteType }));
        await File.WriteAllTextAsync(path, json, ct);
    }

    private async Task SpawnPrerenderProcessAsync(
        SsgRebuildJob job, string routesFile, string outputFile, CancellationToken ct)
    {
        var args = $"{ScriptPath} --routes-file {routesFile} --output {outputFile} --concurrency {job.Concurrency}";
        var apiHost = job.Site.PrimaryDomain ?? "general.localhost";

        _logger.LogInformation("Spawning: node {Args}", args);

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
        SetupProcessHandlers(process, job.Id);

        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        await WaitForProcessAsync(process, ct);

        if (process.ExitCode != 0)
            throw new Exception($"Prerender exited with code {process.ExitCode}");
    }

    private void SetupProcessHandlers(Process process, Guid jobId)
    {
        process.OutputDataReceived += (_, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;

            if (e.Data.StartsWith("{"))
            {
                try
                {
                    var evt = JsonSerializer.Deserialize<ProgressEvent>(e.Data);
                    if (evt?.Event == "progress")
                        _ = UpdateJobProgressAsync(jobId, evt.Rendered, evt.Failed);
                    else if (evt?.Event == "result")
                        _ = SaveResultAsync(jobId, evt);
                }
                catch
                {
                    _logger.LogDebug("[prerender] {Line}", e.Data);
                }
            }
            else
            {
                _logger.LogDebug("[prerender] {Line}", e.Data);
            }
        };

        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrEmpty(e.Data))
                _logger.LogWarning("[prerender stderr] {Line}", e.Data);
        };
    }

    private static async Task WaitForProcessAsync(Process process, CancellationToken ct)
    {
        while (!process.HasExited)
        {
            if (ct.IsCancellationRequested)
            {
                process.Kill(entireProcessTree: true);
                throw new OperationCanceledException();
            }
            await Task.Delay(100, CancellationToken.None);
        }
    }

    private async Task ProcessOutputFileAsync(Guid jobId, string outputFile)
    {
        if (!File.Exists(outputFile)) return;

        var json = await File.ReadAllTextAsync(outputFile, CancellationToken.None);
        var results = JsonSerializer.Deserialize<List<RenderResult>>(json);

        if (results == null) return;

        foreach (var result in results)
            await SaveRenderResultAsync(jobId, result);

        var rendered = results.Count(r => r.Success);
        var failed = results.Count(r => !r.Success);
        await UpdateJobProgressAsync(jobId, rendered, failed);
    }

    private static void CleanupTempFiles(params string[] files)
    {
        foreach (var file in files)
            if (File.Exists(file)) File.Delete(file);
    }

    private async Task SetJobStatusAsync(Guid jobId, SsgRebuildJobStatus status, string? error = null)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
        var job = await db.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
        if (job == null) return;

        job.Status = status;
        job.FinishedAt = DateTimeOffset.UtcNow;
        if (error != null) job.Error = error;

        await db.SaveChangesAsync(CancellationToken.None);
    }

    private async Task UpdateJobProgressAsync(Guid jobId, int rendered, int failed)
    {
        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);
            var job = await db.SsgRebuildJobs.FirstOrDefaultAsync(j => j.Id == jobId, CancellationToken.None);
            if (job == null) return;

            job.RenderedCount = rendered;
            job.FailedCount = failed;
            await db.SaveChangesAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to update progress");
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
            _logger.LogWarning(ex, "Failed to save result for {Route}", evt.Route);
        }
    }

    private async Task SaveRenderResultAsync(Guid jobId, RenderResult result)
    {
        try
        {
            await using var db = await _dbFactory.CreateDbContextAsync(CancellationToken.None);

            var exists = await db.SsgRebuildResults.AnyAsync(
                r => r.JobId == jobId && r.Route == result.Route, CancellationToken.None);

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
            _logger.LogWarning(ex, "Failed to save render result for {Route}", result.Route);
        }
    }

    private static string[]? DeserializeSlugs(string? json) =>
        json != null ? JsonSerializer.Deserialize<string[]>(json) : null;

    #endregion

    #region DTOs

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

    #endregion
}
