using System.Security.Cryptography;
using System.Text.Json;
using Application.Common.Interfaces;
using Application.SsgRebuild;
using Contracts.Admin;
using Contracts.Common;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;
using Application.UserBooks;

namespace Application.Admin;

public record UploadBookRequest(
    Guid SiteId,
    string Title,
    string Language,
    string? Description,
    Guid? WorkId,
    Guid? SourceEditionId,
    string FileName,
    long FileSize,
    Stream FileStream,
    List<Guid>? AuthorIds = null,
    Guid? GenreId = null
);

public record UploadBookResult(Guid WorkId, Guid EditionId, Guid BookFileId, Guid JobId);

public record IngestionJobDto(
    Guid Id,
    Guid EditionId,
    string EditionTitle,
    string FileName,
    string Status,
    string? SourceFormat,
    int? UnitsCount,
    string? TextSource,
    string? ErrorMessage,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt
);

public record IngestionJobDetailDto(
    Guid Id,
    Guid EditionId,
    Guid BookFileId,
    string FileName,
    string TargetLanguage,
    JobStatus Status,
    int AttemptCount,
    string? Error,
    DateTimeOffset CreatedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt,
    IngestionEditionDto Edition,
    IngestionDiagnosticsDto? Diagnostics
);

public record IngestionEditionDto(string Title, string Language, string Slug);

public record IngestionDiagnosticsDto(
    string? SourceFormat,
    int? UnitsCount,
    string? TextSource,
    double? Confidence,
    List<IngestionWarningDto>? Warnings
);

public record IngestionWarningDto(int Code, string Message);

public record UserUploadsQuery(
    int Offset = 0,
    int Limit = 20,
    UserBookStatus? Status = null,
    string? UserType = null,
    string? Search = null);

public record IngestionJobsQuery(
    int Offset = 0,
    int Limit = 20,
    JobStatus? Status = null,
    string? Search = null
);

public record ChapterPreviewDto(int ChapterNumber, string Title, string Preview, int TotalLength);

/// <summary>
/// Admin service. Handlers are split across partial files by sub-domain
/// to keep each file under ~350 LOC and reviewable in isolation:
///
///   - AdminService.Upload.cs       ValidateUpload, GetOrCreateWork, UploadBook, ingestion jobs, RetryJob
///   - AdminService.Editions.cs     GetStats, GetEditions, GetEditionDetail, Update/Delete/Publish/UnpublishEdition, IndexChapters
///   - AdminService.Chapters.cs     GetChapterDetail, UpdateChapter, DeleteChapter (+ StripHtml/CountWords helpers)
///   - AdminService.UserUploads.cs  GetUserUploads, GetUserUploadStats, DeleteUserUpload, TakedownUserUpload
///
/// This file keeps the primary constructor (DI injection), file-level
/// constants, the shared EnqueueSsgSafe helper, and the file-scope DTOs
/// above. Splits use C# `partial` — compile-identical to the original
/// monolithic file.
/// </summary>
public partial class AdminService(IAppDbContext db, IFileStorageService storage, SsgRebuildService ssgRebuildService, UserBookService userBookService)
{
    private static readonly string[] AllowedExtensions = [".epub", ".pdf"];
    private const long MaxFileSize = 100 * 1024 * 1024;

    private async Task EnqueueSsgSafe(Guid siteId, string[]? bookSlugs = null, string[]? authorSlugs = null, string[]? genreSlugs = null)
    {
        try
        {
            var isSpecific = bookSlugs != null || authorSlugs != null || genreSlugs != null;
            await ssgRebuildService.EnqueueSsgRebuildAsync(new CreateSsgRebuildJobRequest(
                SiteId: siteId,
                Mode: isSpecific ? "Specific" : "Full",
                Concurrency: 2,
                BookSlugs: bookSlugs,
                AuthorSlugs: authorSlugs,
                GenreSlugs: genreSlugs
            ), CancellationToken.None);
        }
        catch
        {
            // SSG failure should never block admin operations
        }
    }
}
