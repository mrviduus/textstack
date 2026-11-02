using Application.Transitional;
using Dapper;
using Domain.Transitional;

namespace Infrastructure.Persistence.Repositories;

/// <summary>
/// Transitional (dropped at M6.4, ADR-031). Dapper implementation of <see cref="IIngestionJobRepository"/>
/// on <c>textstack_v2</c>. A job can only name a file of the user's own book
/// (<c>fk_ingestion_jobs_book_files_user_id_book_id_file_id</c>) and goes with that file.
/// </summary>
public sealed class IngestionJobRepository(V2DataSource dataSource) : IIngestionJobRepository
{
    private const string Columns = "id, user_id, book_id, file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at";

    // started_at is stamped by the database, so "stuck" is measured on the database's clock too.
    private const string Stuck = "status = 'processing' AND started_at < now() - @stuckAfter";

    private const string Eligible = $"(status = 'queued' OR ({Stuck}))";

    private const string InsertJob = $"""
        INSERT INTO ingestion_jobs (id, user_id, book_id, file_id, status, attempt_count, created_at)
        VALUES (gen_random_uuid(), @userId, @bookId, @fileId, 'queued', 0, now())
        RETURNING {Columns}
        """;

    public async Task<FileIngestionJob> EnqueueAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<FileIngestionJob>(new CommandDefinition(InsertJob, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    private const string SelectLatestForFile = $"""
        SELECT {Columns} FROM ingestion_jobs
        WHERE user_id = @userId AND book_id = @bookId AND file_id = @fileId
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        """;

    public async Task<FileIngestionJob?> GetLatestForFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<FileIngestionJob>(new CommandDefinition(SelectLatestForFile, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    private const string CancelActive = """
        UPDATE ingestion_jobs SET status = 'failed', error = 'Cancelled by user', finished_at = now()
        WHERE user_id = @userId AND book_id = @bookId AND status IN ('queued', 'processing')
        """;

    public async Task<bool> CancelActiveAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(CancelActive, new { userId, bookId }, cancellationToken: ct)) > 0;
    }

    // SKIP LOCKED: a second claimer passes over a row the first is claiming instead of waiting for it.
    private const string ClaimNext = $"""
        UPDATE ingestion_jobs SET status = 'processing', started_at = now(), attempt_count = attempt_count + 1
        WHERE id = (
            SELECT id FROM ingestion_jobs
            WHERE attempt_count < @maxAttempts AND {Eligible}
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED)
        RETURNING {Columns}
        """;

    public async Task<FileIngestionJob?> ClaimNextAsync(int maxAttempts, TimeSpan stuckAfter, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<FileIngestionJob>(new CommandDefinition(ClaimNext, new { maxAttempts, stuckAfter }, cancellationToken: ct));
    }

    // The finish, like the give-back, touches only the row as this run claimed it: a job cancelled,
    // or reclaimed as stuck by another run, since then is no longer this run's to finish.
    private const string ClaimedByThisRun = "id = @jobId AND status = 'processing' AND attempt_count = @claimedAttempt";

    private const string Succeed = $"""
        UPDATE ingestion_jobs SET status = 'succeeded', error = NULL, source_format = @sourceFormat, finished_at = now()
        WHERE {ClaimedByThisRun}
        """;

    public async Task<bool> SucceedAsync(Guid jobId, int claimedAttempt, string? sourceFormat, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(Succeed, new { jobId, claimedAttempt, sourceFormat }, cancellationToken: ct)) > 0;
    }

    private const string Fail = $"""
        UPDATE ingestion_jobs SET status = 'failed', error = @error, source_format = COALESCE(@sourceFormat, source_format), finished_at = now()
        WHERE {ClaimedByThisRun}
        """;

    public async Task<bool> FailAsync(Guid jobId, int claimedAttempt, string error, string? sourceFormat, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(Fail, new { jobId, claimedAttempt, error, sourceFormat }, cancellationToken: ct)) > 0;
    }

    private const string ReturnToQueue = $"""
        UPDATE ingestion_jobs SET status = 'queued', attempt_count = @claimedAttempt - 1, started_at = NULL
        WHERE {ClaimedByThisRun}
        """;

    public async Task<bool> ReturnToQueueAsync(Guid jobId, int claimedAttempt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteAsync(new CommandDefinition(ReturnToQueue, new { jobId, claimedAttempt }, cancellationToken: ct)) > 0;
    }

    // Without this, a job that crashed its worker on every attempt stays "processing" forever:
    // the claim skips it.
    private const string FailExhausted = $"""
        UPDATE ingestion_jobs SET status = 'failed', error = @error, finished_at = now()
        WHERE attempt_count >= @maxAttempts AND {Eligible}
        RETURNING {Columns}
        """;

    public async Task<IReadOnlyList<FileIngestionJob>> FailExhaustedAsync(
        int maxAttempts, TimeSpan stuckAfter, string error, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return (await conn.QueryAsync<FileIngestionJob>(new CommandDefinition(FailExhausted, new { maxAttempts, stuckAfter, error }, cancellationToken: ct))).AsList();
    }

    private const string CountStuck = $"SELECT count(*) FROM ingestion_jobs WHERE {Stuck}";

    public async Task<int> CountStuckAsync(TimeSpan stuckAfter, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<int>(new CommandDefinition(CountStuck, new { stuckAfter }, cancellationToken: ct));
    }
}
