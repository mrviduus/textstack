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

/// <summary>
/// User-uploaded book moderation — list with status/user-type filters + search, aggregate stats, delete (via UserBookService), takedown (with reason).
/// </summary>
public partial class AdminService
{
    // User Uploads

    public async Task<PaginatedResult<UserUploadListDto>> GetUserUploadsAsync(
        UserUploadsQuery query, CancellationToken ct)
    {
        var q = db.UserBooks.AsQueryable();

        if (query.Status.HasValue)
            q = q.Where(b => b.Status == query.Status.Value);

        if (string.Equals(query.UserType, "guest", StringComparison.OrdinalIgnoreCase))
            q = q.Where(b => b.User.IsGuest);
        else if (string.Equals(query.UserType, "registered", StringComparison.OrdinalIgnoreCase))
            q = q.Where(b => !b.User.IsGuest);

        if (!string.IsNullOrWhiteSpace(query.Search))
            q = q.Where(b => b.Title.Contains(query.Search) ||
                             (b.Author != null && b.Author.Contains(query.Search)) ||
                             b.User.Email.Contains(query.Search));

        var total = await q.CountAsync(ct);

        var items = await q
            .OrderByDescending(b => b.CreatedAt)
            .Skip(query.Offset)
            .Take(query.Limit)
            .Select(b => new UserUploadListDto(
                b.Id,
                b.Title,
                b.Author,
                b.Language,
                b.Status.ToString(),
                b.Chapters.Count,
                b.TotalWordCount,
                b.BookFiles.Sum(f => f.FileSize),
                b.BookFiles.Select(f => f.Format.ToString()).FirstOrDefault(),
                b.BookFiles.Select(f => f.OriginalFileName).FirstOrDefault(),
                b.User.Email,
                b.User.IsGuest,
                b.ErrorMessage,
                b.CreatedAt,
                b.TakedownAt,
                b.TakedownReason))
            .ToListAsync(ct);

        return new PaginatedResult<UserUploadListDto>(total, items);
    }

    public async Task<UserUploadStatsDto> GetUserUploadStatsAsync(CancellationToken ct)
    {
        var total = await db.UserBooks.CountAsync(ct);
        var processing = await db.UserBooks.CountAsync(b => b.Status == UserBookStatus.Processing, ct);
        var ready = await db.UserBooks.CountAsync(b => b.Status == UserBookStatus.Ready, ct);
        var failed = await db.UserBooks.CountAsync(b => b.Status == UserBookStatus.Failed, ct);
        var guest = await db.UserBooks.CountAsync(b => b.User.IsGuest, ct);
        var registered = total - guest;
        var storageBytes = await db.UserBookFiles.Select(f => (long?)f.FileSize).SumAsync(ct) ?? 0;

        return new UserUploadStatsDto(total, processing, ready, failed, guest, registered, storageBytes);
    }

    public async Task<(bool Success, string? Error)> DeleteUserUploadAsync(Guid id, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == id, ct);
        if (book is null)
            return (false, "User book not found");

        return await userBookService.DeleteAsync(book.UserId, book.Id, ct);
    }

    public async Task<(bool Success, string? Error)> TakedownUserUploadAsync(Guid id, string reason, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(reason))
            return (false, "Reason is required");

        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == id, ct);
        if (book is null)
            return (false, "User book not found");

        var trimmed = reason.Trim();
        if (trimmed.Length > 1000)
            trimmed = trimmed[..1000];

        book.TakedownAt = DateTimeOffset.UtcNow;
        book.TakedownReason = trimmed;
        book.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }
}
