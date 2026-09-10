using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.UserBooks;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class MetadataService(IAppDbContext db)
{
    private const int MaxHistoryEntries = 5;

    public async Task<(UserBookDetailDto? Updated, string? Error)> UpdateAsync(
        Guid userId, Guid bookId, UpdateUserBookMetadataRequest req, CancellationToken ct)
    {
        var book = await db.UserBooks
            .Include(b => b.Chapters)
            .Include(b => b.BookFiles)
            .FirstOrDefaultAsync(b => b.Id == bookId && b.UserId == userId, ct);

        if (book is null) return (null, "Book not found");

        var validationError = Validate(req);
        if (validationError is not null) return (null, validationError);

        var snapshot = new MetadataSnapshot(
            book.Title, book.Author, book.Language, book.Genre, book.Description,
            book.PublishedYear, DateTimeOffset.UtcNow);

        var history = ParseHistory(book.MetadataHistoryJson);
        history.Insert(0, snapshot);
        if (history.Count > MaxHistoryEntries) history = history.Take(MaxHistoryEntries).ToList();

        book.Title = req.Title.Trim();
        book.Author = NormalizeOptional(req.Author);
        book.Language = req.Language.Trim();
        book.Genre = NormalizeOptional(req.Genre);
        book.Description = NormalizeOptional(req.Description);
        book.PublishedYear = req.PublishedYear;
        book.SeoSource = "manual";
        book.MetadataHistoryJson = JsonSerializer.Serialize(history);
        book.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        var dto = new UserBookDetailDto(
            book.Id, book.Title, book.Slug, book.Language, book.Author, book.Description,
            book.CoverPath, book.Genre, book.PublishedYear, book.TotalWordCount,
            book.Status.ToString(), book.ErrorMessage,
            book.Chapters.OrderBy(c => c.ChapterNumber).Select(c =>
                new UserChapterSummaryDto(c.Id, c.ChapterNumber, c.Slug, c.Title, c.WordCount, c.SourceStartPage)).ToList(),
            null,
            book.CreatedAt, book.UpdatedAt, book.CompletedAt,
            book.BookFiles.Any(f => f.Format == Domain.Enums.BookFormat.Pdf),
            book.MetadataEnrichmentStatus.ToString());

        return (dto, null);
    }

    private static string? Validate(UpdateUserBookMetadataRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Title)) return "Title is required";
        if (req.Title.Length > 200) return "Title too long (max 200)";
        if (req.Author is { Length: > 200 }) return "Author too long (max 200)";
        if (string.IsNullOrWhiteSpace(req.Language)) return "Language is required";
        if (req.Language.Length > 10) return "Language code too long";
        if (req.Genre is { Length: > 100 }) return "Genre too long (max 100)";
        if (req.Description is { Length: > 2000 }) return "Description too long (max 2000)";
        if (req.PublishedYear is { } yr && (yr < 0 || yr > DateTime.UtcNow.Year + 1)) return "Invalid published year";
        return null;
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static List<MetadataSnapshot> ParseHistory(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<MetadataSnapshot>>(json) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private record MetadataSnapshot(
        string Title, string? Author, string Language, string? Genre,
        string? Description, int? PublishedYear, DateTimeOffset SnapshotAt);
}
