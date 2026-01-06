using Application.Admin;
using Application.Common.Interfaces;
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

        // Chapter management
        group.MapGet("/chapters/{id:guid}", GetChapter)
            .WithName("AdminGetChapter");

        group.MapPut("/chapters/{id:guid}", UpdateChapter)
            .WithName("AdminUpdateChapter");

        group.MapDelete("/chapters/{id:guid}", DeleteChapter)
            .WithName("AdminDeleteChapter");
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

    // Edition endpoints

    private static async Task<IResult> GetEditions(
        AdminService adminService,
        [FromQuery] Guid? siteId,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        [FromQuery] string? status,
        [FromQuery] string? search,
        CancellationToken ct)
    {
        EditionStatus? statusEnum = null;
        if (!string.IsNullOrEmpty(status) && Enum.TryParse<EditionStatus>(status, true, out var parsed))
            statusEnum = parsed;

        var result = await adminService.GetEditionsAsync(siteId, offset ?? 0, limit ?? 20, statusEnum, search, ct);
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

        // Save new cover
        await using var stream = file.OpenReadStream();
        var fileName = $"cover{ext}";
        var relativePath = await storage.SaveFileAsync(id, fileName, stream, ct);

        edition.CoverPath = relativePath;
        edition.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { coverPath = relativePath });
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
                path = Path.GetFileName(bookDir),
                editionId = result.EditionId,
                chapterCount = result.ChapterCount,
                skipped = result.WasSkipped,
                error = result.Error
            });
        }

        return Results.Ok(new { imported, skipped, total = results.Count, results });
    }
}

public record ImportTextStackRequest(Guid SiteId, string? Path = null);
