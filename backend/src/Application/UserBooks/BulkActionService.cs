using Application.Collections;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

public class BulkActionService(IAppDbContext db, UserBookService userBookService)
{
    public const int MaxIdsPerCall = 500;
    private static readonly string[] ValidBookTypes = ["userbook", "savedbook"];

    public async Task<BulkResult> SetFinishedAsync(
        Guid userId, IReadOnlyList<Guid> ids, bool isFinished, CancellationToken ct)
    {
        var (valid, failed) = await ResolveOwnedUserBooksAsync(userId, ids, ct);
        var now = DateTimeOffset.UtcNow;
        foreach (var book in valid)
        {
            book.CompletedAt = isFinished ? (book.CompletedAt ?? now) : null;
            book.UpdatedAt = now;
        }
        if (valid.Count > 0) await db.SaveChangesAsync(ct);
        return new BulkResult(valid.Select(b => b.Id).ToArray(), failed);
    }

    public async Task<BulkResult> DeleteAsync(
        Guid userId, IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        var succeeded = new List<Guid>();
        var failed = new List<BulkFailure>();
        foreach (var id in ids.Take(MaxIdsPerCall))
        {
            var (ok, error) = await userBookService.DeleteAsync(userId, id, ct);
            if (ok) succeeded.Add(id);
            else failed.Add(new BulkFailure(id, error ?? "Failed"));
        }
        return new BulkResult(succeeded.ToArray(), failed.ToArray());
    }

    public async Task<BulkResult> AddTagsAsync(
        Guid userId, IReadOnlyList<Guid> ids, IEnumerable<string> add, IEnumerable<string> remove, CancellationToken ct)
    {
        var addNorm = TagService.NormalizeAll(add);
        var removeNorm = TagService.NormalizeAll(remove).ToHashSet();
        var (valid, failed) = await ResolveOwnedUserBooksAsync(userId, ids, ct);
        foreach (var book in valid)
        {
            var current = (book.Tags ?? Array.Empty<string>()).ToList();
            current.RemoveAll(t => removeNorm.Contains(t));
            foreach (var tag in addNorm) if (!current.Contains(tag)) current.Add(tag);
            book.Tags = current.Take(TagService.MaxTagsPerBook).ToArray();
            book.UpdatedAt = DateTimeOffset.UtcNow;
        }
        if (valid.Count > 0) await db.SaveChangesAsync(ct);
        return new BulkResult(valid.Select(b => b.Id).ToArray(), failed);
    }

    public async Task<BulkResult> AddToCollectionAsync(
        Guid userId, Guid collectionId, IReadOnlyList<Guid> ids, string bookType, CancellationToken ct)
    {
        if (!ValidBookTypes.Contains(bookType))
            return new BulkResult([], ids.Select(id => new BulkFailure(id, "Invalid bookType")).ToArray());

        var owns = await db.Collections.AnyAsync(c => c.Id == collectionId && c.UserId == userId, ct);
        if (!owns)
            return new BulkResult([], ids.Select(id => new BulkFailure(id, "Collection not found")).ToArray());

        // Distinct: a repeated id would stage two identical BookCollection rows, and EF's
        // identity map throws on the second (composite key) — a 500 for a harmless request.
        var capped = ids.Distinct().Take(MaxIdsPerCall).ToList();
        var addable = await CollectionService.AddableBookIdsAsync(db, userId, capped, bookType, ct);
        var existing = await db.BookCollections
            .Where(bc => bc.CollectionId == collectionId && bc.BookType == bookType && capped.Contains(bc.BookId))
            .Select(bc => bc.BookId)
            .ToListAsync(ct);
        var existingSet = existing.ToHashSet();
        var now = DateTimeOffset.UtcNow;
        foreach (var id in capped)
        {
            if (!addable.Contains(id) || existingSet.Contains(id)) continue;
            db.BookCollections.Add(new BookCollection
            {
                CollectionId = collectionId,
                BookId = id,
                BookType = bookType,
                AddedAt = now,
            });
        }
        await db.SaveChangesAsync(ct);
        return new BulkResult(
            capped.Where(addable.Contains).ToArray(),
            capped.Where(id => !addable.Contains(id)).Select(id => new BulkFailure(id, "Not found")).ToArray());
    }

    public async Task<BulkResult> RemoveFromCollectionAsync(
        Guid userId, Guid collectionId, IReadOnlyList<Guid> ids, string bookType, CancellationToken ct)
    {
        if (!ValidBookTypes.Contains(bookType))
            return new BulkResult([], ids.Select(id => new BulkFailure(id, "Invalid bookType")).ToArray());

        var owns = await db.Collections.AnyAsync(c => c.Id == collectionId && c.UserId == userId, ct);
        if (!owns)
            return new BulkResult([], ids.Select(id => new BulkFailure(id, "Collection not found")).ToArray());

        var rows = await db.BookCollections
            .Where(bc => bc.CollectionId == collectionId && bc.BookType == bookType && ids.Contains(bc.BookId))
            .ToListAsync(ct);
        db.BookCollections.RemoveRange(rows);
        await db.SaveChangesAsync(ct);
        return new BulkResult(ids.ToArray(), []);
    }

    private async Task<(List<UserBook> Valid, BulkFailure[] Failed)> ResolveOwnedUserBooksAsync(
        Guid userId, IReadOnlyList<Guid> ids, CancellationToken ct)
    {
        var capped = ids.Take(MaxIdsPerCall).ToList();
        var books = await db.UserBooks.Where(b => b.UserId == userId && capped.Contains(b.Id)).ToListAsync(ct);
        var foundSet = books.Select(b => b.Id).ToHashSet();
        var failed = capped.Where(id => !foundSet.Contains(id))
            .Select(id => new BulkFailure(id, "Not found"))
            .ToArray();
        return (books, failed);
    }
}

public record BulkResult(Guid[] Succeeded, BulkFailure[] Failed);
public record BulkFailure(Guid Id, string Reason);
