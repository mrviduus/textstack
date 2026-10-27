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

    /// <summary>
    /// Queues a Full rebuild (ssg-worker claims it); null when a Full job is already Queued or Running.
    /// `make rebuild-ssg` (→ /internal/ssg/rebuild-all) uses it; there is no nightly trigger since #992.
    /// </summary>
    Task<SsgRebuildJob?> EnqueueFullRebuildAsync(Guid siteId, CancellationToken ct);

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
        CancellationToken ct);
}
