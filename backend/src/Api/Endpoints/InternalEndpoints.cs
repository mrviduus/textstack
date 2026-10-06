using Api.Extensions;
using System.Net;
using System.Text.RegularExpressions;
using Application.Admin;
using Application.Books;
using Application.Common.Interfaces;
using Application.Ingestion;
using Application.SsgRebuild;
using Contracts.Admin;
using Contracts.Books;
using Domain.Entities;
using Domain.Enums;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using static TextStack.Extraction.Utilities.HtmlCleaner;

namespace Api.Endpoints;

public static class InternalEndpoints
{
    public static void MapInternalEndpoints(this WebApplication app)
    {
        app.MapPost("/internal/ssg/rebuild-all", RebuildAll)
            .WithName("InternalSsgRebuildAll")
            .ExcludeFromDescription();

        app.MapPost("/internal/editions/{id:guid}/publish", PublishEdition)
            .WithName("InternalPublishEdition")
            .ExcludeFromDescription();

        app.MapPut("/internal/featured", ReplaceFeatured)
            .WithName("InternalReplaceFeatured")
            .ExcludeFromDescription();

        // Chapter CRUD for quality validation (editions)
        app.MapGet("/internal/editions/{id:guid}/chapters", GetEditionChapters).ExcludeFromDescription();
        app.MapGet("/internal/editions/{id:guid}/chapters/{n:int}/content", GetEditionChapterContent).ExcludeFromDescription();
        app.MapPut("/internal/editions/{id:guid}/chapters/{n:int}", UpdateEditionChapter).ExcludeFromDescription();
        app.MapDelete("/internal/editions/{id:guid}/chapters/{n:int}", DeleteEditionChapter).ExcludeFromDescription();
        app.MapPost("/internal/editions/{id:guid}/chapters/merge", MergeEditionChapters).ExcludeFromDescription();

        // Chapter CRUD for quality validation (user books)
        app.MapGet("/internal/user-books/{id:guid}/chapters", GetUserBookChapters).ExcludeFromDescription();
        app.MapGet("/internal/user-books/{id:guid}/chapters/{n:int}/content", GetUserBookChapterContent).ExcludeFromDescription();
        app.MapPut("/internal/user-books/{id:guid}/chapters/{n:int}", UpdateUserBookChapter).ExcludeFromDescription();
        app.MapDelete("/internal/user-books/{id:guid}/chapters/{n:int}", DeleteUserBookChapter).ExcludeFromDescription();
        app.MapPost("/internal/user-books/{id:guid}/chapters/merge", MergeUserBookChapters).ExcludeFromDescription();

        // Quality job status
        app.MapGet("/internal/quality-jobs/{id:guid}", GetQualityJob).ExcludeFromDescription();
        app.MapPut("/internal/quality-jobs/{id:guid}", UpdateQualityJob).ExcludeFromDescription();
    }

    // ── SSG / Publish ──

    private static async Task<IResult> RebuildAll(
        HttpContext ctx,
        IAppDbContext db,
        ISsgJobService ssgService,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx))
            return Results.StatusCode(403);

        var site = await db.Sites.FirstOrDefaultAsync(ct);
        if (site is null)
            return Results.BadRequest(new { error = "No site found" });

        var job = await ssgService.EnqueueSsgRebuildAsync(
            new CreateSsgRebuildJobRequest(site.Id, "Full", Concurrency: 4),
            ct);

        return job is not null
            ? Results.Ok(new { jobId = job.Id, status = "queued" })
            : Results.Ok(new { status = "skipped", reason = "rebuild already in progress" });
    }

    private static async Task<IResult> PublishEdition(
        Guid id,
        HttpContext ctx,
        AdminService adminService,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx))
            return Results.StatusCode(403);

        var (success, error) = await adminService.PublishEditionAsync(id, ct);
        return success ? Results.Ok() : Results.BadRequest(new { error });
    }

    internal const int MaxFeatured = 999;

    private static async Task<IResult> ReplaceFeatured(
        [FromBody] ReplaceFeaturedRequest req,
        HttpContext ctx,
        BookService bookService,
        IAppDbContext db,
        ISsgJobService ssgService,
        CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx))
            return Results.StatusCode(403);
        // Empty list would silently wipe the shelf — refuse; clear ranks in admin instead.
        if (req.Slugs is not { Count: > 0 })
            return Results.BadRequest(new { error = "slugs must be a non-empty array" });
        if (req.Slugs.Count > MaxFeatured)
            return Results.BadRequest(new { error = $"At most {MaxFeatured} slugs" });

        var result = await bookService.ReplaceFeaturedAsync(req.Slugs, ct);

        // Home + /books are static routes, which only a Full rebuild re-renders.
        var site = await db.Sites.FirstOrDefaultAsync(ct);
        string ssg = "skipped";
        if (site is not null)
        {
            try
            {
                var job = await ssgService.EnqueueSsgRebuildAsync(
                    new CreateSsgRebuildJobRequest(site.Id, "Full", Concurrency: 2), ct);
                ssg = job is not null ? "queued" : "already-in-progress";
            }
            catch
            {
                // SSG failure must not undo or fail the shelf change.
                ssg = "failed";
            }
        }

        return Results.Ok(new { applied = result.Applied, notFound = result.NotFound, ssg });
    }

    // ── Edition Chapters ──

    private static async Task<IResult> GetEditionChapters(
        Guid id, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var chapters = await db.Chapters
            .Where(c => c.EditionId == id)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.WordCount })
            .ToListAsync(ct);

        return Results.Ok(chapters);
    }

    private static async Task<IResult> GetEditionChapterContent(
        Guid id, int n, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var ch = await db.Chapters
            .Where(c => c.EditionId == id && c.ChapterNumber == n)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.Html, c.PlainText, c.WordCount })
            .FirstOrDefaultAsync(ct);

        return ch is null ? Results.NotFound() : Results.Ok(ch);
    }

    private static async Task<IResult> UpdateEditionChapter(
        Guid id, int n, [FromBody] UpdateInternalChapterRequest req,
        HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var ch = await db.Chapters.FirstOrDefaultAsync(c => c.EditionId == id && c.ChapterNumber == n, ct);
        if (ch is null) return Results.NotFound();

        if (req.Title is not null) ch.Title = req.Title;
        if (req.Html is not null)
        {
            ch.Html = req.Html;
            ch.PlainText = StripHtml(req.Html);
            ch.WordCount = CountWords(ch.PlainText);
        }
        ch.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }

    /// <summary>
    /// Safety rail for the quality pipeline's delete fix: it exists to drop
    /// FRAGMENT/EMPTY chapters (title pages, blank stubs), never real content.
    /// A substantial chapter must not be deletable through this path — the
    /// Ivan-Ilyich incident deleted a 2 510-word chapter via a shifted number.
    /// </summary>
    internal const int QualityDeleteMaxWords = 300;

    private static async Task<IResult> DeleteEditionChapter(
        Guid id, int n, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var ch = await db.Chapters.FirstOrDefaultAsync(c => c.EditionId == id && c.ChapterNumber == n, ct);
        if (ch is null) return Results.NotFound();

        if (ch.WordCount is > QualityDeleteMaxWords)
            return Results.Conflict(new
            {
                error = $"Refusing to delete chapter {n}: {ch.WordCount} words exceeds the " +
                        $"quality-delete cap ({QualityDeleteMaxWords}). Substantial chapters are not deletable via the quality pipeline."
            });

        await using var tx = await db.BeginTransactionAsync(ct);
        var before = await ChapterReconciler.SnapshotEditionAsync(db, id, ct);
        var successor = await ChapterReconciler.RemoveEditionChapterAsync(db, ch, null, ct);

        var remaining = await db.Chapters
            .Where(c => c.EditionId == id && c.ChapterNumber > n)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        foreach (var r in remaining)
        {
            r.ChapterNumber--;
            r.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        await ChapterReconciler.MoveEditionPositionsAfterRemovalAsync(db, id, before,
            new Dictionary<Guid, Guid?> { [ch.Id] = successor }, null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> MergeEditionChapters(
        Guid id, [FromBody] MergeChaptersRequest req,
        HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
        if (req.ChapterNumbers is not { Count: >= 2 })
            return Results.BadRequest(new { error = "At least 2 chapter numbers required" });

        var nums = req.ChapterNumbers.OrderBy(x => x).ToList();
        var chapters = await db.Chapters
            .Where(c => c.EditionId == id && nums.Contains(c.ChapterNumber))
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        if (chapters.Count != nums.Count)
            return Results.BadRequest(new { error = "Some chapters not found" });

        // Merge HTML into first chapter
        var first = chapters[0];
        var mergedHtml = string.Join("\n", chapters.Select(c => c.Html));
        first.Html = mergedHtml;
        first.PlainText = StripHtml(mergedHtml);
        first.WordCount = CountWords(first.PlainText);
        first.UpdatedAt = DateTimeOffset.UtcNow;

        // Remove other chapters; their readers move to the chapter their text now lives in.
        await using var tx = await db.BeginTransactionAsync(ct);
        var before = await ChapterReconciler.SnapshotEditionAsync(db, id, ct);
        for (var i = 1; i < chapters.Count; i++)
            await ChapterReconciler.RemoveEditionChapterAsync(db, chapters[i], first.Id, ct);

        // Renumber remaining
        var maxMerged = nums.Max();
        var remaining = await db.Chapters
            .Where(c => c.EditionId == id && c.ChapterNumber > maxMerged)
            .OrderBy(c => c.ChapterNumber)
            .ToListAsync(ct);

        var shift = nums.Count - 1;
        foreach (var r in remaining)
        {
            r.ChapterNumber -= shift;
            r.UpdatedAt = DateTimeOffset.UtcNow;
        }

        await db.SaveChangesAsync(ct);
        await ChapterReconciler.MoveEditionPositionsAfterRemovalAsync(db, id, before,
            chapters.Skip(1).ToDictionary(c => c.Id, _ => (Guid?)first.Id), null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok(new { mergedInto = first.ChapterNumber });
    }

    // ── User Book Chapters ──

    private static async Task<IResult> GetUserBookChapters(
        Guid id, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var chapters = await db.UserChapters
            .Where(c => c.UserBookId == id)
            .OrderBy(c => c.ChapterNumber)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.WordCount })
            .ToListAsync(ct);

        return Results.Ok(chapters);
    }

    private static async Task<IResult> GetUserBookChapterContent(
        Guid id, int n, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var ch = await db.UserChapters
            .Where(c => c.UserBookId == id && c.ChapterNumber == n)
            .Select(c => new { c.Id, c.ChapterNumber, c.Title, c.Html, c.PlainText, c.WordCount })
            .FirstOrDefaultAsync(ct);

        return ch is null ? Results.NotFound() : Results.Ok(ch);
    }

    private static async Task<IResult> UpdateUserBookChapter(
        Guid id, int n, [FromBody] UpdateInternalChapterRequest req,
        HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

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
        Guid id, int n, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

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
        await ChapterReconciler.MoveUserBookPositionsAfterRemovalAsync(db, id, before,
            new Dictionary<Guid, Guid?> { [ch.Id] = successor }, null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok();
    }

    private static async Task<IResult> MergeUserBookChapters(
        Guid id, [FromBody] MergeChaptersRequest req,
        HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);
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
        await ChapterReconciler.MoveUserBookPositionsAfterRemovalAsync(db, id, before,
            chapters.Skip(1).ToDictionary(c => c.Id, _ => (Guid?)first.Id), null, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return Results.Ok(new { mergedInto = first.ChapterNumber });
    }

    // ── Quality Jobs ──

    private static async Task<IResult> GetQualityJob(
        Guid id, HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var job = await db.BookQualityJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        return Results.Ok(new
        {
            job.Id,
            job.EditionId,
            job.UserBookId,
            Status = (int)job.Status,
            job.IssuesJson,
            job.IssuesFound,
            job.IssuesFixed,
            job.ContentChaptersCleaned,
            job.ContentChaptersRejected,
            job.ContentChaptersSkipped,
            job.Error,
            job.LogOutput,
            job.CreatedAt,
            job.StartedAt,
            job.FinishedAt,
        });
    }

    private static async Task<IResult> UpdateQualityJob(
        Guid id, [FromBody] UpdateQualityJobRequest req,
        HttpContext ctx, IAppDbContext db, CancellationToken ct)
    {
        if (!InternalNetwork.IsLocalRequest(ctx)) return Results.StatusCode(403);

        var job = await db.BookQualityJobs.FirstOrDefaultAsync(j => j.Id == id, ct);
        if (job is null) return Results.NotFound();

        if (req.Status.HasValue) job.Status = (BookQualityJobStatus)req.Status.Value;
        if (req.IssuesJson is not null) job.IssuesJson = req.IssuesJson;
        if (req.IssuesFound.HasValue) job.IssuesFound = req.IssuesFound;
        if (req.IssuesFixed.HasValue) job.IssuesFixed = req.IssuesFixed;
        if (req.Error is not null) job.Error = req.Error;
        if (req.LogOutput is not null) job.LogOutput = req.LogOutput;
        if (req.ContentChaptersCleaned.HasValue) job.ContentChaptersCleaned = req.ContentChaptersCleaned;
        if (req.ContentChaptersRejected.HasValue) job.ContentChaptersRejected = req.ContentChaptersRejected;
        if (req.ContentChaptersSkipped.HasValue) job.ContentChaptersSkipped = req.ContentChaptersSkipped;
        if (req.SetStartedAt) job.StartedAt = DateTimeOffset.UtcNow;
        if (req.SetFinishedAt) job.FinishedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);
        return Results.Ok();
    }
}

public record UpdateInternalChapterRequest(string? Title = null, string? Html = null);
public record MergeChaptersRequest(List<int> ChapterNumbers);
public record UpdateQualityJobRequest(
    int? Status = null,
    string? IssuesJson = null,
    int? IssuesFound = null,
    int? IssuesFixed = null,
    string? Error = null,
    string? LogOutput = null,
    int? ContentChaptersCleaned = null,
    int? ContentChaptersRejected = null,
    int? ContentChaptersSkipped = null,
    bool SetStartedAt = false,
    bool SetFinishedAt = false);
