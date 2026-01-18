using Application.Admin;
using Application.Common.Interfaces;
using Application.Reprocessing;
using Application.TextStack;
using Contracts.Admin;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Api.Endpoints;

public static class AdminEndpoints
{
    private static IResult ToResult((bool Success, string? Error) r)
        => r.Success ? Results.Ok() : Results.BadRequest(new { error = r.Error });

    private static IResult ToResult<T>((bool Success, string? Error, T? Data) r)
        => r.Success ? Results.Ok(r.Data) : Results.BadRequest(new { error = r.Error });
    public static void MapAdminEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/admin").WithTags("Admin");

        // Book upload
        group.MapPost("/books/upload", UploadBook)
            .DisableAntiforgery()
            .WithName("UploadBook")
            .WithDescription("Upload a book file (EPUB, PDF, FB2)");

        // Ingestion jobs
        group.MapGet("/ingestion/jobs", GetIngestionJobs)
            .WithName("GetIngestionJobs")
            .WithDescription("List ingestion jobs with optional filtering");

        group.MapGet("/ingestion/jobs/{id:guid}", GetIngestionJob)
            .WithName("GetIngestionJob")
            .WithDescription("Get ingestion job details including diagnostics");

        group.MapGet("/ingestion/jobs/{id:guid}/preview", GetIngestionJobPreview)
            .WithName("GetIngestionJobPreview")
            .WithDescription("Preview extracted content from a job");

        group.MapPost("/ingestion/jobs/{id:guid}/retry", RetryIngestionJob)
            .WithName("RetryIngestionJob")
            .WithDescription("Retry a failed ingestion job (idempotent)");

        // TextStack import
        group.MapPost("/import/textstack", ImportTextStack)
            .WithName("ImportTextStack")
            .WithDescription("Bulk import from TextStack folder");

        group.MapPost("/reimport/textstack", ReimportTextStack)
            .WithName("ReimportTextStack")
            .WithDescription("Reimport existing books from TextStack folder (keeps SEO metadata)");

        // Stats
        group.MapGet("/stats", GetStats)
            .WithName("GetStats")
            .WithDescription("Get admin dashboard statistics");

        // Editions CRUD
        group.MapGet("/editions", GetEditions)
            .WithName("GetEditions");

        group.MapGet("/editions/{id:guid}", GetEdition)
            .WithName("GetEdition");

        group.MapPut("/editions/{id:guid}", UpdateEdition)
            .WithName("UpdateEdition");

        group.MapDelete("/editions/{id:guid}", DeleteEdition)
            .WithName("DeleteEdition");

        group.MapPost("/editions/{id:guid}/publish", PublishEdition)
            .WithName("PublishEdition");

        group.MapPost("/editions/{id:guid}/unpublish", UnpublishEdition)
            .WithName("UnpublishEdition");

        group.MapPost("/editions/{id:guid}/cover", UploadEditionCover)
            .WithName("UploadEditionCover")
            .WithDescription("Upload edition cover (max 5MB, JPG/PNG/WebP)")
            .DisableAntiforgery();

        group.MapDelete("/editions/{id:guid}/cover", DeleteEditionCover)
            .WithName("DeleteEditionCover")
            .WithDescription("Delete edition cover");

        // Chapter management
        group.MapGet("/chapters/{id:guid}", GetChapter)
            .WithName("AdminGetChapter");

        group.MapPut("/chapters/{id:guid}", UpdateChapter)
            .WithName("AdminUpdateChapter");

        group.MapDelete("/chapters/{id:guid}", DeleteChapter)
            .WithName("AdminDeleteChapter");

        // Reprocessing endpoints
        group.MapGet("/reprocess/stats", GetReprocessingStats)
            .WithName("GetReprocessingStats")
            .WithDescription("Get statistics about what will be reprocessed");

        group.MapPost("/reprocess/{editionId:guid}", ReprocessEdition)
            .WithName("ReprocessEdition")
            .WithDescription("Reprocess a single edition with chapter splitting");

        group.MapPost("/reprocess/all", ReprocessAllEditions)
            .WithName("ReprocessAllEditions")
            .WithDescription("Reprocess all published editions with chapter splitting");

        group.MapPost("/reprocess/split-existing", SplitExistingChapters)
            .WithName("SplitExistingChapters")
            .WithDescription("Split long chapters directly in DB (no source file needed)");
    }

    private static async Task<IResult> UploadBook(
        IFormFile file,
        [FromForm] Guid siteId,
        [FromForm] string title,
        [FromForm] string language,
        [FromForm] string? description,
        [FromForm] Guid? workId,
        [FromForm] Guid? sourceEditionId,
        [FromForm] string? authorIds,
        [FromForm] Guid? genreId,
        AdminService adminService,
        CancellationToken ct)
    {
        // Validate required fields for SEO
        if (string.IsNullOrWhiteSpace(authorIds))
            return Results.BadRequest(new { error = "At least one author is required" });

        if (!genreId.HasValue)
            return Results.BadRequest(new { error = "Genre is required" });

        var (valid, error) = await adminService.ValidateUploadAsync(siteId, file.FileName, file.Length, ct);
        if (!valid)
            return Results.BadRequest(new { error });

        var (workValid, workError, work) = await adminService.GetOrCreateWorkAsync(siteId, title, workId, ct);
        if (!workValid)
            return Results.BadRequest(new { error = workError });

        // Parse comma-separated author IDs
        List<Guid>? parsedAuthorIds = null;
        if (!string.IsNullOrWhiteSpace(authorIds))
        {
            parsedAuthorIds = authorIds
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(id => Guid.TryParse(id, out var guid) ? guid : (Guid?)null)
                .Where(g => g.HasValue)
                .Select(g => g!.Value)
                .ToList();
        }

        if (parsedAuthorIds is null || parsedAuthorIds.Count == 0)
            return Results.BadRequest(new { error = "At least one valid author ID is required" });

        await using var stream = file.OpenReadStream();
        var request = new UploadBookRequest(
            siteId, title, language, description, workId, sourceEditionId,
            file.FileName, file.Length, stream, parsedAuthorIds, genreId
        );

        var result = await adminService.UploadBookAsync(request, work!, ct);

        return Results.Created($"/admin/ingestion/jobs/{result.JobId}", new
        {
            workId = result.WorkId,
            editionId = result.EditionId,
            bookFileId = result.BookFileId,
            jobId = result.JobId,
            status = "Queued"
        });
    }

    private static async Task<IResult> GetIngestionJobs(
        AdminService adminService,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        [FromQuery] string? search,
        CancellationToken ct)
    {
        JobStatus? statusEnum = null;
        if (!string.IsNullOrEmpty(status) && Enum.TryParse<JobStatus>(status, true, out var parsed))
            statusEnum = parsed;

        var query = new IngestionJobsQuery(offset ?? 0, limit ?? 20, statusEnum, search);
        var jobs = await adminService.GetIngestionJobsAsync(query, ct);
        return Results.Ok(jobs);
    }

    private static async Task<IResult> GetIngestionJob(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
    {
        var job = await adminService.GetIngestionJobAsync(id, ct);
        return job is null ? Results.NotFound() : Results.Ok(job);
    }

    private static async Task<IResult> GetIngestionJobPreview(
        Guid id,
        AdminService adminService,
        [FromQuery] int? unit,
        [FromQuery] int? chars,
        CancellationToken ct)
    {
        var preview = await adminService.GetChapterPreviewAsync(id, unit ?? 0, chars ?? 2000, ct);
        return preview is null ? Results.NotFound() : Results.Ok(preview);
    }

    private static async Task<IResult> RetryIngestionJob(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.RetryJobAsync(id, ct));

    // Stats endpoint

    private static async Task<IResult> GetStats(
        AdminService adminService,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        var stats = await adminService.GetStatsAsync(siteId, ct);
        return Results.Ok(stats);
    }

    // Edition endpoints

    private static async Task<IResult> GetEditions(
        AdminService adminService,
        [FromQuery] Guid? siteId,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        [FromQuery] string? search,
        [FromQuery] string? language,
        [FromQuery] bool? indexable,
        CancellationToken ct)
    {
        EditionStatus? statusEnum = null;
        if (!string.IsNullOrEmpty(status) && Enum.TryParse<EditionStatus>(status, true, out var parsed))
            statusEnum = parsed;

        var result = await adminService.GetEditionsAsync(siteId, offset ?? 0, limit ?? 20, statusEnum, search, language, indexable, ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> GetEdition(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
    {
        var edition = await adminService.GetEditionDetailAsync(id, ct);
        return edition is null ? Results.NotFound() : Results.Ok(edition);
    }

    private static async Task<IResult> UpdateEdition(
        Guid id,
        UpdateEditionRequest request,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.UpdateEditionAsync(id, request, ct));

    private static async Task<IResult> DeleteEdition(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.DeleteEditionAsync(id, ct));

    private static async Task<IResult> PublishEdition(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.PublishEditionAsync(id, ct));

    private static async Task<IResult> UnpublishEdition(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.UnpublishEditionAsync(id, ct));

    // Chapter endpoints

    private static async Task<IResult> GetChapter(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
    {
        var chapter = await adminService.GetChapterDetailAsync(id, ct);
        return chapter is null ? Results.NotFound() : Results.Ok(chapter);
    }

    private static async Task<IResult> UpdateChapter(
        Guid id,
        UpdateChapterRequest request,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.UpdateChapterAsync(id, request, ct));

    private static async Task<IResult> DeleteChapter(
        Guid id,
        AdminService adminService,
        CancellationToken ct)
        => ToResult(await adminService.DeleteChapterAsync(id, ct));

    // Reprocessing handlers

    private static async Task<IResult> GetReprocessingStats(
        ReprocessingService reprocessingService,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        var stats = await reprocessingService.GetReprocessingStatsAsync(siteId, ct);
        return Results.Ok(stats);
    }

    private static async Task<IResult> ReprocessEdition(
        Guid editionId,
        ReprocessingService reprocessingService,
        CancellationToken ct)
    {
        var result = await reprocessingService.ReprocessEditionAsync(editionId, ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> ReprocessAllEditions(
        ReprocessingService reprocessingService,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        var result = await reprocessingService.ReprocessAllEditionsAsync(siteId, ct);
        return Results.Ok(result);
    }

    private static async Task<IResult> SplitExistingChapters(
        ReprocessingService reprocessingService,
        [FromQuery] Guid? siteId,
        CancellationToken ct)
    {
        var result = await reprocessingService.SplitExistingChaptersAsync(siteId, ct);
        return Results.Ok(result);
    }

    private static readonly string[] AllowedCoverExtensions = [".jpg", ".jpeg", ".png", ".webp"];
    private const long MaxCoverSize = 5 * 1024 * 1024; // 5MB

    private static async Task<IResult> UploadEditionCover(
        Guid id,
        IFormFile file,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var edition = await db.Editions.FindAsync([id], ct);
        if (edition is null)
            return Results.NotFound(new { error = "Edition not found" });

        if (file.Length == 0)
            return Results.BadRequest(new { error = "File is empty" });

        if (file.Length > MaxCoverSize)
            return Results.BadRequest(new { error = "File too large. Max 5MB allowed" });

        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        if (!AllowedCoverExtensions.Contains(ext))
            return Results.BadRequest(new { error = "Invalid file type. Only JPG, PNG, and WebP allowed" });

        // Delete old cover if exists
        if (!string.IsNullOrEmpty(edition.CoverPath))
        {
            await storage.DeleteFileAsync(edition.CoverPath, ct);
        }

        // Save new cover with timestamp for cache busting
        await using var stream = file.OpenReadStream();
        var fileName = $"cover-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}{ext}";
        var relativePath = await storage.SaveFileAsync(id, fileName, stream, ct);

        edition.CoverPath = relativePath;
        edition.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { coverPath = relativePath });
    }

    private static async Task<IResult> DeleteEditionCover(
        Guid id,
        IAppDbContext db,
        IFileStorageService storage,
        CancellationToken ct)
    {
        var edition = await db.Editions.FindAsync([id], ct);
        if (edition is null)
            return Results.NotFound(new { error = "Edition not found" });

        if (string.IsNullOrEmpty(edition.CoverPath))
            return Results.Ok(new { message = "No cover to delete" });

        await storage.DeleteFileAsync(edition.CoverPath, ct);
        edition.CoverPath = null;
        edition.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { message = "Cover deleted" });
    }

    private static async Task<IResult> ImportTextStack(
        [FromBody] ImportTextStackRequest request,
        IServiceScopeFactory scopeFactory,
        CancellationToken ct)
    {
        var path = request.Path ?? "/data/textstack";
        if (!Directory.Exists(path))
            return Results.BadRequest(new { error = $"Directory not found: {path}" });

        var results = new List<object>();
        var imported = 0;
        var skipped = 0;

        foreach (var bookDir in Directory.GetDirectories(path))
        {
            var opfPath = Path.Combine(bookDir, "src/epub/content.opf");
            if (!File.Exists(opfPath))
                continue;

            // Create new scope for each book to get fresh DbContext
            using var scope = scopeFactory.CreateScope();
            var importService = scope.ServiceProvider.GetRequiredService<TextStackImportService>();

            var result = await importService.ImportBookAsync(request.SiteId, bookDir, ct);

            if (result.WasSkipped)
                skipped++;
            else if (result.Error == null)
                imported++;

            results.Add(new
            {
                book = Path.GetFileName(bookDir),
                editionId = result.EditionId,
                chapters = result.ChapterCount,
                images = result.ImageCount,
                wasSkipped = result.WasSkipped,
                error = result.Error
            });
        }

        return Results.Ok(new { imported, skipped, total = results.Count, results });
    }

    private static async Task<IResult> ReimportTextStack(
        [FromBody] ReimportTextStackRequest request,
        IServiceScopeFactory scopeFactory,
        CancellationToken ct)
    {
        var path = request.Path ?? "/data/textstack";
        if (!Directory.Exists(path))
            return Results.BadRequest(new { error = $"Directory not found: {path}" });

        var results = new List<object>();
        var reimported = 0;
        var skipped = 0;
        var failed = 0;

        foreach (var bookDir in Directory.GetDirectories(path))
        {
            var opfPath = Path.Combine(bookDir, "src/epub/content.opf");
            if (!File.Exists(opfPath))
                continue;

            using var scope = scopeFactory.CreateScope();
            var importService = scope.ServiceProvider.GetRequiredService<TextStackImportService>();

            var result = await importService.ReimportBookAsync(request.SiteId, bookDir, ct);

            if (result.WasSkipped)
                skipped++;
            else if (result.Error == null)
                reimported++;
            else
                failed++;

            results.Add(new
            {
                book = Path.GetFileName(bookDir),
                editionId = result.EditionId,
                chapters = result.ChapterCount,
                images = result.ImageCount,
                wasSkipped = result.WasSkipped,
                error = result.Error
            });
        }

        return Results.Ok(new { reimported, skipped, failed, total = results.Count, results });
    }
}

public record ImportTextStackRequest(Guid SiteId, string? Path = null);
public record ReimportTextStackRequest(Guid SiteId, string? Path = null);
