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
                    .Select(c => new UserChapterSummaryDto(c.Id, c.ChapterNumber, c.Title, c.WordCount))
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

    public async Task<UserChapterDto?> GetChapterAsync(Guid userId, Guid bookId, int chapterNumber, CancellationToken ct)
    {
        var chapter = await db.UserChapters
            .Where(c => c.UserBook.UserId == userId && c.UserBookId == bookId && c.ChapterNumber == chapterNumber)
            .Select(c => new
            {
                c.Id,
                c.ChapterNumber,
                c.Title,
                c.Html,
                c.WordCount,
                c.UserBookId
            })
            .FirstOrDefaultAsync(ct);

        if (chapter is null)
            return null;

        var prev = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId && c.ChapterNumber == chapterNumber - 1)
            .Select(c => new UserChapterNavDto(c.ChapterNumber, c.Title))
            .FirstOrDefaultAsync(ct);

        var next = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId && c.ChapterNumber == chapterNumber + 1)
            .Select(c => new UserChapterNavDto(c.ChapterNumber, c.Title))
            .FirstOrDefaultAsync(ct);

        return new UserChapterDto(
            chapter.Id,
            chapter.ChapterNumber,
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
