using Domain.Transitional;

namespace Application.Transitional;

/// <summary>Transitional's public port for the other features (ADR-034 rule 4): queue a file version's server extraction.</summary>
public interface IExtractionQueue
{
    /// <inheritdoc cref="IIngestionJobRepository.EnqueueAsync"/>
    Task<FileIngestionJob> EnqueueAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <inheritdoc cref="IIngestionJobRepository.GetLatestForFileAsync"/>
    Task<FileIngestionJob?> GetLatestForFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);
}

/// <summary><see cref="IExtractionQueue"/> over the ingestion-job repository; it delegates, it adds no SQL.</summary>
public sealed class ExtractionQueue(IIngestionJobRepository jobs) : IExtractionQueue
{
    public Task<FileIngestionJob> EnqueueAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct) =>
        jobs.EnqueueAsync(userId, bookId, fileId, ct);

    public Task<FileIngestionJob?> GetLatestForFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct) =>
        jobs.GetLatestForFileAsync(userId, bookId, fileId, ct);
}
