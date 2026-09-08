using System.Text.Json;
using Api.Extensions;
using Api.Mapping;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class HighlightsEndpoints
{
    public static void MapHighlightsEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/highlights").WithTags("Highlights");

        group.MapGet("/all", GetAllHighlights).WithName("GetAllHighlights");
        group.MapGet("/review", GetHighlightsForReview).WithName("GetHighlightsForReview");
        group.MapPost("/review", MarkHighlightReviewed).WithName("MarkHighlightReviewed");
        group.MapGet("/userbook/{userBookId:guid}", GetUserBookHighlights).WithName("GetUserBookHighlights");
        group.MapGet("/{editionId:guid}", GetHighlights).WithName("GetHighlights");
        group.MapPost("", CreateHighlight).WithName("CreateHighlight")
            .RequireRateLimiting("highlight-write");
        group.MapPut("/{id:guid}", UpdateHighlight).WithName("UpdateHighlight");
        group.MapDelete("/{id:guid}", DeleteHighlight).WithName("DeleteHighlight");
    }

    private static async Task<IResult> GetHighlights(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var highlights = await db.Highlights
            .Where(h => h.UserId == userId.Value && h.EditionId == editionId)
            .OrderByDescending(h => h.CreatedAt)
            .Select(HighlightMappings.Project)
            .ToListAsync(ct);

        return Results.Ok(highlights);
    }

    private static async Task<IResult> GetUserBookHighlights(
        Guid userBookId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var owns = await db.UserBooks.AnyAsync(b => b.Id == userBookId && b.UserId == userId.Value, ct);
        if (!owns) return Results.NotFound();

        var highlights = await db.Highlights
            .Where(h => h.UserId == userId.Value && h.UserBookId == userBookId)
            .OrderByDescending(h => h.CreatedAt)
            .Select(HighlightMappings.Project)
            .ToListAsync(ct);

        return Results.Ok(highlights);
    }

    private static async Task<IResult> GetAllHighlights(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] int limit = 50,
        [FromQuery] int offset = 0,
        [FromQuery] string? bookType = "all",
        [FromQuery] string? sort = "newest",
        [FromQuery] string? search = null,
        [FromQuery] string? color = null,
        CancellationToken ct = default)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        limit = Math.Clamp(limit, 1, 100);

        var query = db.Highlights
            .Where(h => h.UserId == userId.Value);

        if (bookType == "edition")
            query = query.Where(h => h.EditionId != null);
        else if (bookType == "userbook")
            query = query.Where(h => h.UserBookId != null);

        if (!string.IsNullOrEmpty(search))
            query = query.Where(h => h.SelectedText.Contains(search) || (h.NoteText != null && h.NoteText.Contains(search)));

        if (!string.IsNullOrEmpty(color))
            query = query.Where(h => h.Color == color);

        var totalCount = await query.CountAsync(ct);

        query = sort == "oldest"
            ? query.OrderBy(h => h.CreatedAt)
            : query.OrderByDescending(h => h.CreatedAt);

        var highlights = await query
            .Skip(offset)
            .Take(limit)
            .Select(h => new HighlightListItemDto(
                h.Id,
                h.SelectedText,
                h.AnchorJson,
                h.Color,
                h.NoteText,
                h.CreatedAt,
                h.EditionId,
                h.EditionId != null ? h.Edition!.Title : null,
                h.EditionId != null ? h.Edition!.Slug : null,
                h.EditionId != null ? h.Edition!.CoverPath : null,
                h.UserBookId,
                h.UserBookId != null ? h.UserBook!.Title : null,
                h.UserBookId != null ? h.UserBook!.CoverPath : null,
                h.ChapterId,
                h.UserChapterId,
                h.ChapterId != null ? h.Chapter!.Title : null,
                h.UserChapterId != null ? h.UserChapter!.Title : null,
                h.ChapterId != null ? h.Chapter!.Slug : null,
                h.UserChapterId != null ? h.UserChapter!.Slug : null
            ))
            .ToListAsync(ct);

        return Results.Ok(new { items = highlights, totalCount });
    }

    private static async Task<IResult> GetHighlightsForReview(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] int limit = 10,
        CancellationToken ct = default)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        limit = Math.Clamp(limit, 1, 30);

        var cutoff = DateTimeOffset.UtcNow.AddHours(-24);

        var highlights = await db.Highlights
            .Where(h => h.UserId == userId.Value && (h.LastReviewedAt == null || h.LastReviewedAt < cutoff))
            .OrderBy(h => h.LastReviewedAt ?? DateTimeOffset.MinValue)
            .ThenBy(h => h.CreatedAt)
            .Take(limit)
            .Select(h => new HighlightReviewDto(
                h.Id,
                h.SelectedText,
                h.AnchorJson,
                h.Color,
                h.NoteText,
                h.EditionId != null ? h.Edition!.Title : (h.UserBookId != null ? h.UserBook!.Title : null),
                h.ChapterId != null ? h.Chapter!.Title : (h.UserChapterId != null ? h.UserChapter!.Title : null),
                h.LastReviewedAt
            ))
            .ToListAsync(ct);

        return Results.Ok(highlights);
    }

    private static async Task<IResult> MarkHighlightReviewed(
        [FromBody] MarkReviewedRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var highlight = await db.Highlights
            .Where(h => h.Id == request.HighlightId && h.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (highlight == null) return Results.NotFound();

        highlight.LastReviewedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync(ct);

        return Results.Ok();
    }

    private static async Task<IResult> CreateHighlight(
        [FromBody] CreateHighlightRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        bool isUserBook = request.UserBookId.HasValue;
        bool isEdition = request.EditionId.HasValue;

        if (isUserBook == isEdition)
            return Results.BadRequest("Provide either EditionId+ChapterId or UserBookId+UserChapterId");

        if (isEdition)
        {
            if (!request.ChapterId.HasValue)
                return Results.BadRequest("ChapterId required for edition highlights");

            var editionId = request.EditionId!.Value;
            var chapterId = request.ChapterId!.Value;
            var edition = await db.Editions
                .Where(e => e.Id == editionId)
                .FirstOrDefaultAsync(ct);
            if (edition == null) return Results.NotFound("Edition not found");

            var chapter = await db.Chapters
                .Where(c => c.Id == chapterId && c.EditionId == editionId)
                .FirstOrDefaultAsync(ct);
            if (chapter == null) return Results.NotFound("Chapter not found");
        }
        else
        {
            // User books may be reflowed (EPUB → UserChapters) or original-first PDFs (chapterless,
            // page-anchored). A null UserChapterId is therefore valid: it means a PDF page highlight
            // whose location lives entirely inside the opaque AnchorJson ({v,kind:"pdf",page,rects,exact}).
            // We still require book ownership + a color + an anchor; the chapter FK stays null (SetNull).
            if (string.IsNullOrWhiteSpace(request.Color))
                return Results.BadRequest("Color required");
            if (string.IsNullOrWhiteSpace(request.AnchorJson))
                return Results.BadRequest("AnchorJson required");

            var userBook = await db.UserBooks
                .Where(b => b.Id == request.UserBookId!.Value && b.UserId == userId.Value)
                .FirstOrDefaultAsync(ct);
            if (userBook == null) return Results.NotFound("User book not found");

            if (request.UserChapterId.HasValue)
            {
                var userChapterId = request.UserChapterId.Value;
                var userChapter = await db.UserChapters
                    .Where(c => c.Id == userChapterId && c.UserBookId == request.UserBookId!.Value)
                    .FirstOrDefaultAsync(ct);
                if (userChapter == null) return Results.NotFound("User chapter not found");
            }
            else if (!IsPdfAnchor(request.AnchorJson))
            {
                // A null chapter is only legitimate for a chapterless PDF page anchor. A reflow
                // text-anchor with no chapter would be an orphan that never paints and misroutes,
                // so reject it here.
                return Results.BadRequest("UserChapterId required for non-PDF user book highlights");
            }
        }

        // The assistant ceiling. Only MCP-authored anchors are counted, and only against the book
        // being written to, so this is invisible to a person highlighting in the reader — including
        // one whose book an assistant has also marked.
        //
        // Raw SQL because the predicate is a jsonb one (anchor_json->>'source'), and EF has no
        // mapping for it: AnchorJson is a plain string property over a jsonb column, so any LINQ
        // string operator compiles to LIKE and Postgres rejects LIKE on jsonb at execution time.
        if (IsAssistantAnchor(request.AnchorJson))
        {
            // Two fixed statements rather than one with the column name interpolated in. Nothing
            // user-supplied could ever have reached that interpolation — it was one of two literals —
            // but a raw-SQL string that is assembled at all is a thing a reader has to prove safe,
            // and EF1002 is right to say so. Every value here is a parameter.
            var alreadyPlaced = await db.Database
                .SqlQueryRaw<int>(
                    request.UserBookId != null ? CountAssistantHighlightsInUserBookSql : CountAssistantHighlightsInEditionSql,
                    userId.Value, request.UserBookId ?? request.EditionId!.Value, McpAnchorSource)
                .FirstAsync(ct);

            if (alreadyPlaced >= MaxAssistantHighlightsPerBook)
                return Results.BadRequest(
                    $"This book already has {alreadyPlaced} assistant-placed highlights, which is the "
                    + $"limit of {MaxAssistantHighlightsPerBook}. Remove some before adding more.");
        }

        var now = DateTimeOffset.UtcNow;
        var highlight = new Highlight
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = siteId,
            EditionId = request.EditionId,
            ChapterId = request.ChapterId,
            UserBookId = request.UserBookId,
            UserChapterId = request.UserChapterId,
            AnchorJson = request.AnchorJson,
            Color = request.Color,
            SelectedText = request.SelectedText,
            NoteText = request.NoteText,
            Version = 1,
            CreatedAt = now,
            UpdatedAt = now,
        };

        db.Highlights.Add(highlight);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/me/highlights/{highlight.Id}", highlight.ToDto());
    }

    /// <summary>
    /// How many highlights one assistant may place in a single book.
    ///
    /// <para>Not a resource limit — a highlight row is tiny. It is a legibility limit. An MCP client
    /// told to "go through the book and mark what matters" can place a highlight per paragraph in a
    /// single pass, and a book marked end to end is a book with no marks: the reader loses the thing
    /// the feature was for. The tool description asks for restraint; this is what happens when the
    /// asking does not work.</para>
    ///
    /// <para>Counted per book and only over MCP-written highlights, so a person who genuinely
    /// highlights heavily is never affected by it.</para>
    /// </summary>
    public const int MaxAssistantHighlightsPerBook = 200;

    /// <summary>
    /// The value <c>SynthesizeAnchor</c> puts in the anchor's top-level <c>source</c> field for every
    /// MCP-authored highlight (see <c>TextStack.Ai.Mcp/Tools/McpToolCatalog.cs</c>).
    ///
    /// <para>Read with the jsonb operator <c>-&gt;&gt;</c>, not a substring match. <c>anchor_json</c>
    /// IS jsonb, so <c>LIKE</c> against it does not merely risk false positives — Postgres refuses it
    /// outright. Reading the field also makes the check independent of how the JSON was spaced or
    /// ordered by whichever serializer wrote it, which a substring match is not.</para>
    ///
    /// <para>Public so a test can assert the bridge still writes it. If the two drift apart the cap
    /// below silently stops applying, which is the worst way for a limit to fail: no error, no
    /// symptom, until a book comes back unreadable.</para>
    /// </summary>
    public const string McpAnchorSource = "mcp";

    // The column differs between the two halves of the edition/user-book XOR and a column name
    // cannot be a parameter, so it is the statement that varies, not a string that gets built.
    private const string CountAssistantHighlightsInUserBookSql =
        """
        SELECT COUNT(*)::int AS "Value" FROM highlights
        WHERE user_id = {0} AND user_book_id = {1} AND anchor_json->>'source' = {2}
        """;

    private const string CountAssistantHighlightsInEditionSql =
        """
        SELECT COUNT(*)::int AS "Value" FROM highlights
        WHERE user_id = {0} AND edition_id = {1} AND anchor_json->>'source' = {2}
        """;

    /// <summary>
    /// Whether this anchor was written by an assistant over MCP — its top-level <c>source</c> is
    /// <see cref="McpAnchorSource"/>. Reads the same field the SQL predicate above reads, so the
    /// gate and the count cannot disagree about what they are counting.
    /// </summary>
    private static bool IsAssistantAnchor(string? anchorJson)
    {
        if (string.IsNullOrWhiteSpace(anchorJson)) return false;
        try
        {
            using var doc = JsonDocument.Parse(anchorJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("source", out var source)
                && source.ValueKind == JsonValueKind.String
                && source.GetString() == McpAnchorSource;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    // A PDF page anchor is the opaque JSON {v,kind:"pdf",page,rects,exact}. We treat the anchor as
    // a PDF anchor iff it parses as a JSON object with a top-level "kind":"pdf" marker. The anchor
    // otherwise stays opaque — we do not deserialize it into a strict schema.
    private static bool IsPdfAnchor(string? anchorJson)
    {
        if (string.IsNullOrWhiteSpace(anchorJson)) return false;
        try
        {
            using var doc = JsonDocument.Parse(anchorJson);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("kind", out var kind)
                && kind.ValueKind == JsonValueKind.String
                && kind.GetString() == "pdf";
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<IResult> UpdateHighlight(
        Guid id,
        [FromBody] UpdateHighlightRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var highlight = await db.Highlights
            .Where(h => h.Id == id && h.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (highlight == null) return Results.NotFound();

        if (request.Version.HasValue && request.Version.Value != highlight.Version)
            return Results.Conflict(highlight.ToDto());

        if (request.Color != null)
            highlight.Color = request.Color;
        if (request.AnchorJson != null)
            highlight.AnchorJson = request.AnchorJson;
        if (request.SelectedText != null)
            highlight.SelectedText = request.SelectedText;
        if (request.NoteText != null)
            highlight.NoteText = request.NoteText;
        else if (request.RemoveNote)
            highlight.NoteText = null;

        highlight.Version++;
        highlight.UpdatedAt = DateTimeOffset.UtcNow;

        await db.SaveChangesAsync(ct);

        return Results.Ok(highlight.ToDto());
    }

    private static async Task<IResult> DeleteHighlight(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var highlight = await db.Highlights
            .Where(h => h.Id == id && h.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (highlight == null) return Results.NotFound();

        db.Highlights.Remove(highlight);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }
}

// DTOs
public record HighlightDto(
    Guid Id,
    Guid? EditionId,
    Guid? ChapterId,
    Guid? UserBookId,
    Guid? UserChapterId,
    string AnchorJson,
    string Color,
    string SelectedText,
    string? NoteText,
    int Version,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt
);

public record HighlightListItemDto(
    Guid Id,
    string SelectedText,
    // The reflow anchor is {prefix, exact, suffix} with ~30 characters of the real page on each
    // side. It was already stored; this projection simply dropped it, which is why a one-word
    // highlight rendered as `"in"` on every screen but the reader.
    string AnchorJson,
    string Color,
    string? NoteText,
    DateTimeOffset CreatedAt,
    Guid? EditionId,
    string? EditionTitle,
    string? EditionSlug,
    string? EditionCoverPath,
    Guid? UserBookId,
    string? UserBookTitle,
    string? UserBookCoverPath,
    Guid? ChapterId,
    Guid? UserChapterId,
    string? ChapterTitle,
    string? UserChapterTitle,
    string? ChapterSlug,
    string? UserChapterSlug
);

public record HighlightReviewDto(
    Guid Id,
    string SelectedText,
    /// <inheritdoc cref="HighlightListItemDto.AnchorJson"/>
    string AnchorJson,
    string Color,
    string? NoteText,
    string? BookTitle,
    string? ChapterTitle,
    DateTimeOffset? LastReviewedAt
);

public record CreateHighlightRequest(
    Guid? EditionId,
    Guid? ChapterId,
    string AnchorJson,
    string Color,
    string SelectedText,
    string? NoteText = null,
    Guid? UserBookId = null,
    Guid? UserChapterId = null
);

public record MarkReviewedRequest(Guid HighlightId);

public record UpdateHighlightRequest(
    string? Color,
    string? AnchorJson,
    string? SelectedText,
    string? NoteText,
    int? Version,
    bool RemoveNote = false
);
