using Application.Common.Interfaces;
using Application.Ingestion;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using static TextStack.Extraction.Utilities.HtmlCleaner;

namespace Api.Endpoints;

/// <summary>Docker-network only: <see cref="Api.Middleware.PathGates"/> refuses /internal/* from anywhere else (ADR-024).</summary>
public static class InternalEndpoints
{
    public static void MapInternalEndpoints(this WebApplication app)
    {
        // Chapter CRUD for quality validation (user books)
        app.MapGet("/internal/user-books/{id:guid}/chapters", GetUserBookChapters).ExcludeFromDescription();
        app.MapGet("/internal/user-books/{id:guid}/chapters/{n:int}/content", GetUserBookChapterContent).ExcludeFromDescription();
        app.MapPut("/internal/user-books/{id:guid}/chapters/{n:int}", UpdateUserBookChapter).ExcludeFromDescription();
        app.MapDelete("/internal/user-books/{id:guid}/chapters/{n:int}", DeleteUserBookChapter).ExcludeFromDescription();
        app.MapPost("/internal/user-books/{id:guid}/chapters/merge", MergeUserBookChapters).ExcludeFromDescription();
    }

    /// <summary>
    /// Safety rail for the quality pipeline's delete fix: it exists to drop
    /// FRAGMENT/EMPTY chapters (title pages, blank stubs), never real content.
    /// A substantial chapter must not be deletable through this path — the
    /// Ivan-Ilyich incident deleted a 2 510-word chapter via a shifted number.
    /// </summary>
    internal const int QualityDeleteMaxWords = 300;

    // ── User Book Chapters ──

    private static async Task<IResult> GetUserBookChapters(
        Guid id, IAppDbContext db, CancellationToken ct)
    {
        var chapters = await db.UserChapters
            .Where(c => c.UserBookId == id)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.WordCount })
            .ToListAsync(ct);

        return Results.Ok(chapters);
    }

    private static async Task<IResult> GetUserBookChapterContent(
        Guid id, int n, IAppDbContext db, CancellationToken ct)
    {
        var ch = await db.UserChapters
            .Where(c => c.UserBookId == id && c.ChapterNumber == n)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.Html, c.PlainText, c.WordCount })
            .FirstOrDefaultAsync(ct);

        return ch is null ? Results.NotFound() : Results.Ok(ch);
    }

    private static async Task<IResult> UpdateUserBookChapter(
        Guid id, int n, [FromBody] UpdateInternalChapterRequest req,
        IAppDbContext db, CancellationToken ct)
    {
        var ch = await db.UserChapters.FirstOrDefaultAsync(c => c.UserBookId == id && c.ChapterNumber == n, ct);
        if (ch is null) return Results.NotFound();

        if (req.Title is not null) ch.Title = req.Title;
        if (req.Html is not null)
        {
            ch.Html = req.Html;
            ch.PlainText = StripHtml(req.Html);
            ch.WordCount = CountWords(ch.PlainText);
        }

        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> DeleteUserBookChapter(
        Guid id, int n, IAppDbContext db, IInsightRepository insights, CancellationToken ct)
    {
        var ch = await db.UserChapters.FirstOrDefaultAsync(c => c.UserBookId == id && c.ChapterNumber == n, ct);
        if (ch is null) return Results.NotFound();

        if (ch.WordCount is > QualityDeleteMaxWords)
            return Results.Conflict(new
            {
                error = $"Refusing to delete chapter {n}: {ch.WordCount} words exceeds the " +
                        $"quality-delete cap ({QualityDeleteMaxWords}). Substantial chapters are not deletable via the quality pipeline."
            });

        await using var tx = await db.BeginTransactionAsync(ct);
        var before = await ChapterReconciler.SnapshotUserBookAsync(db, id, ct);
        var successor = await ChapterReconciler.RemoveUserChapterAsync(db, ch, null, ct);

        var remaining = await db.UserChapters
            .Where(c => c.UserBookId == id && c.ChapterNumber > n)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        foreach (var r in remaining)
            r.ChapterNumber--;

        await db.SaveChangesAsync(ct);
        await ChapterReconciler.MoveUserBookPositionsAfterRemovalAsync(db, insights, tx, id, before,
            new Dictionary<Guid, Guid?> { [ch.Id] = successor }, null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> MergeUserBookChapters(
        Guid id, [FromBody] MergeChaptersRequest req,
        IAppDbContext db, IInsightRepository insights, CancellationToken ct)
    {
        if (req.ChapterNumbers is not { Count: >= 2 })
            return Results.BadRequest(new { error = "At least 2 chapter numbers required" });

        var nums = req.ChapterNumbers.OrderBy(x => x).ToList();
        var chapters = await db.UserChapters
            .Where(c => c.UserBookId == id && nums.Contains(c.ChapterNumber))
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        if (chapters.Count != nums.Count)
            return Results.BadRequest(new { error = "Some chapters not found" });

        var first = chapters[0];
        var mergedHtml = string.Join("\n", chapters.Select(c => c.Html));
        first.Html = mergedHtml;
        first.PlainText = StripHtml(mergedHtml);
        first.WordCount = CountWords(first.PlainText);

        await using var tx = await db.BeginTransactionAsync(ct);
        var before = await ChapterReconciler.SnapshotUserBookAsync(db, id, ct);
        for (var i = 1; i < chapters.Count; i++)
            await ChapterReconciler.RemoveUserChapterAsync(db, chapters[i], first.Id, ct);

        var maxMerged = nums.Max();
        var remaining = await db.UserChapters
            .Where(c => c.UserBookId == id && c.ChapterNumber > maxMerged)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        var shift = nums.Count - 1;
        foreach (var r in remaining)
            r.ChapterNumber -= shift;

        await db.SaveChangesAsync(ct);
        await ChapterReconciler.MoveUserBookPositionsAfterRemovalAsync(db, insights, tx, id, before,
            chapters.Skip(1).ToDictionary(c => c.Id, _ => (Guid?)first.Id), null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok(new { mergedInto = first.ChapterNumber });
    }
}

public record UpdateInternalChapterRequest(string? Title = null, string? Html = null);
public record MergeChaptersRequest(List<int> ChapterNumbers);
