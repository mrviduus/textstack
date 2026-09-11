using Api.Extensions;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Contracts.Insights;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

/// <summary>
/// Insights — the conclusions an outside assistant writes back into a book.
///
/// <para>The reasoning happens in Claude or ChatGPT, where the reader already has their profile and
/// their history. What comes home is the result, and it lands on the book's spine: a chapter slug, or
/// null for the whole book. See <see cref="BookInsight"/> for why a catalog beats a transcript and
/// why the key is a slug.</para>
///
/// <list type="bullet">
///   <item><c>GET  /me/insights?userBookId=…</c> or <c>?editionId=…</c> — everything already worked
///   out about that book, in reading order, with each chapter slug resolved to its number and title
///   so the client can lay it out.</item>
///   <item><c>POST /me/insights</c> — save one. An existing insight for the same
///   (user, book, chapter) is REPLACED, so running the pass again refreshes the конспект rather than
///   duplicating it.</item>
///   <item><c>DELETE /me/insights/{id}</c> — remove one. <b>The reader's, and only the reader's.</b>
///   Replacing covers the common miss (a poor conclusion about the RIGHT chapter — the model re-runs
///   and overwrites its own row), but not the one that matters: a conclusion filed against the WRONG
///   chapter. Nothing revisits that slot, and until now nothing could remove it. Deliberately NOT
///   mirrored as an MCP tool: <c>save_insight</c>'s worst case is one bad paragraph the reader
///   removes in a tap, while a delete tool's worst case is a year of конспект gone, driven by a
///   stateless bridge that cannot confirm intent and against a table with no soft-delete and no
///   trash. The asymmetry is categorical, not a matter of degree.</item>
/// </list>
///
/// <para>One flat group rather than a user-book route plus a catalog twin, because the entity's
/// edition/user-book XOR is the same distinction the route prefix would encode, and encoding it twice
/// is how the two halves drift.</para>
/// </summary>
public static class InsightsEndpoints
{
    /// <summary>
    /// Cap on one insight's Markdown. Generous for a chapter's worth of conclusions and small enough
    /// that a caller pasting a chapter back at us cannot turn the table into a document store.
    /// </summary>
    public const int MaxTextLength = 20_000;

    public static void MapInsightsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/insights").WithTags("Insights");

        group.MapGet("", GetInsights).WithName("GetInsights");
        group.MapPost("", SaveInsight).WithName("SaveInsight")
            .RequireRateLimiting("insights");
        group.MapDelete("/{id:guid}", DeleteInsight).WithName("DeleteInsight");
    }

    private static async Task<IResult> GetInsights(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] Guid? userBookId,
        [FromQuery] Guid? editionId,
        CancellationToken ct = default)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        if (userBookId.HasValue == editionId.HasValue)
            return Results.BadRequest("Provide exactly one of userBookId or editionId");

        // Resolve the book before reading. The query below filters by user_id, so a
        // stranger's book leaks nothing either way — but it answers with an empty
        // list, and an empty list is a TRUTHFUL answer to "what have I worked out
        // about this book". Collapsing "not your book" into it lets a wrong id read
        // as a book you have never discussed. Same reason
        // GET /me/highlights/userbook/{id} checks ownership first.
        if (userBookId is { } bookId)
        {
            var owns = await db.UserBooks.AnyAsync(b => b.Id == bookId && b.UserId == userId.Value, ct);
            if (!owns) return Results.NotFound("User book not found");
        }
        else
        {
            var exists = await db.Editions.AnyAsync(e => e.Id == editionId!.Value, ct);
            if (!exists) return Results.NotFound("Edition not found");
        }

        var rows = await db.BookInsights
            .Where(i => i.UserId == userId.Value
                && (userBookId.HasValue ? i.UserBookId == userBookId : i.EditionId == editionId))
            .ToListAsync(ct);

        if (rows.Count == 0) return Results.Ok(Array.Empty<BookInsightDto>());

        // Resolve slugs to chapter number + title in ONE query, so the client can order by reading
        // position. Done at read time rather than stored: a re-ingestion renumbers chapters, and a
        // number frozen at write time would quietly point at the wrong one.
        var slugs = rows.Where(r => r.ChapterSlug != null).Select(r => r.ChapterSlug!).Distinct().ToList();
        var chapters = new Dictionary<string, (int Number, string Title)>(StringComparer.Ordinal);
        if (slugs.Count > 0)
        {
            if (userBookId.HasValue)
            {
                var found = await db.UserChapters
                    .Where(c => c.UserBookId == userBookId.Value && c.Slug != null && slugs.Contains(c.Slug))
                    .Select(c => new { c.Slug, c.ChapterNumber, c.Title })
                    .ToListAsync(ct);
                foreach (var c in found) chapters[c.Slug!] = (c.ChapterNumber, c.Title);
            }
            else
            {
                var found = await db.Chapters
                    .Where(c => c.EditionId == editionId!.Value && c.Slug != null && slugs.Contains(c.Slug))
                    .Select(c => new { c.Slug, c.ChapterNumber, c.Title })
                    .ToListAsync(ct);
                foreach (var c in found) chapters[c.Slug!] = (c.ChapterNumber, c.Title);
            }
        }

        var dtos = rows
            .Select(r =>
            {
                var resolved = r.ChapterSlug is { } s && chapters.TryGetValue(s, out var c)
                    ? c
                    : ((int Number, string Title)?)null;
                return new BookInsightDto(
                    r.Id, r.EditionId, r.UserBookId, r.ChapterSlug,
                    resolved?.Number, resolved?.Title,
                    r.Text, r.Question, r.Source, r.CreatedAt, r.UpdatedAt);
            })
            // Reading order: the book-level overview first, then chapters by number. An insight whose
            // slug no longer resolves keeps its text and sorts to the end rather than vanishing.
            .OrderBy(d => d.ChapterSlug == null ? 0 : 1)
            .ThenBy(d => d.ChapterNumber ?? int.MaxValue)
            .ThenBy(d => d.CreatedAt)
            .ToList();

        return Results.Ok(dtos);
    }

    private static async Task<IResult> SaveInsight(
        [FromBody] SaveInsightRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        if (request.UserBookId.HasValue == request.EditionId.HasValue)
            return Results.BadRequest("Provide exactly one of userBookId or editionId");

        if (string.IsNullOrWhiteSpace(request.Text))
            return Results.BadRequest("Text is required");
        if (request.Text.Length > MaxTextLength)
            return Results.BadRequest($"Text must be at most {MaxTextLength} characters");

        // Normalize "" → null so a caller that means "about the whole book" cannot end up with two
        // different book-level rows, one keyed on null and one on the empty string.
        var chapterSlug = string.IsNullOrWhiteSpace(request.ChapterSlug) ? null : request.ChapterSlug.Trim();
        if (chapterSlug is { Length: > 300 })
            return Results.BadRequest("ChapterSlug must be at most 300 characters");

        if (request.UserBookId is { } bookId)
        {
            var owns = await db.UserBooks.AnyAsync(b => b.Id == bookId && b.UserId == userId.Value, ct);
            if (!owns) return Results.NotFound("User book not found");

            // A slug that names no chapter is refused. The insight would still be readable, but it
            // would never place in the конспект — and the usual cause is a hallucinated slug, which
            // is worth telling the caller about while it can still fix it.
            if (chapterSlug is not null)
            {
                var chapterExists = await db.UserChapters
                    .AnyAsync(c => c.UserBookId == bookId && c.Slug == chapterSlug, ct);
                if (!chapterExists) return Results.NotFound($"No chapter '{chapterSlug}' in this book");
            }
        }
        else
        {
            var editionId = request.EditionId!.Value;
            var exists = await db.Editions.AnyAsync(e => e.Id == editionId, ct);
            if (!exists) return Results.NotFound("Edition not found");

            if (chapterSlug is not null)
            {
                var chapterExists = await db.Chapters
                    .AnyAsync(c => c.EditionId == editionId && c.Slug == chapterSlug, ct);
                if (!chapterExists) return Results.NotFound($"No chapter '{chapterSlug}' in this book");
            }
        }

        var now = DateTimeOffset.UtcNow;

        // Upsert: one insight per (user, book, chapter). See BookInsight for why replace, not append.
        var existing = await db.BookInsights.FirstOrDefaultAsync(
            i => i.UserId == userId.Value
                && i.UserBookId == request.UserBookId
                && i.EditionId == request.EditionId
                && i.ChapterSlug == chapterSlug,
            ct);

        if (existing is not null)
        {
            existing.Text = request.Text;
            existing.Question = request.Question;
            existing.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToDto(existing));
        }

        var insight = new BookInsight
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = httpContext.GetSiteId(),
            EditionId = request.EditionId,
            UserBookId = request.UserBookId,
            ChapterSlug = chapterSlug,
            Text = request.Text,
            Question = request.Question,
            Source = "mcp",
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.BookInsights.Add(insight);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/me/insights/{insight.Id}", ToDto(insight));
    }

    /// <summary>
    /// Remove one insight. 404 — never 403 — when the row belongs to someone else, so the endpoint
    /// cannot be used to learn that an id exists.
    /// </summary>
    private static async Task<IResult> DeleteInsight(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct = default)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var insight = await db.BookInsights
            .FirstOrDefaultAsync(i => i.Id == id && i.UserId == userId.Value, ct);

        if (insight is null) return Results.NotFound();

        // Hard delete, matching the entity's stated posture: a конспект, not a log. A soft-delete
        // column would also have to enter both partial unique index filters, which is where the
        // NULLS NOT DISTINCT rule that protects the book-level row lives.
        db.BookInsights.Remove(insight);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    private static BookInsightDto ToDto(BookInsight i) => new(
        i.Id, i.EditionId, i.UserBookId, i.ChapterSlug, null, null,
        i.Text, i.Question, i.Source, i.CreatedAt, i.UpdatedAt);
}
