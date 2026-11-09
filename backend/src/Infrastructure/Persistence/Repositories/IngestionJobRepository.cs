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

    // Every status write moves its book's feed watermark (books.updated_at; revision, the edit
    // counter, untouched) in the same statement: the library feed carries the latest job's status
    // (#1118), so a cursor pull must see the book again. Follows a CTE j holding the written jobs.
    private const string TouchBooks = """
        , touched AS (
            UPDATE books b SET updated_at = now()
            FROM j WHERE b.user_id = j.user_id AND b.id = j.book_id)

        """;

    /// <summary>
    /// "The file's latest job": the one rule the feed's <c>ingestion</c> and <see cref="GetLatestForFileAsync"/>
    /// share. Follows <c>FROM ingestion_jobs j WHERE …</c> naming one file.
    /// </summary>
    internal const string LatestFirst = "ORDER BY j.created_at DESC, j.id DESC LIMIT 1";

    private const string InsertJob = $"""
        WITH j AS (
            INSERT INTO ingestion_jobs (id, user_id, book_id, file_id, status, attempt_count, created_at)
            VALUES (gen_random_uuid(), @userId, @bookId, @fileId, 'queued', 0, now())
            RETURNING {Columns})
        {TouchBooks}SELECT {Columns} FROM j
        """;

    public async Task<FileIngestionJob> EnqueueAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleAsync<FileIngestionJob>(new CommandDefinition(InsertJob, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    private const string SelectLatestForFile = $"""
        SELECT {Columns} FROM ingestion_jobs j
        WHERE (j.user_id, j.book_id, j.file_id) = (@userId, @bookId, @fileId)
        {LatestFirst}
        """;

    public async Task<FileIngestionJob?> GetLatestForFileAsync(Guid userId, Guid bookId, Guid fileId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.QuerySingleOrDefaultAsync<FileIngestionJob>(new CommandDefinition(SelectLatestForFile, new { userId, bookId, fileId }, cancellationToken: ct));
    }

    private const string CancelActive = $"""
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'failed', error = 'Cancelled by user', finished_at = now()
            WHERE user_id = @userId AND book_id = @bookId AND status IN ('queued', 'processing')
            RETURNING user_id, book_id)
        {TouchBooks}SELECT count(*) FROM j
        """;

    public async Task<bool> CancelActiveAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(CancelActive, new { userId, bookId }, cancellationToken: ct)) > 0;
    }

    // SKIP LOCKED: a second claimer passes over a row the first is claiming instead of waiting for it.
    private const string ClaimNext = $"""
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'processing', started_at = now(), attempt_count = attempt_count + 1
            WHERE id = (
                SELECT id FROM ingestion_jobs
                WHERE attempt_count < @maxAttempts AND {Eligible}
                ORDER BY created_at, id
                LIMIT 1
                FOR UPDATE SKIP LOCKED)
            RETURNING {Columns})
        {TouchBooks}SELECT {Columns} FROM j
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
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'succeeded', error = NULL, source_format = @sourceFormat, finished_at = now()
            WHERE {ClaimedByThisRun}
            RETURNING user_id, book_id)
        {TouchBooks}SELECT count(*) FROM j
        """;

    public async Task<bool> SucceedAsync(Guid jobId, int claimedAttempt, string? sourceFormat, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(Succeed, new { jobId, claimedAttempt, sourceFormat }, cancellationToken: ct)) > 0;
    }

    private const string Fail = $"""
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'failed', error = @error, source_format = COALESCE(@sourceFormat, source_format), finished_at = now()
            WHERE {ClaimedByThisRun}
            RETURNING user_id, book_id)
        {TouchBooks}SELECT count(*) FROM j
        """;

    public async Task<bool> FailAsync(Guid jobId, int claimedAttempt, string error, string? sourceFormat, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(Fail, new { jobId, claimedAttempt, error, sourceFormat }, cancellationToken: ct)) > 0;
    }

    private const string ReturnToQueue = $"""
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'queued', attempt_count = @claimedAttempt - 1, started_at = NULL
            WHERE {ClaimedByThisRun}
            RETURNING user_id, book_id)
        {TouchBooks}SELECT count(*) FROM j
        """;

    public async Task<bool> ReturnToQueueAsync(Guid jobId, int claimedAttempt, CancellationToken ct)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        return await conn.ExecuteScalarAsync<long>(new CommandDefinition(ReturnToQueue, new { jobId, claimedAttempt }, cancellationToken: ct)) > 0;
    }

    // Without this, a job that crashed its worker on every attempt stays "processing" forever:
    // the claim skips it.
    private const string FailExhausted = $"""
        WITH j AS (
            UPDATE ingestion_jobs SET status = 'failed', error = @error, finished_at = now()
            WHERE attempt_count >= @maxAttempts AND {Eligible}
            RETURNING {Columns})
        {TouchBooks}SELECT {Columns} FROM j
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
