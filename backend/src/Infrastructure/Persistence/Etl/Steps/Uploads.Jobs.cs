using Domain.Enums;
using Domain.Transitional;

namespace Infrastructure.Persistence.Etl;

// user_ingestion_jobs → ingestion_jobs (transitional, ADR-031 row 36): keyed to the carried file, int status → text.
public static partial class EtlV2Uploads
{
    // source_format is legacy's SourceFormat enum name; V2 stores it lowercased, as V2IngestionService writes it.
    private const string SelectLegacyJobs = """
        SELECT id, user_book_id AS book_id, user_book_file_id AS file_id, status AS legacy_status, attempt_count, error,
               lower(source_format) AS source_format, created_at, started_at, finished_at
        FROM user_ingestion_jobs
        ORDER BY id
        """;

    private const string SelectV2Jobs = """
        SELECT id, user_id, book_id, file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at
        FROM ingestion_jobs
        """;

    private const string InsertJob = """
        INSERT INTO ingestion_jobs (id, user_id, book_id, file_id, status, attempt_count, error, source_format, created_at, started_at, finished_at)
        VALUES (@Id, @UserId, @BookId, @FileId, @Status, @AttemptCount, @Error, @SourceFormat, @CreatedAt, @StartedAt, @FinishedAt)
        """;

    // Legacy JobStatus (int) → V2's text.
    private static readonly Dictionary<int, string> JobStatuses = new()
    {
        [(int)JobStatus.Queued] = FileIngestionJob.Queued,
        [(int)JobStatus.Processing] = FileIngestionJob.Processing,
        [(int)JobStatus.Succeeded] = FileIngestionJob.Succeeded,
        [(int)JobStatus.Failed] = FileIngestionJob.Failed,
    };

    private static readonly string[] JobSourceFormats = ["epub", "pdf", "html", "fb2", "unknown"];

    private static async Task<List<JobRow>> MapJobsAsync(EtlV2Context context, Dictionary<Guid, FileRow> files, CancellationToken ct)
    {
        var (invalid, rows) = (new List<string>(), new List<JobRow>());
        foreach (var j in await EtlV2Rows.SourceAsync<JobRow>(context, SelectLegacyJobs, null, ct))
        {
            if (!files.TryGetValue(j.BookId, out var file) || file.Id != j.FileId)
            {
                context.OrphanCandidates.Add($"user_ingestion_jobs {j.Id}: not carried, its file {j.FileId} has no book_files row");
                continue;
            }
            if (!JobStatuses.ContainsKey(j.LegacyStatus) || (j.SourceFormat is not null && !JobSourceFormats.Contains(j.SourceFormat)))
            {
                invalid.Add(j.Id.ToString());
                continue;
            }
            rows.Add(j with { UserId = file.UserId, Status = JobStatuses[j.LegacyStatus], LegacyStatus = 0 });
        }
        EtlV2Rows.Check(context, "ingestion_jobs: status or source format V2 does not take", invalid);
        return rows;
    }

    private sealed record JobRow
    {
        public Guid Id { get; init; }
        public Guid UserId { get; init; }
        public Guid BookId { get; init; }
        public Guid FileId { get; init; }
        public int LegacyStatus { get; init; }
        public string Status { get; init; } = "";
        public int AttemptCount { get; init; }
        public string? Error { get; init; }
        public string? SourceFormat { get; init; }
        public DateTimeOffset CreatedAt { get; init; }
        public DateTimeOffset? StartedAt { get; init; }
        public DateTimeOffset? FinishedAt { get; init; }
    }
}
