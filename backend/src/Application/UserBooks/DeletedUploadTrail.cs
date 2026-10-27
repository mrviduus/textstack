using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.UserBooks;

/// <summary>
/// Deleting an upload keeps its highlights and reading sessions, with no book (SET NULL, #939).
/// <see cref="Keep"/> writes what they need to find their way back: the book's title (#982), the
/// file's sha256 and the highlight's chapter slug. <see cref="ReattachAsync"/> hands them to the
/// next upload of the same file by the same user (#983).
/// </summary>
public static class DeletedUploadTrail
{
    /// <summary>Call before removing <paramref name="book"/>, in the same SaveChanges.</summary>
    public static async Task Keep(IAppDbContext db, UserBook book, CancellationToken ct)
    {
        var sha256 = book.BookFiles.Select(f => f.Sha256).FirstOrDefault(s => s != null);
        foreach (var h in await db.Highlights.Include(h => h.UserChapter)
                     .Where(h => h.UserBookId == book.Id).ToListAsync(ct))
        {
            h.BookTitle = book.Title;
            h.DeletedBookSha256 = sha256;
            h.DeletedChapterSlug = h.UserChapter?.Slug;
        }
        if (sha256 is null) return;
        foreach (var s in await db.ReadingSessions.Where(s => s.UserBookId == book.Id).ToListAsync(ct))
            s.DeletedBookSha256 = sha256;
    }

    /// <summary>
    /// Re-attaches the user's ownerless rows from an earlier upload of the same file to
    /// <paramref name="book"/>, whose chapters must be saved. A highlight whose chapter slug the new
    /// book does not have stays ownerless: without its chapter a text anchor never paints. Same file
    /// and extractor give the same slugs; a changed extractor may not. A session whose start time
    /// the book already has (two deleted copies synced the same session) stays ownerless too: the
    /// unique (user, book, started_at) index would refuse it, and the whole save with it.
    /// </summary>
    public static async Task<(int Highlights, int Sessions, int Skipped)> ReattachAsync(
        IAppDbContext db, UserBook book, string? sha256, CancellationToken ct)
    {
        if (sha256 is null) return (0, 0, 0);
        // ponytail: no index serves this lookup (prod: 1 ownerless highlight, 14 sessions). Add a
        // partial index on (user_id, deleted_book_sha256) WHERE deleted_book_sha256 IS NOT NULL if
        // ownerless rows grow.
        var highlights = await db.Highlights
            .Where(h => h.UserId == book.UserId && h.EditionId == null && h.UserBookId == null
                && h.DeletedBookSha256 == sha256)
            .ToListAsync(ct);
        var sessions = await db.ReadingSessions
            .Where(s => s.UserId == book.UserId && s.EditionId == null && s.UserBookId == null
                && s.DeletedBookSha256 == sha256)
            .ToListAsync(ct);
        if (highlights.Count == 0 && sessions.Count == 0) return (0, 0, 0);

        var chapterIds = await db.UserChapters.Where(c => c.UserBookId == book.Id)
            .ToDictionaryAsync(c => c.Slug, c => c.Id, ct);
        var attached = 0;
        foreach (var h in highlights)
        {
            Guid? chapterId = null;
            if (h.DeletedChapterSlug is { } slug)
            {
                if (!chapterIds.TryGetValue(slug, out var id)) continue;
                chapterId = id;
            }
            h.UserBookId = book.Id;
            h.UserChapterId = chapterId;
            h.BookTitle = null;
            h.DeletedBookSha256 = null;
            h.DeletedChapterSlug = null;
            attached++;
        }

        var startedAt = (await db.ReadingSessions.Where(s => s.UserBookId == book.Id)
            .Select(s => s.StartedAt).ToListAsync(ct)).ToHashSet();
        var sessionsAttached = 0;
        foreach (var s in sessions)
        {
            if (!startedAt.Add(s.StartedAt)) continue;
            s.UserBookId = book.Id;
            s.DeletedBookSha256 = null;
            sessionsAttached++;
        }
        await db.SaveChangesAsync(ct);
        return (attached, sessionsAttached,
            highlights.Count - attached + sessions.Count - sessionsAttached);
    }
}
