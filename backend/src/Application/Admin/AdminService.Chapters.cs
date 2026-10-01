using System.Security.Cryptography;
using System.Text.Json;
using Application.Common.Interfaces;
using Application.SsgRebuild;
using Contracts.Admin;
using Contracts.Common;
using Domain.Entities;
using Domain.Enums;
using Domain.Utilities;
using static TextStack.Extraction.Utilities.HtmlCleaner;
using Microsoft.EntityFrameworkCore;
using Application.UserBooks;

namespace Application.Admin;

/// <summary>
/// Chapter CRUD — detail load, update (re-strips HTML + recounts words), delete (with renumbering of trailing chapters). HTML stripping + word counting helpers live here too.
/// </summary>
public partial class AdminService
{
    // Chapter CRUD

    public async Task<AdminChapterDetailDto?> GetChapterDetailAsync(Guid id, CancellationToken ct)
    {
        return await db.Chapters
            .Where(c => c.Id == id)
            .Select(c => new AdminChapterDetailDto(
                c.Id,
                c.EditionId,
                c.ChapterNumber,
                c.Slug,
                c.Title,
                c.Html,
                c.WordCount,
                c.CreatedAt,
                c.UpdatedAt
            ))
            .FirstOrDefaultAsync(ct);
    }

    public async Task<(bool Success, string? Error)> UpdateChapterAsync(
        Guid id, UpdateChapterRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Title))
            return (false, "Title is required");

        if (string.IsNullOrWhiteSpace(request.Html))
            return (false, "Content is required");

        var chapter = await db.Chapters.FindAsync([id], ct);
        if (chapter is null)
            return (false, "Chapter not found");

        chapter.Title = request.Title;
        chapter.Html = request.Html;
        chapter.PlainText = StripHtml(request.Html);
        chapter.WordCount = CountWords(chapter.PlainText);
        chapter.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<(bool Success, string? Error)> DeleteChapterAsync(Guid id, CancellationToken ct)
    {
        var chapter = await db.Chapters.FindAsync([id], ct);
        if (chapter is null)
            return (false, "Chapter not found");

        var editionId = chapter.EditionId;
        var deletedNumber = chapter.ChapterNumber;

        db.Chapters.Remove(chapter);

        // Renumber remaining chapters
        var remaining = await db.Chapters
            .Where(c => c.EditionId == editionId && c.ChapterNumber > deletedNumber)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        foreach (var ch in remaining)
        {
            ch.ChapterNumber--;
            ch.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        return (true, null);
    }
}
