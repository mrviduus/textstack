using Contracts.Admin;
using Domain.Entities;

namespace Application.SsgRebuild;

/// <summary>
/// Manages SSG rebuild jobs lifecycle.
/// </summary>
public interface ISsgJobService
{
    /// <summary>Creates a new queued job.</summary>
    Task<SsgRebuildJob> CreateJobAsync(CreateSsgRebuildJobRequest request, CancellationToken ct);

    /// <summary>Creates a Queued job (ssg-worker claims it), skipping if an identical one is already Queued.</summary>
    Task<SsgRebuildJob?> EnqueueSsgRebuildAsync(CreateSsgRebuildJobRequest request, CancellationToken ct);

    /// <summary>
    /// <see cref="EnqueueSsgRebuildAsync"/> for callers whose edit is already committed: never throws,
    /// logs the failure instead. Await it — never fire-and-forget (ADR-023).
    /// </summary>
    Task TryEnqueueSsgRebuildAsync(CreateSsgRebuildJobRequest request);

    /// <summary>Gets job details by ID.</summary>
    Task<SsgRebuildJobDetailDto?> GetJobAsync(Guid id, CancellationToken ct);

    /// <summary>Lists jobs with optional filtering.</summary>
    Task<(int Total, List<SsgRebuildJobListDto> Items)> GetJobsAsync(
        Guid? siteId, string? status, int offset, int limit, CancellationToken ct);

    /// <summary>Cancels a running or queued job.</summary>
    Task<bool> CancelJobAsync(Guid id, CancellationToken ct);

    /// <summary>Gets preview of routes to render.</summary>
    Task<SsgRebuildPreviewDto> GetPreviewAsync(
        Guid siteId,
        string modeStr,
        string[]? bookSlugs,
        string[]? authorSlugs,
        string[]? genreSlugs,
        CancellationToken ct);

    /// <summary>Gets job statistics.</summary>
    Task<SsgRebuildJobStatsDto?> GetJobStatsAsync(Guid jobId, CancellationToken ct);

    /// <summary>Gets paginated render results for a job.</summary>
    Task<(int Total, List<SsgRebuildResultDto> Items)> GetResultsAsync(
        Guid jobId, SsgRebuildResultsFilter filter, CancellationToken ct);
}
