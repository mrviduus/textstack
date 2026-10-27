using Application.Common.Interfaces;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class TagService(IAppDbContext db)
{
    public const int MaxTagsPerBook = 20;
    public const int MaxTagLength = 50;

    public static string Normalize(string tag)
    {
        var lowered = (tag ?? string.Empty).Trim().ToLowerInvariant();
        var collapsed = System.Text.RegularExpressions.Regex.Replace(lowered, @"\s+", "-");
        var cleaned = new string(collapsed.Where(c => char.IsLetterOrDigit(c) || c == '-').ToArray());
        return cleaned.Length > MaxTagLength ? cleaned[..MaxTagLength] : cleaned;
    }

    public static string[] NormalizeAll(IEnumerable<string> tags)
    {
        return tags
            .Select(Normalize)
            .Where(t => t.Length > 0 && t.Length <= MaxTagLength)
            .Distinct()
            .Take(MaxTagsPerBook)
            .ToArray();
    }

    public async Task<(string[]? Tags, string? Error)> SetTagsAsync(
        Guid userId, Guid bookId, IEnumerable<string> tags, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == bookId && b.UserId == userId, ct);
        if (book is null) return (null, "Book not found");

        var normalized = NormalizeAll(tags);
        book.Tags = normalized;
        book.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return (normalized, null);
    }

    public async Task<(string[]? Tags, string? Error)> AcceptSuggestedTagsAsync(
        Guid userId, Guid bookId, IEnumerable<string> accepted, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == bookId && b.UserId == userId, ct);
        if (book is null) return (null, "Book not found");

        var suggestedSet = new HashSet<string>(book.SuggestedTags, StringComparer.OrdinalIgnoreCase);
        var picked = (accepted ?? []).Where(t => suggestedSet.Contains(t));
        var merged = NormalizeAll(book.Tags.Concat(picked));

        book.Tags = merged;
        book.SuggestedTags = [];
        book.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return (merged, null);
    }

    public async Task<bool> DismissSuggestedTagsAsync(
        Guid userId, Guid bookId, CancellationToken ct)
    {
        var book = await db.UserBooks.FirstOrDefaultAsync(b => b.Id == bookId && b.UserId == userId, ct);
        if (book is null) return false;

        book.SuggestedTags = [];
        book.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<List<TagCount>> GetUserTagsAsync(Guid userId, CancellationToken ct)
    {
        var rows = await db.UserBooks
            .Where(b => b.UserId == userId)
            .Select(b => b.Tags)
            .ToListAsync(ct);

        return rows
            .SelectMany(t => t)
            .GroupBy(t => t)
            .Select(g => new TagCount(g.Key, g.Count()))
            .OrderByDescending(t => t.Count)
            .ThenBy(t => t.Tag)
            .Take(50)
            .ToList();
    }
}

public record TagCount(string Tag, int Count);
