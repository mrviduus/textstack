using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.Ingestion;

/// <summary>
/// Re-ingesting a book must not cost its readers anything. Reading progress, bookmarks, notes and
/// highlights all hang on a chapter's <c>Id</c>; re-ingestion used to delete every chapter and
/// insert fresh ones, so progress and bookmarks cascaded away and highlights were orphaned
/// (2026-10 reader audit, C1/H1). Re-ingestion now updates chapters IN PLACE and keeps their Ids.
/// <para>
/// <b>Matching</b> (<see cref="Plan"/>), three greedy passes, existing chapters in number order:
/// exact slug (same position AND title — the slug is <c>{order+1}-{title}</c>), then title (the
/// book gained or lost a chapter in front, so every slug shifted), then chapter number (the
/// extractor retitled a chapter in place). Anything still unmatched is new or gone.
/// </para>
/// <para>
/// <b>A chapter that disappears</b> hands its readers to its successor before it is deleted: the
/// nearest surviving chapter before it, else the nearest after it (the previous one so a reader
/// never skips text they have not read; it is also where a merged chapter's text now lives).
/// </para>
/// </summary>
public static class ChapterReconciler
{
    public readonly record struct Key(int Number, string? Slug, string Title);

    /// <param name="Matches">Per incoming chapter, the index of the existing chapter it replaces, or -1 (new).</param>
    /// <param name="Successors">Per existing chapter that matched nothing: (existing index, incoming index that inherits its readers).</param>
    public sealed record Result(int[] Matches, IReadOnlyList<(int Existing, int Incoming)> Successors);

    public static Result Plan(IReadOnlyList<Key> existing, IReadOnlyList<Key> incoming)
    {
        var matches = Enumerable.Repeat(-1, incoming.Count).ToArray();
        var taken = new bool[existing.Count];
        var order = Enumerable.Range(0, existing.Count).OrderBy(j => existing[j].Number).ToArray();

        // ponytail: O(existing × incoming) per pass — a few hundred chapters at most.
        void Pass(Func<Key, Key, bool> same)
        {
            for (var i = 0; i < incoming.Count; i++)
            {
                if (matches[i] >= 0) continue;
                foreach (var j in order)
                {
                    if (taken[j] || !same(existing[j], incoming[i])) continue;
                    matches[i] = j;
                    taken[j] = true;
                    break;
                }
            }
        }
        Pass((e, n) => e.Slug is not null && e.Slug == n.Slug);
        Pass((e, n) => string.Equals(e.Title.Trim(), n.Title.Trim(), StringComparison.OrdinalIgnoreCase));
        Pass((e, n) => e.Number == n.Number);

        var survivor = Enumerable.Repeat(-1, existing.Count).ToArray();
        for (var i = 0; i < incoming.Count; i++)
            if (matches[i] >= 0) survivor[matches[i]] = i;

        var successors = new List<(int, int)>();
        for (var pos = 0; pos < order.Length; pos++)
        {
            if (survivor[order[pos]] >= 0) continue;
            var s = -1;
            for (var p = pos - 1; p >= 0 && s < 0; p--) s = survivor[order[p]];
            for (var p = pos + 1; p < order.Length && s < 0; p++) s = survivor[order[p]];
            // Nothing survived at all: the chapter at the same position in the new book.
            if (s < 0) s = Math.Min(pos, incoming.Count - 1);
            successors.Add((order[pos], s));
        }

        return new Result(matches, successors);
    }

    /// <summary>
    /// Replaces an edition's chapters with <paramref name="incoming"/> (unsaved, Ids ignored when
    /// matched) in one transaction, keeping matched Ids. Leaves the tracker clean on failure, so a
    /// caller that then marks its job failed does not half-apply it.
    /// </summary>
    public static async Task ReconcileEditionAsync(
        IAppDbContext db, Guid editionId, IReadOnlyList<Chapter> incoming, CancellationToken ct)
    {
        var existing = await db.Chapters.Where(c => c.EditionId == editionId).ToListAsync(ct);
        if (incoming.Count == 0 && existing.Count > 0)
            throw new InvalidOperationException(
                "Extraction produced no chapters; keeping the existing ones and their readers.");

        var plan = Plan(
            existing.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList(),
            incoming.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList());
        var final = new Chapter[incoming.Count];

        await using var tx = await db.BeginTransactionAsync(ct);
        try
        {
            // Park every row off the unique (edition_id, chapter_number) key so final numbers can
            // be written in any order.
            for (var j = 0; j < existing.Count; j++) existing[j].ChapterNumber = -1 - j;
            await db.SaveChangesAsync(ct);

            for (var i = 0; i < incoming.Count; i++)
            {
                var n = incoming[i];
                if (plan.Matches[i] < 0)
                {
                    db.Chapters.Add(n);
                    final[i] = n;
                    continue;
                }
                var e = final[i] = existing[plan.Matches[i]];
                e.ChapterNumber = n.ChapterNumber;
                e.Slug = n.Slug;
                e.Title = n.Title;
                e.Html = n.Html;
                e.PlainText = n.PlainText;
                e.WordCount = n.WordCount;
                e.ContentQualityScore = n.ContentQualityScore;
                e.OriginalChapterNumber = n.OriginalChapterNumber;
                e.PartNumber = n.PartNumber;
                e.TotalParts = n.TotalParts;
                e.UpdatedAt = DateTimeOffset.UtcNow;
            }
            await db.SaveChangesAsync(ct);

            foreach (var (j, i) in plan.Successors)
                await RemoveEditionChapterAsync(db, existing[j], final[i].Id, ct);
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            foreach (var c in existing.Concat(incoming)) db.Chapters.Entry(c).State = EntityState.Detached;
            throw;
        }
    }

    /// <summary>Same as <see cref="ReconcileEditionAsync"/> for an upload; also moves the book's progress slug.</summary>
    public static async Task ReconcileUserBookAsync(
        IAppDbContext db, UserBook book, IReadOnlyList<UserChapter> incoming, CancellationToken ct)
    {
        var existing = await db.UserChapters.Where(c => c.UserBookId == book.Id).ToListAsync(ct);
        if (incoming.Count == 0 && existing.Count > 0)
            throw new InvalidOperationException(
                "Extraction produced no chapters; keeping the existing ones and their readers.");

        var plan = Plan(
            existing.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList(),
            incoming.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList());
        var oldSlugs = existing.Select(c => c.Slug).ToArray();
        var oldProgressSlug = book.ProgressChapterSlug;
        var final = new UserChapter[incoming.Count];

        await using var tx = await db.BeginTransactionAsync(ct);
        try
        {
            // Both (user_book_id, chapter_number) and (user_book_id, slug) are unique.
            for (var j = 0; j < existing.Count; j++)
            {
                existing[j].ChapterNumber = -1 - j;
                existing[j].Slug = $"~{existing[j].Id:N}";
            }
            await db.SaveChangesAsync(ct);

            for (var i = 0; i < incoming.Count; i++)
            {
                var n = incoming[i];
                if (plan.Matches[i] < 0)
                {
                    db.UserChapters.Add(n);
                    final[i] = n;
                    continue;
                }
                var e = final[i] = existing[plan.Matches[i]];
                e.ChapterNumber = n.ChapterNumber;
                e.Slug = n.Slug;
                e.Title = n.Title;
                e.Html = n.Html;
                e.PlainText = n.PlainText;
                e.WordCount = n.WordCount;
                e.ContentQualityScore = n.ContentQualityScore;
                e.SourceStartPage = n.SourceStartPage;
                e.SourceEndPage = n.SourceEndPage;
            }
            await db.SaveChangesAsync(ct);

            var slugMap = new Dictionary<string, string?>();
            for (var i = 0; i < incoming.Count; i++)
                if (plan.Matches[i] >= 0 && oldSlugs[plan.Matches[i]] is { } old) slugMap[old] = final[i].Slug;
            foreach (var (j, i) in plan.Successors)
            {
                if (oldSlugs[j] is { } old) slugMap[old] = final[i].Slug;
                await RepointUserChapterAsync(db, existing[j].Id, final[i].Id, ct);
                db.UserChapters.Remove(existing[j]);
            }
            if (book.ProgressChapterSlug is { } p && slugMap.TryGetValue(p, out var moved))
                book.ProgressChapterSlug = moved;

            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            foreach (var c in existing.Concat(incoming)) db.UserChapters.Entry(c).State = EntityState.Detached;
            book.ProgressChapterSlug = oldProgressSlug;
            throw;
        }
    }

    /// <summary>
    /// Marks <paramref name="chapter"/> for deletion after moving its readers to
    /// <paramref name="successorId"/> (default: the nearest chapter before it, else after it).
    /// Required: progress/bookmark/note FKs are NO ACTION, so a bare delete of a chapter someone
    /// reads fails instead of silently taking their data with it. Call inside a transaction —
    /// the re-point runs immediately, the delete on the caller's SaveChanges.
    /// </summary>
    public static async Task RemoveEditionChapterAsync(
        IAppDbContext db, Chapter chapter, Guid? successorId, CancellationToken ct)
    {
        var from = chapter.Id;
        var to = successorId ?? await db.Chapters
            .Where(c => c.EditionId == chapter.EditionId && c.Id != from)
            .OrderBy(c => c.ChapterNumber < chapter.ChapterNumber ? 0 : 1)
            .ThenBy(c => c.ChapterNumber < chapter.ChapterNumber ? -c.ChapterNumber : c.ChapterNumber)
            .Select(c => (Guid?)c.Id)
            .FirstOrDefaultAsync(ct);

        if (to is { } t)
        {
            await db.ReadingProgresses.IgnoreQueryFilters().Where(x => x.ChapterId == from)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ChapterId, t), ct);
            await db.Bookmarks.IgnoreQueryFilters().Where(x => x.ChapterId == from)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ChapterId, t), ct);
            await db.Notes.IgnoreQueryFilters().Where(x => x.ChapterId == from)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ChapterId, t), ct);
            await db.Highlights.IgnoreQueryFilters().Where(x => x.ChapterId == from)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ChapterId, (Guid?)t), ct);
        }
        else
        {
            // The edition's last chapter: there is nowhere left to hold a position or a bookmark.
            await db.ReadingProgresses.IgnoreQueryFilters().Where(x => x.ChapterId == from).ExecuteDeleteAsync(ct);
            await db.Bookmarks.IgnoreQueryFilters().Where(x => x.ChapterId == from).ExecuteDeleteAsync(ct);
            await db.Notes.IgnoreQueryFilters().Where(x => x.ChapterId == from).ExecuteDeleteAsync(ct);
        }
        db.Chapters.Remove(chapter);
    }

    /// <summary>Upload counterpart of <see cref="RemoveEditionChapterAsync"/>; also moves the book's progress slug.</summary>
    public static async Task RemoveUserChapterAsync(
        IAppDbContext db, UserChapter chapter, Guid? successorId, CancellationToken ct)
    {
        var successor = await db.UserChapters
            .Where(c => c.UserBookId == chapter.UserBookId && c.Id != chapter.Id
                        && (successorId == null || c.Id == successorId))
            .OrderBy(c => c.ChapterNumber < chapter.ChapterNumber ? 0 : 1)
            .ThenBy(c => c.ChapterNumber < chapter.ChapterNumber ? -c.ChapterNumber : c.ChapterNumber)
            .Select(c => new { c.Id, c.Slug })
            .FirstOrDefaultAsync(ct);

        var (toId, toSlug) = (successor?.Id, successor?.Slug);
        await RepointUserChapterAsync(db, chapter.Id, toId, ct);
        if (chapter.Slug is not null)
            await db.UserBooks.Where(b => b.Id == chapter.UserBookId && b.ProgressChapterSlug == chapter.Slug)
                .ExecuteUpdateAsync(s => s.SetProperty(b => b.ProgressChapterSlug, toSlug), ct);
        db.UserChapters.Remove(chapter);
    }

    // Both FKs are SET NULL in the database; this keeps them pointing at real text instead.
    private static async Task RepointUserChapterAsync(IAppDbContext db, Guid from, Guid? to, CancellationToken ct)
    {
        await db.Highlights.IgnoreQueryFilters().Where(x => x.UserChapterId == from)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.UserChapterId, to), ct);
        await db.UserBookBookmarks.Where(x => x.ChapterId == from)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.ChapterId, to), ct);
    }
}
