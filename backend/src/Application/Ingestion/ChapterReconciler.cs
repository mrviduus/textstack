using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

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
/// <para>
/// <b>Positions name chapters by slug too</b> (progress locator <c>scroll:&lt;slug&gt;:&lt;px&gt;</c>,
/// position JSON <c>chapterSlug</c>, bookmark <c>chapter:&lt;slug&gt;</c>, insight
/// <c>ChapterSlug</c>), so keeping Ids is not enough: <see cref="SlugMoves"/> says where every old
/// slug went. A matched chapter keeps the in-chapter part (same chapter); a re-pointed one is reset to
/// the chapter start (the text there is different).
/// </para>
/// </summary>
public static class ChapterReconciler
{
    public readonly record struct Key(int Number, string? Slug, string Title);

    /// <param name="Matches">Per incoming chapter, the index of the existing chapter it replaces, or -1 (new).</param>
    /// <param name="Successors">Per existing chapter that matched nothing: (existing index, incoming index that inherits its readers).</param>
    public sealed record Result(int[] Matches, IReadOnlyList<(int Existing, int Incoming)> Successors);

    /// <summary>Where an old chapter slug went. <paramref name="Reset"/>: the readers were handed to a
    /// different chapter, so any in-chapter offset/anchor is meaningless there.</summary>
    public readonly record struct SlugMove(string To, bool Reset);

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
        IAppDbContext db, Guid editionId, IReadOnlyList<Chapter> incoming, CancellationToken ct, ILogger? logger = null)
    {
        var existing = await db.Chapters.Where(c => c.EditionId == editionId).ToListAsync(ct);
        if (incoming.Count == 0 && existing.Count > 0)
            throw new InvalidOperationException(
                "Extraction produced no chapters; keeping the existing ones and their readers.");

        var plan = Plan(
            existing.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList(),
            incoming.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList());
        var oldSlugs = existing.Select(c => c.Slug).ToArray();
        var final = new Chapter[incoming.Count];
        var undo = new List<Action>();

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

            var moves = SlugMoves(plan, oldSlugs, final.Select(c => c.Slug).ToList());
            if (moves.Count > 0)
            {
                // ponytail: loads every reader row of the edition; per-row SQL if editions get thousands.
                var progress = await db.ReadingProgresses.IgnoreQueryFilters()
                    .Where(x => x.EditionId == editionId).ToListAsync(ct);
                var bookmarks = await db.Bookmarks.IgnoreQueryFilters()
                    .Where(x => x.EditionId == editionId).ToListAsync(ct);
                undo.Add(() => Detach(db.ReadingProgresses, progress));
                undo.Add(() => Detach(db.Bookmarks, bookmarks));
                foreach (var p in progress)
                {
                    p.Locator = MoveLocator(p.Locator, moves);
                    p.PositionJson = MovePosition(p.PositionJson, moves);
                }
                foreach (var b in bookmarks) b.Locator = MoveLocator(b.Locator, moves);
                await MoveInsightsAsync(db, db.BookInsights.IgnoreQueryFilters().Where(x => x.EditionId == editionId),
                    moves, logger, undo, ct);
            }
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            foreach (var c in existing.Concat(incoming)) db.Chapters.Entry(c).State = EntityState.Detached;
            foreach (var u in undo) u();
            throw;
        }
    }

    /// <summary>Same as <see cref="ReconcileEditionAsync"/> for an upload; also moves the book's own progress.</summary>
    public static async Task ReconcileUserBookAsync(
        IAppDbContext db, UserBook book, IReadOnlyList<UserChapter> incoming, CancellationToken ct, ILogger? logger = null)
    {
        var existing = await db.UserChapters.Where(c => c.UserBookId == book.Id).ToListAsync(ct);
        if (incoming.Count == 0 && existing.Count > 0)
            throw new InvalidOperationException(
                "Extraction produced no chapters; keeping the existing ones and their readers.");

        var plan = Plan(
            existing.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList(),
            incoming.Select(c => new Key(c.ChapterNumber, c.Slug, c.Title)).ToList());
        var oldSlugs = existing.Select(c => c.Slug).ToArray();
        var (oldProgressSlug, oldLocator, oldPosition) =
            (book.ProgressChapterSlug, book.ProgressLocator, book.ProgressPositionJson);
        var final = new UserChapter[incoming.Count];
        var undo = new List<Action>();

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

            foreach (var (j, i) in plan.Successors)
            {
                await RepointUserChapterAsync(db, existing[j].Id, final[i].Id, ct);
                db.UserChapters.Remove(existing[j]);
            }

            var moves = SlugMoves(plan, oldSlugs, final.Select(c => c.Slug).ToList());
            if (moves.Count > 0)
            {
                if (book.ProgressChapterSlug is { } p && moves.TryGetValue(p, out var moved))
                    book.ProgressChapterSlug = moved.To;
                if (book.ProgressLocator is { } l) book.ProgressLocator = MoveLocator(l, moves);
                book.ProgressPositionJson = MovePosition(book.ProgressPositionJson, moves);

                var bookmarks = await db.UserBookBookmarks.Where(x => x.UserBookId == book.Id).ToListAsync(ct);
                undo.Add(() => Detach(db.UserBookBookmarks, bookmarks));
                foreach (var b in bookmarks) b.Locator = MoveLocator(b.Locator, moves);
                await MoveInsightsAsync(db, db.BookInsights.IgnoreQueryFilters().Where(x => x.UserBookId == book.Id),
                    moves, logger, undo, ct);
            }

            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            foreach (var c in existing.Concat(incoming)) db.UserChapters.Entry(c).State = EntityState.Detached;
            foreach (var u in undo) u();
            (book.ProgressChapterSlug, book.ProgressLocator, book.ProgressPositionJson) =
                (oldProgressSlug, oldLocator, oldPosition);
            throw;
        }
    }

    /// <summary>Old slug → where it went, for every chapter whose slug changed or whose readers moved.</summary>
    public static IReadOnlyDictionary<string, SlugMove> SlugMoves(
        Result plan, IReadOnlyList<string?> oldSlugs, IReadOnlyList<string?> newSlugs)
    {
        var moves = new Dictionary<string, SlugMove>(StringComparer.Ordinal);
        for (var i = 0; i < plan.Matches.Length; i++)
            if (plan.Matches[i] >= 0 && oldSlugs[plan.Matches[i]] is { } old && newSlugs[i] is { } to && old != to)
                moves[old] = new SlugMove(to, Reset: false);
        foreach (var (j, i) in plan.Successors)
            if (oldSlugs[j] is { } old && newSlugs[i] is { } to)
                moves[old] = new SlugMove(to, Reset: true);
        return moves;
    }

    /// <summary>
    /// <c>scroll:&lt;slug&gt;:&lt;offset&gt;</c> (offset kept, or 0 on a reset) and
    /// <c>chapter:&lt;slug&gt;</c> with the slug moved; anything else (<c>page:N</c>, the end/start
    /// sentinels, an unknown slug) unchanged. Parsed from the right like the client's
    /// <c>parseScrollLocator</c>.
    /// </summary>
    public static string MoveLocator(string locator, IReadOnlyDictionary<string, SlugMove> moves)
    {
        const string chapter = "chapter:", scroll = "scroll:";
        if (locator.StartsWith(chapter, StringComparison.Ordinal))
            return moves.TryGetValue(locator[chapter.Length..], out var c) ? chapter + c.To : locator;
        var lastColon = locator.LastIndexOf(':');
        if (!locator.StartsWith(scroll, StringComparison.Ordinal) || lastColon < scroll.Length)
            return locator;
        if (!moves.TryGetValue(locator[scroll.Length..lastColon], out var m))
            return locator;
        return $"{scroll}{m.To}:{(m.Reset ? "0" : locator[(lastColon + 1)..])}";
    }

    private static readonly JsonSerializerOptions RelaxedJson = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>
    /// The text-anchor position (ADR-015) with its <c>chapterSlug</c> moved, anchor kept; <c>null</c>
    /// on a reset (the anchor quotes text that chapter does not have — the locator says "start").
    /// Anything unparseable or naming an unmoved chapter is returned as is.
    /// </summary>
    public static string? MovePosition(string? positionJson, IReadOnlyDictionary<string, SlugMove> moves)
    {
        if (string.IsNullOrWhiteSpace(positionJson)) return positionJson;
        JsonNode? root;
        try { root = JsonNode.Parse(positionJson); }
        catch (JsonException) { return positionJson; }
        if (root is not JsonObject obj
            || obj["chapterSlug"] is not JsonValue v
            || !v.TryGetValue<string>(out var slug)
            || !moves.TryGetValue(slug, out var m))
            return positionJson;
        if (m.Reset) return null;
        obj["chapterSlug"] = m.To;
        return obj.ToJsonString(RelaxedJson);
    }

    /// <summary>Longest <c>BookInsight.ChapterSlug</c> the column takes.</summary>
    private const int MaxInsightSlugLength = 300;

    /// <summary>
    /// Which insights move to which slug. One insight per (user, book, chapter) is a unique key.
    /// <list type="number">
    /// <item>A removed chapter's insight first VACATES its old slug — a positional slug
    /// (<c>2-chapter</c>) can be reused by another chapter, and the old conclusion must neither show
    /// up on that chapter nor block the insight genuinely moving there.</item>
    /// <item>A matched chapter's insight moves with its slug. A move onto a slug the user already
    /// holds is skipped and reported — and that insight staying put can block the next move, hence
    /// the loop.</item>
    /// <item>Last, a removed chapter's insight goes where its readers went (the neighbour now holds
    /// that text) if the user has nothing there; otherwise it is parked on
    /// <c>~orphan:&lt;old slug&gt;</c> (or <c>~orphan:&lt;id&gt;</c> if that is taken too). Parked,
    /// not deleted: no chapter shows it, but the reader's conclusion still exists and is reachable
    /// through the book-wide insight list.</item>
    /// </list>
    /// Caller passes one book's insights.
    /// </summary>
    public static IReadOnlyList<(BookInsight Insight, string To)> InsightMoves(
        IReadOnlyList<BookInsight> insights, IReadOnlyDictionary<string, SlugMove> moves,
        Action<BookInsight, string> onCollision)
    {
        var target = insights.Select(i =>
            i.ChapterSlug is { } s && moves.TryGetValue(s, out var m) && !m.Reset ? m.To : i.ChapterSlug).ToArray();
        var removed = Enumerable.Range(0, insights.Count)
            .Where(k => insights[k].ChapterSlug is { } s && moves.TryGetValue(s, out var m) && m.Reset)
            .ToHashSet();
        var placed = Enumerable.Range(0, insights.Count).Where(k => !removed.Contains(k)).ToList();
        bool skipped;
        do
        {
            skipped = false;
            var collisions = placed
                .GroupBy(k => (insights[k].UserId, target[k]))
                .Where(g => g.Count() > 1)
                .ToList();
            foreach (var group in collisions)
            {
                var movers = group.Where(k => target[k] != insights[k].ChapterSlug).ToList();
                // Someone already sits there: every mover yields. Otherwise the first mover keeps it.
                foreach (var k in movers.Count < group.Count() ? movers : movers.Skip(1))
                {
                    onCollision(insights[k], target[k]!);
                    target[k] = insights[k].ChapterSlug;
                    skipped = true;
                }
            }
        } while (skipped);

        var taken = placed.Select(k => (insights[k].UserId, target[k])).ToHashSet();
        foreach (var k in removed.Order())
        {
            var (user, old) = (insights[k].UserId, insights[k].ChapterSlug!);
            var to = moves[old].To;
            if (taken.Contains((user, to)))
            {
                onCollision(insights[k], to);
                to = $"~orphan:{old}";
                if (to.Length > MaxInsightSlugLength || taken.Contains((user, to)))
                    to = $"~orphan:{insights[k].Id:N}";
            }
            taken.Add((user, to));
            target[k] = to;
        }

        return Enumerable.Range(0, insights.Count)
            .Where(k => target[k] != insights[k].ChapterSlug)
            .Select(k => (insights[k], target[k]!))
            .ToList();
    }

    private static async Task MoveInsightsAsync(
        IAppDbContext db, IQueryable<BookInsight> bookInsights, IReadOnlyDictionary<string, SlugMove> moves,
        ILogger? logger, List<Action> undo, CancellationToken ct)
    {
        var insights = await bookInsights.Where(x => x.ChapterSlug != null).ToListAsync(ct);
        undo.Add(() => Detach(db.BookInsights, insights));
        var moved = InsightMoves(insights, moves, (i, to) => logger?.LogWarning(
            "Re-ingest: insight {InsightId} on chapter {From} cannot move to {To}; the user already has one there",
            i.Id, i.ChapterSlug, to));
        if (moved.Count == 0) return;

        // Park first: the unique key is checked per row, and one insight may take another's old slug.
        foreach (var (i, _) in moved) i.ChapterSlug = $"~{i.Id:N}";
        await db.SaveChangesAsync(ct);
        foreach (var (i, to) in moved) i.ChapterSlug = to;
    }

    private static void Detach<T>(DbSet<T> set, IEnumerable<T> rows) where T : class
    {
        foreach (var r in rows) set.Entry(r).State = EntityState.Detached;
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
