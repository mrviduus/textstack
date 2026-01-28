using System.Security.Cryptography;
using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.UserBooks;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class UserBookService(IAppDbContext db, IFileStorageService storage)
{
    public async Task<(UploadUserBookResponse? Response, string? Error)> UploadAsync(
        Guid userId, Stream fileStream, string fileName, string? title, string? language, CancellationToken ct)
    {
        // Get user and check quota
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null)
            return (null, "User not found");

        // Get file size (need to read to memory for size check and hashing)
        using var ms = new MemoryStream();
        await fileStream.CopyToAsync(ms, ct);
        var fileSize = ms.Length;

        if (user.StorageUsedBytes + fileSize > User.StorageLimitBytes)
            return (null, $"Storage limit exceeded. Used: {user.StorageUsedBytes}, Limit: {User.StorageLimitBytes}");

        // Detect format
        var format = DetectFormat(fileName);
        if (format == BookFormat.Other)
            return (null, "Unsupported file format. Only EPUB, PDF, and FB2 are supported.");

        // Calculate SHA256
        ms.Position = 0;
        var sha256 = await ComputeSha256Async(ms, ct);

        // Create UserBook
        var userBookId = Guid.NewGuid();
        var slug = SlugGenerator.GenerateSlug(title ?? Path.GetFileNameWithoutExtension(fileName));

        // Ensure unique slug for user
        var existingSlug = await db.UserBooks
            .Where(b => b.UserId == userId && b.Slug == slug)
            .Select(b => b.Slug)
            .FirstOrDefaultAsync(ct);
        if (existingSlug is not null)
            slug = $"{slug}-{DateTime.UtcNow:yyyyMMddHHmmss}";

        var userBook = new UserBook
        {
            Id = userBookId,
            UserId = userId,
            Title = title ?? Path.GetFileNameWithoutExtension(fileName),
            Slug = slug,
            Language = language ?? "en",
            Status = UserBookStatus.Processing,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };

        // Save file
        ms.Position = 0;
        var storagePath = await storage.SaveUserFileAsync(userId, userBookId, $"original{Path.GetExtension(fileName)}", ms, ct);

        var userBookFile = new UserBookFile
        {
            Id = Guid.NewGuid(),
            UserBookId = userBookId,
            OriginalFileName = fileName,
            StoragePath = storagePath,
            Format = format,
            Sha256 = sha256,
            FileSize = fileSize,
            UploadedAt = DateTimeOffset.UtcNow
        };

        var job = new UserIngestionJob
        {
            Id = Guid.NewGuid(),
            UserBookId = userBookId,
            UserBookFileId = userBookFile.Id,
            Status = JobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        // Update storage usage
        user.StorageUsedBytes += fileSize;

        db.UserBooks.Add(userBook);
        db.UserBookFiles.Add(userBookFile);
        db.UserIngestionJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return (new UploadUserBookResponse(userBookId, job.Id, UserBookStatus.Processing.ToString()), null);
    }

    public async Task<IReadOnlyList<UserBookListDto>> GetBooksAsync(Guid userId, CancellationToken ct)
    {
        var books = await db.UserBooks
            .Where(b => b.UserId == userId)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Slug,
                b.Language,
                b.Description,
                b.CoverPath,
                b.Status,
                b.ErrorMessage,
                ChapterCount = b.Chapters.Count,
                b.CreatedAt
            })
            .ToListAsync(ct);

        return books.Select(b => new UserBookListDto(
            b.Id,
            b.Title,
            b.Slug,
            b.Language,
            b.Description,
            b.CoverPath,
            b.Status.ToString(),
            b.ErrorMessage,
            b.ChapterCount,
            b.CreatedAt
        )).ToList();
    }

    public async Task<UserBookDetailDto?> GetBookAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Where(b => b.UserId == userId && b.Id == bookId)
            .Select(b => new
            {
                b.Id,
                b.Title,
                b.Slug,
                b.Language,
                b.Description,
                b.CoverPath,
                b.Status,
                b.ErrorMessage,
                b.TocJson,
                b.CreatedAt,
                b.UpdatedAt,
                Chapters = b.Chapters
                    .OrderBy(c => c.ChapterNumber)
                    .Select(c => new UserChapterSummaryDto(c.Id, c.ChapterNumber, c.Slug, c.Title, c.WordCount))
                    .ToList()
            })
            .FirstOrDefaultAsync(ct);

        if (book is null)
            return null;

        IReadOnlyList<TocEntryDto>? toc = null;
        if (!string.IsNullOrEmpty(book.TocJson))
        {
            try
            {
                toc = JsonSerializer.Deserialize<List<TocEntryDto>>(book.TocJson, new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                });
            }
            catch { }
        }

        return new UserBookDetailDto(
            book.Id,
            book.Title,
            book.Slug,
            book.Language,
            book.Description,
            book.CoverPath,
            book.Status.ToString(),
            book.ErrorMessage,
            book.Chapters,
            toc,
            book.CreatedAt,
            book.UpdatedAt
        );
    }

    public async Task<UserChapterDto?> GetChapterBySlugAsync(Guid userId, Guid bookId, string slug, CancellationToken ct)
    {
        var chapter = await db.UserChapters
            .Where(c => c.UserBook.UserId == userId && c.UserBookId == bookId && c.Slug == slug)
            .Select(c => new
            {
                c.Id,
                c.ChapterNumber,
                c.Slug,
                c.Title,
                c.Html,
                c.WordCount,
                c.UserBookId
            })
            .FirstOrDefaultAsync(ct);

        if (chapter is null)
            return null;

        var prev = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId && c.ChapterNumber == chapter.ChapterNumber - 1)
            .Select(c => new UserChapterNavDto(c.ChapterNumber, c.Slug, c.Title))
            .FirstOrDefaultAsync(ct);

        var next = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId && c.ChapterNumber == chapter.ChapterNumber + 1)
            .Select(c => new UserChapterNavDto(c.ChapterNumber, c.Slug, c.Title))
            .FirstOrDefaultAsync(ct);

        return new UserChapterDto(
            chapter.Id,
            chapter.ChapterNumber,
            chapter.Slug,
            chapter.Title,
            chapter.Html,
            chapter.WordCount,
            prev,
            next
        );
    }

    public async Task<(bool Success, string? Error)> DeleteAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Include(b => b.BookFiles)
            .FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);

        if (book is null)
            return (false, "Book not found");

        // Calculate total file size to deduct from user quota
        var totalFileSize = book.BookFiles.Sum(f => f.FileSize);

        // Delete files from storage
        await storage.DeleteUserBookDirectoryAsync(userId, bookId, ct);

        // Update user storage quota
        var user = await db.Users.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is not null)
            user.StorageUsedBytes = Math.Max(0, user.StorageUsedBytes - totalFileSize);

        // Delete from database (cascade will handle related entities)
        db.UserBooks.Remove(book);
        await db.SaveChangesAsync(ct);

        return (true, null);
    }

    public async Task<(bool Success, string? Error)> CancelAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);
        if (book is null)
            return (false, "Book not found");

        if (book.Status != UserBookStatus.Processing)
            return (false, "Only processing books can be cancelled");

        // Cancel any active job
        var job = await db.UserIngestionJobs
            .Where(j => j.UserBookId == bookId && (j.Status == JobStatus.Queued || j.Status == JobStatus.Processing))
            .FirstOrDefaultAsync(ct);
        if (job is not null)
        {
            job.Status = JobStatus.Failed;
            job.Error = "Cancelled by user";
            job.FinishedAt = DateTimeOffset.UtcNow;
        }

        book.Status = UserBookStatus.Failed;
        book.ErrorMessage = "Cancelled by user";
        book.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> RetryAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Include(b => b.BookFiles)
            .FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);

        if (book is null)
            return (false, "Book not found");

        if (book.Status != UserBookStatus.Failed)
            return (false, "Only failed books can be retried");

        var bookFile = book.BookFiles.FirstOrDefault();
        if (bookFile is null)
            return (false, "No source file found");

        // Create new ingestion job
        var job = new UserIngestionJob
        {
            Id = Guid.NewGuid(),
            UserBookId = bookId,
            UserBookFileId = bookFile.Id,
            Status = JobStatus.Queued,
            CreatedAt = DateTimeOffset.UtcNow
        };

        // Reset book status
        book.Status = UserBookStatus.Processing;
        book.ErrorMessage = null;
        book.UpdatedAt = DateTimeOffset.UtcNow;

        db.UserIngestionJobs.Add(job);
        await db.SaveChangesAsync(ct);

        return (true, null);
    }

    public async Task<StorageQuotaDto> GetStorageQuotaAsync(Guid userId, CancellationToken ct)
    {
        var usedBytes = await db.Users
            .Where(u => u.Id == userId)
            .Select(u => u.StorageUsedBytes)
            .FirstOrDefaultAsync(ct);

        var percent = User.StorageLimitBytes > 0
            ? (double)usedBytes / User.StorageLimitBytes * 100
            : 0;

        return new StorageQuotaDto(usedBytes, User.StorageLimitBytes, Math.Round(percent, 2));
    }

    public async Task<UserBookProgressDto?> GetProgressAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Where(b => b.UserId == userId && b.Id == bookId)
            .Select(b => new { b.ProgressChapterSlug, b.ProgressLocator, b.ProgressPercent, b.ProgressUpdatedAt })
            .FirstOrDefaultAsync(ct);

        if (book is null || book.ProgressChapterSlug is null)
            return null;

        return new UserBookProgressDto(
            book.ProgressChapterSlug,
            book.ProgressLocator,
            book.ProgressPercent,
            book.ProgressUpdatedAt
        );
    }

    public async Task<(bool Success, string? Error)> UpsertProgressAsync(
        Guid userId, Guid bookId, UpsertUserBookProgressRequest request, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);
        if (book is null)
            return (false, "Book not found");

        // Conflict resolution: client timestamp must be newer
        if (request.UpdatedAt.HasValue && book.ProgressUpdatedAt.HasValue &&
            request.UpdatedAt.Value <= book.ProgressUpdatedAt.Value)
        {
            // Client data is stale, return success but don't update
            return (true, null);
        }

        book.ProgressChapterSlug = request.ChapterSlug;
        book.ProgressLocator = request.Locator;
        book.ProgressPercent = request.Percent;
        book.ProgressUpdatedAt = request.UpdatedAt ?? DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<IReadOnlyList<UserBookBookmarkDto>> GetBookmarksAsync(Guid userId, Guid bookId, CancellationToken ct)
    {
        return await db.UserBookBookmarks
            .Where(b => b.UserBook.UserId == userId && b.UserBookId == bookId)
            .OrderByDescending(b => b.CreatedAt)
            .Select(b => new UserBookBookmarkDto(
                b.Id,
                b.ChapterId,
                b.Chapter.Slug,
                b.Locator,
                b.Title,
                b.CreatedAt
            ))
            .ToListAsync(ct);
    }

    public async Task<(UserBookBookmarkDto? Bookmark, string? Error)> CreateBookmarkAsync(
        Guid userId, Guid bookId, CreateUserBookBookmarkRequest request, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.UserId == userId && b.Id == bookId, ct);
        if (book is null)
            return (null, "Book not found");

        var chapter = await db.UserChapters.FirstOrDefaultAsync(c => c.UserBookId == bookId && c.Id == request.ChapterId, ct);
        if (chapter is null)
            return (null, "Chapter not found");

        var bookmark = new UserBookBookmark
        {
            Id = Guid.NewGuid(),
            UserBookId = bookId,
            ChapterId = request.ChapterId,
            Locator = request.Locator,
            Title = request.Title,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.UserBookBookmarks.Add(bookmark);
        await db.SaveChangesAsync(ct);

        return (new UserBookBookmarkDto(
            bookmark.Id,
            bookmark.ChapterId,
            chapter.Slug,
            bookmark.Locator,
            bookmark.Title,
            bookmark.CreatedAt
        ), null);
    }

    public async Task<(bool Success, string? Error)> DeleteBookmarkAsync(
        Guid userId, Guid bookId, Guid bookmarkId, CancellationToken ct)
    {
        var bookmark = await db.UserBookBookmarks
            .FirstOrDefaultAsync(b => b.UserBook.UserId == userId && b.UserBookId == bookId && b.Id == bookmarkId, ct);

        if (bookmark is null)
            return (false, "Bookmark not found");

        db.UserBookBookmarks.Remove(bookmark);
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    private static BookFormat DetectFormat(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".epub" => BookFormat.Epub,
            ".pdf" => BookFormat.Pdf,
            ".fb2" => BookFormat.Fb2,
            _ => BookFormat.Other
        };
    }

    private static async Task<string> ComputeSha256Async(Stream stream, CancellationToken ct)
    {
        using var sha256 = SHA256.Create();
        var hash = await sha256.ComputeHashAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
