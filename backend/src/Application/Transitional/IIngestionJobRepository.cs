using Domain.Transitional;

namespace Application.Transitional;

/// <summary>
/// Transitional. Dropped at M6.4 once the V2 reader serves EPUB and PDF on all clients; see ADR-031.
/// <para>The server extraction queue for uploaded files (table <c>ingestion_jobs</c>). The reader's
/// methods take <c>userId</c> (docs/01-architecture/data-access.md rule 7); the worker's
/// (claim, finish, give back, sweep, count) are cross-user and say so by taking none. A job is
/// eligible while under <c>maxAttempts</c> and queued, or processing but stuck (started before
/// <c>stuckBefore</c>: its worker died).</para>
/// </summary>
public interface IIngestionJobRepository
{
    /// <summary>Queues a job for one file version of the user's book; returns it as stored.</summary>
    Task<FileIngestionJob> EnqueueAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct);

    /// <summary>Fails the user's active (queued or processing) job of the book as cancelled. False when there is none.</summary>
    Task<bool> CancelActiveAsync(Guid userId, Guid bookId, CancellationToken ct);

    /// <summary>
    /// Claims the oldest eligible job for this worker: it becomes processing, started now, one attempt
    /// more. Concurrent claimers skip each other's row, so a job goes to exactly one. Null when none.
    /// </summary>
    Task<FileIngestionJob?> ClaimNextAsync(int maxAttempts, DateTimeOffset stuckBefore, CancellationToken ct);

    /// <summary>Marks the job succeeded, with what the extractor detected. False when there is no such job.</summary>
    Task<bool> SucceedAsync(Guid jobId, string? sourceFormat, CancellationToken ct);

    /// <summary>Marks the job failed with <paramref name="error"/>, and what the extractor detected if it got that far. False when there is no such job.</summary>
    Task<bool> FailAsync(Guid jobId, string error, string? sourceFormat, CancellationToken ct);

    /// <summary>
    /// Gives a job back to the queue after a shutdown interrupted it (ADR-022), uncounting the attempt;
    /// only the run that claimed it as <paramref name="claimedAttempt"/> can. False when it moved on.
    /// </summary>
    Task<bool> ReturnToQueueAsync(Guid jobId, int claimedAttempt, CancellationToken ct);

    /// <summary>
    /// Fails, with <paramref name="error"/>, every job that would be eligible but has used its
    /// <paramref name="maxAttempts"/> (it crashed its worker every time). Returns them, for the books' sake.
    /// </summary>
    Task<IReadOnlyList<FileIngestionJob>> FailExhaustedAsync(
        int maxAttempts, DateTimeOffset stuckBefore, string error, CancellationToken ct);

    /// <summary>How many jobs are still processing although started before <paramref name="startedBefore"/>: the stuck-jobs metric.</summary>
    Task<int> CountStuckAsync(DateTimeOffset startedBefore, CancellationToken ct);
}
