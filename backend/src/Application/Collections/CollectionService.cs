using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.Collections;

public class CollectionService(IAppDbContext db)
{
    public const int MaxCollectionsPerUser = 50;
    public const int MaxNameLength = 100;
    private static readonly string[] ValidColors = ["default", "blue", "green", "amber", "rose", "violet", "teal", "slate"];
    private static readonly string[] ValidBookTypes = ["userbook", "savedbook"];

    public async Task<List<CollectionListItem>> ListAsync(Guid userId, CancellationToken ct)
    {
        var collections = await db.Collections
            .Where(c => c.UserId == userId)
            .OrderBy(c => c.SortOrder)
            .ThenBy(c => c.CreatedAt)
            .ToListAsync(ct);

        var counts = await db.BookCollections
            .Where(bc => collections.Select(c => c.Id).Contains(bc.CollectionId))
            .GroupBy(bc => bc.CollectionId)
            .Select(g => new { CollectionId = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        var countMap = counts.ToDictionary(x => x.CollectionId, x => x.Count);
        return collections
            .Select(c => new CollectionListItem(c.Id, c.Name, c.Color, c.SortOrder, countMap.GetValueOrDefault(c.Id, 0)))
            .ToList();
    }

    public async Task<(Collection? Created, string? Error)> CreateAsync(
        Guid userId, string name, string? color, CancellationToken ct)
    {
        var trimmed = (name ?? string.Empty).Trim();
        if (trimmed.Length == 0) return (null, "Name is required");
        if (trimmed.Length > MaxNameLength) return (null, $"Name max {MaxNameLength} chars");
        if (color != null && !ValidColors.Contains(color)) return (null, "Invalid color");

        var existingCount = await db.Collections.CountAsync(c => c.UserId == userId, ct);
        if (existingCount >= MaxCollectionsPerUser) return (null, $"Max {MaxCollectionsPerUser} collections");

        var maxSort = await db.Collections.Where(c => c.UserId == userId).MaxAsync(c => (int?)c.SortOrder, ct) ?? -1;
        var collection = new Collection
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            Name = trimmed,
            Color = color ?? "default",
            SortOrder = maxSort + 1,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        db.Collections.Add(collection);
        await db.SaveChangesAsync(ct);
        return (collection, null);
    }

    public async Task<(Collection? Updated, string? Error)> UpdateAsync(
        Guid userId, Guid id, string? name, string? color, int? sortOrder, CancellationToken ct)
    {
        var collection = await db.Collections.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (collection is null) return (null, "Collection not found");
        if (name != null)
        {
            var trimmed = name.Trim();
            if (trimmed.Length == 0) return (null, "Name is required");
            if (trimmed.Length > MaxNameLength) return (null, $"Name max {MaxNameLength} chars");
            collection.Name = trimmed;
        }
        if (color != null)
        {
            if (!ValidColors.Contains(color)) return (null, "Invalid color");
            collection.Color = color;
        }
        if (sortOrder.HasValue) collection.SortOrder = sortOrder.Value;
        collection.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);
        return (collection, null);
    }

    public async Task<bool> DeleteAsync(Guid userId, Guid id, CancellationToken ct)
    {
        var collection = await db.Collections.FirstOrDefaultAsync(c => c.Id == id && c.UserId == userId, ct);
        if (collection is null) return false;
        db.Collections.Remove(collection); // cascades BookCollections
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<(bool Ok, string? Error)> AddBookAsync(
        Guid userId, Guid collectionId, Guid bookId, string bookType, CancellationToken ct)
    {
        if (!ValidBookTypes.Contains(bookType)) return (false, "Invalid bookType");
        var owns = await db.Collections.AnyAsync(c => c.Id == collectionId && c.UserId == userId, ct);
        if (!owns) return (false, "Collection not found");
        if ((await AddableBookIdsAsync(db, userId, [bookId], bookType, ct)).Count == 0)
            return (false, "Book not found");

        var exists = await db.BookCollections.AnyAsync(
            bc => bc.CollectionId == collectionId && bc.BookId == bookId && bc.BookType == bookType, ct);
        if (exists) return (true, null);

        db.BookCollections.Add(new BookCollection
        {
            CollectionId = collectionId,
            BookId = bookId,
            BookType = bookType,
            AddedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);
        return (true, null);
    }

    public async Task<bool> RemoveBookAsync(
        Guid userId, Guid collectionId, Guid bookId, string bookType, CancellationToken ct)
    {
        var owns = await db.Collections.AnyAsync(c => c.Id == collectionId && c.UserId == userId, ct);
        if (!owns) return false;
        var row = await db.BookCollections.FirstOrDefaultAsync(
            bc => bc.CollectionId == collectionId && bc.BookId == bookId && bc.BookType == bookType, ct);
        if (row is null) return true;
        db.BookCollections.Remove(row);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<List<Guid>> GetBookIdsAsync(
        Guid userId, Guid collectionId, string bookType, CancellationToken ct)
    {
        var owns = await db.Collections.AnyAsync(c => c.Id == collectionId && c.UserId == userId, ct);
        if (!owns) return [];
        return await db.BookCollections
            .Where(bc => bc.CollectionId == collectionId && bc.BookType == bookType)
            .Select(bc => bc.BookId)
            .ToListAsync(ct);
    }

    /// <summary>
    /// Which of <paramref name="ids"/> the user may put in a collection: their own uploads
    /// ("userbook") or catalog editions in their library ("savedbook" — both clients offer
    /// collections only for a saved book, and removing it from the library removes it from them).
    /// </summary>
    public static async Task<HashSet<Guid>> AddableBookIdsAsync(
        IAppDbContext db, Guid userId, IReadOnlyCollection<Guid> ids, string bookType, CancellationToken ct)
    {
        var found = bookType == "userbook"
            ? await db.UserBooks.Where(b => b.UserId == userId && ids.Contains(b.Id)).Select(b => b.Id).ToListAsync(ct)
            : await db.UserLibraries.Where(l => l.UserId == userId && ids.Contains(l.EditionId)).Select(l => l.EditionId).ToListAsync(ct);
        return found.ToHashSet();
    }

    /// <summary>
    /// Stages removal of a book from collections when the book goes away; the caller saves.
    /// <paramref name="userId"/> limits it to one user's collections (a library removal); null means
    /// every user's (the book itself was deleted).
    /// </summary>
    public static async Task RemoveFromAllCollectionsAsync(
        IAppDbContext db, Guid? userId, Guid bookId, string bookType, CancellationToken ct)
    {
        var query = db.BookCollections.Where(bc => bc.BookId == bookId && bc.BookType == bookType);
        if (userId is { } uid)
        {
            var userCollections = db.Collections.Where(c => c.UserId == uid).Select(c => c.Id);
            query = query.Where(bc => userCollections.Contains(bc.CollectionId));
        }
        db.BookCollections.RemoveRange(await query.ToListAsync(ct));
    }
}

public record CollectionListItem(Guid Id, string Name, string Color, int SortOrder, int Count);
