using Api.Extensions;
using Api.Mapping;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Application.ReadingTracking;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Api.Endpoints;

public static class UserDataEndpoints
{
    public static void MapUserDataEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me").WithTags("User Data");

        // Reading Progress
        group.MapGet("/progress", GetAllProgress).WithName("GetAllProgress");
        group.MapGet("/progress/{editionId:guid}", GetProgress).WithName("GetProgress");
        group.MapPut("/progress/{editionId:guid}", UpsertProgress).WithName("UpsertProgress");
        group.MapDelete("/progress/{editionId:guid}", DeleteProgress).WithName("DeleteProgress");

        // Bookmarks
        group.MapGet("/bookmarks", GetAllBookmarks).WithName("GetAllBookmarks");
        group.MapGet("/bookmarks/{editionId:guid}", GetBookmarks).WithName("GetBookmarks");
        group.MapPost("/bookmarks", CreateBookmark).WithName("CreateBookmark");
        group.MapDelete("/bookmarks/{id:guid}", DeleteBookmark).WithName("DeleteBookmark");

        // Library
        group.MapGet("/library", GetLibrary).WithName("GetLibrary");
        group.MapPost("/library/{editionId:guid}", AddToLibrary).WithName("AddToLibrary");
        group.MapDelete("/library/{editionId:guid}", RemoveFromLibrary).WithName("RemoveFromLibrary");
    }

    // Reading Progress Endpoints

    private static async Task<IResult> GetAllProgress(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var query = db.ReadingProgresses
            .Where(p => p.UserId == userId.Value)
            .OrderByDescending(p => p.UpdatedAt);

        var total = await query.CountAsync(ct);
        var items = await query
            .Skip(offset ?? 0)
            .Take(limit ?? 50)
            .Join(db.Chapters, p => p.ChapterId, c => c.Id, (p, c) => new { p, c })
            .Select(x => new ReadingProgressDto(
                x.p.EditionId,
                x.p.ChapterId,
                x.c.Slug,
                x.p.Locator,
                x.p.Percent,
                x.p.UpdatedAt,
                x.p.CompletedAt,
                x.p.PositionJson
            ))
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetProgress(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var progress = await db.ReadingProgresses
            .Where(p => p.UserId == userId.Value && p.EditionId == editionId)
            .Join(db.Chapters, p => p.ChapterId, c => c.Id, (p, c) => new { p, c })
            .Select(x => new ReadingProgressDto(
                x.p.EditionId,
                x.p.ChapterId,
                x.c.Slug,
                x.p.Locator,
                x.p.Percent,
                x.p.UpdatedAt,
                x.p.CompletedAt,
                x.p.PositionJson
            ))
            .FirstOrDefaultAsync(ct);

        return progress is null ? Results.NotFound() : Results.Ok(progress);
    }

    private static async Task<IResult> UpsertProgress(
        Guid editionId,
        [FromBody] UpsertProgressRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        // Validate edition exists
        var edition = await db.Editions
            .Where(e => e.Id == editionId)
            .FirstOrDefaultAsync(ct);

        if (edition == null) return Results.NotFound("Edition not found");

        // Validate chapter exists
        var chapter = await db.Chapters
            .Where(c => c.Id == request.ChapterId && c.EditionId == editionId)
            .FirstOrDefaultAsync(ct);

        if (chapter == null) return Results.NotFound("Chapter not found");

        var existing = await db.ReadingProgresses
            .Where(p => p.UserId == userId.Value && p.EditionId == editionId)
            .FirstOrDefaultAsync(ct);

        ReadingProgress? inserted = null;

        if (existing != null)
        {
            // Update only if client timestamp is newer (conflict resolution)
            if (request.UpdatedAt.HasValue && request.UpdatedAt.Value <= existing.UpdatedAt)
            {
                // Get current chapter slug for response
                var existingChapter = await db.Chapters.FirstOrDefaultAsync(c => c.Id == existing.ChapterId, ct);
                return Results.Ok(new ReadingProgressDto(
                    existing.EditionId,
                    existing.ChapterId,
                    existingChapter?.Slug,
                    existing.Locator,
                    existing.Percent,
                    existing.UpdatedAt,
                    existing.CompletedAt,
                    existing.PositionJson
                ));
            }

            ApplyProgressUpdate(existing, request, chapter);
        }
        else
        {
            // Built empty, then filled by the SAME method the update path uses. It used to assign
            // the columns here by hand, and the copy had drifted: `Percent = request.Percent` with
            // no unit check, so the FIRST write for an edition kept an untrusted percentage that
            // every later write would have refused, and CompletedAt was never set on a book finished
            // in one go. Two code paths writing one row is how that happens; now there is one.
            var progress = new ReadingProgress
            {
                Id = Guid.NewGuid(),
                UserId = userId.Value,
                SiteId = siteId,
                EditionId = editionId,
                ChapterId = request.ChapterId,
                Locator = request.Locator,
            };
            ApplyProgressUpdate(progress, request, chapter);
            db.ReadingProgresses.Add(progress);
            existing = progress;
            inserted = progress;
        }

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (inserted is not null && IsUniqueViolation(ex))
        {
            // Lost an insert race. The read-then-insert above has no concurrency control, and a
            // single reader legitimately fires overlapping PUTs: the 30s session heartbeat, a
            // sendBeacon on unload, an offline-queue flush, or a second device. Both requests see
            // no row, both INSERT, and the loser violates
            // ix_reading_progresses_user_id_site_id_edition_id (23505) — a 500 to the client and a
            // silently lost reading position, which is how this surfaced in production.
            //
            // Recovery: detach our doomed insert, re-read the winner's row and merge into it, which
            // is exactly the update path we would have taken had we lost the race by a millisecond
            // more. The stale-write guard is re-applied against the WINNER's timestamp, so a late
            // duplicate can still not move a reader backwards.
            db.ReadingProgresses.Remove(inserted);

            var winner = await db.ReadingProgresses
                .Where(p => p.UserId == userId.Value && p.EditionId == editionId)
                .FirstOrDefaultAsync(ct);

            // A unique violation with no winning row is not the race we know how to recover from
            // (e.g. the row was deleted between the failure and this read) — surface it.
            if (winner == null) throw;

            if (!request.UpdatedAt.HasValue || request.UpdatedAt.Value > winner.UpdatedAt)
            {
                ApplyProgressUpdate(winner, request, chapter);
                await db.SaveChangesAsync(ct);
            }

            existing = winner;
        }

        return Results.Ok(new ReadingProgressDto(
            existing.EditionId,
            existing.ChapterId,
            chapter.Slug,
            existing.Locator,
            existing.Percent,
            existing.UpdatedAt,
            existing.CompletedAt,
            existing.PositionJson
        ));
    }

    /// <summary>
    /// Applies one client write onto an existing progress row. Shared by the normal update path and
    /// the lost-insert-race recovery so the two can never drift.
    /// </summary>
    public static void ApplyProgressUpdate(
        ReadingProgress target, UpsertProgressRequest request, Chapter chapter)
    {
        target.ChapterId = request.ChapterId;
        target.Locator = request.Locator;
        // Always assigned, never merged: a write that carries no position clears the stored one.
        // See ReaderPosition for why "keep what was there" is the wrong default.
        target.PositionJson = ReaderPosition.ToStore(request.PositionJson, request.Locator);

        // The position is always the reader's, so it is always saved. The NUMBER is
        // only saved when the caller says what it is a fraction of — an old client
        // sending a chapter fraction cannot be told from a correct one by looking at
        // it, and this column has already been wrong once that way.
        if (ProgressUnit.IsTrusted(request.PercentUnit))
        {
            target.Percent = request.Percent;
            // Completion is recorded, not inferred later from a threshold. Same 0.99
            // rule uploads use (UserBookService.UpsertProgressAsync), so both kinds of
            // book answer "finished?" the same way. Re-reading a finished book does
            // not un-finish it — only an explicit mark-as-unfinished clears this,
            // which arrives as percent 0.
            if (request.Percent is >= 0.99)
                target.CompletedAt ??= DateTimeOffset.UtcNow;
            else if (request.Percent is <= 0)
                target.CompletedAt = null;
        }
        // High-water mark for the RAG spoiler gate — monotonic, never decreases. NULL means
        // "never recorded" (distinct from ordinal 0, a real 0-based first chapter), so the first
        // write seeds it rather than max-ing against an implied 0.
        target.MaxChapterNumber = target.MaxChapterNumber.HasValue
            ? Math.Max(target.MaxChapterNumber.Value, chapter.ChapterNumber)
            : chapter.ChapterNumber;
        target.UpdatedAt = DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// True for a Postgres unique-constraint violation (SQLSTATE 23505). Matched on the SQLSTATE
    /// rather than the message so it survives locale and constraint renames.
    /// </summary>
    public static bool IsUniqueViolation(DbUpdateException ex) =>
        ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation };

    private static async Task<IResult> DeleteProgress(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var progress = await db.ReadingProgresses
            .Where(p => p.UserId == userId.Value && p.EditionId == editionId)
            .FirstOrDefaultAsync(ct);

        if (progress == null) return Results.NotFound();

        db.ReadingProgresses.Remove(progress);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    // Bookmarks Endpoints

    private static async Task<IResult> GetAllBookmarks(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var query = db.Bookmarks
            .Where(b => b.UserId == userId.Value)
            .OrderByDescending(b => b.CreatedAt);

        var total = await query.CountAsync(ct);
        var items = await query
            .Skip(offset ?? 0)
            .Take(limit ?? 100)
            .Select(BookmarkMappings.Project)
            .ToListAsync(ct);

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> GetBookmarks(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();


        var bookmarks = await db.Bookmarks
            .Where(b => b.UserId == userId.Value && b.EditionId == editionId)
            .OrderByDescending(b => b.CreatedAt)
            .Select(BookmarkMappings.Project)
            .ToListAsync(ct);

        return Results.Ok(bookmarks);
    }

    private static async Task<IResult> CreateBookmark(
        [FromBody] CreateBookmarkRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var siteId = httpContext.GetSiteId();

        // Validate edition exists
        var edition = await db.Editions
            .Where(e => e.Id == request.EditionId)
            .FirstOrDefaultAsync(ct);

        if (edition == null) return Results.NotFound("Edition not found");

        // Validate chapter exists
        var chapter = await db.Chapters
            .Where(c => c.Id == request.ChapterId && c.EditionId == request.EditionId)
            .FirstOrDefaultAsync(ct);

        if (chapter == null) return Results.NotFound("Chapter not found");

        var bookmark = new Bookmark
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = siteId,
            EditionId = request.EditionId,
            ChapterId = request.ChapterId,
            Locator = request.Locator,
            Title = request.Title,
            CreatedAt = DateTimeOffset.UtcNow
        };

        db.Bookmarks.Add(bookmark);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/me/bookmarks/{bookmark.Id}", bookmark.ToDto());
    }

    private static async Task<IResult> DeleteBookmark(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var bookmark = await db.Bookmarks
            .Where(b => b.Id == id && b.UserId == userId.Value)
            .FirstOrDefaultAsync(ct);

        if (bookmark == null) return Results.NotFound();

        db.Bookmarks.Remove(bookmark);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    // Library Endpoints

    private static async Task<IResult> GetLibrary(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] int? limit,
        [FromQuery] int? offset,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var query = db.UserLibraries
            .Where(l => l.UserId == userId.Value)
            .OrderByDescending(l => l.CreatedAt);

        var total = await query.CountAsync(ct);
        var raw = await query
            .Skip(offset ?? 0)
            .Take(limit ?? 50)
            .Select(l => new
            {
                l.EditionId,
                l.Edition.Slug,
                l.Edition.Title,
                l.Edition.Language,
                l.Edition.CoverPath,
                l.CreatedAt,
                AuthorNames = l.Edition.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .ToList()
            })
            .ToListAsync(ct);

        var items = raw.Select(r => new LibraryItemDto(
            r.EditionId,
            r.Slug,
            r.Title,
            r.Language,
            r.CoverPath,
            r.CreatedAt,
            r.AuthorNames.Count > 0 ? string.Join(", ", r.AuthorNames) : null
        )).ToList();

        return Results.Ok(new { total, items });
    }

    private static async Task<IResult> AddToLibrary(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        // Check if edition exists; project only what we need (avoids materialising
        // related authors as full entities — we only want their names).
        var editionInfo = await db.Editions
            .Where(e => e.Id == editionId)
            .Select(e => new
            {
                e.Slug,
                e.Title,
                e.Language,
                e.CoverPath,
                AuthorNames = e.EditionAuthors
                    .OrderBy(ea => ea.Order)
                    .Select(ea => ea.Author.Name)
                    .ToList()
            })
            .FirstOrDefaultAsync(ct);
        if (editionInfo == null) return Results.NotFound("Edition not found");

        var authorJoined = editionInfo.AuthorNames.Count > 0
            ? string.Join(", ", editionInfo.AuthorNames)
            : null;

        // Check if already in library
        var existing = await db.UserLibraries
            .FirstOrDefaultAsync(l => l.UserId == userId.Value && l.EditionId == editionId, ct);

        if (existing != null)
            return Results.Ok(new LibraryItemDto(
                existing.EditionId,
                editionInfo.Slug,
                editionInfo.Title,
                editionInfo.Language,
                editionInfo.CoverPath,
                existing.CreatedAt,
                authorJoined
            ));

        var libraryItem = new UserLibrary
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            EditionId = editionId,
            CreatedAt = DateTimeOffset.UtcNow
        };

        db.UserLibraries.Add(libraryItem);
        await db.SaveChangesAsync(ct);

        return Results.Created($"/me/library/{editionId}", new LibraryItemDto(
            libraryItem.EditionId,
            editionInfo.Slug,
            editionInfo.Title,
            editionInfo.Language,
            editionInfo.CoverPath,
            libraryItem.CreatedAt,
            authorJoined
        ));
    }

    private static async Task<IResult> RemoveFromLibrary(
        Guid editionId,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var libraryItem = await db.UserLibraries
            .FirstOrDefaultAsync(l => l.UserId == userId.Value && l.EditionId == editionId, ct);

        if (libraryItem == null) return Results.NotFound();

        db.UserLibraries.Remove(libraryItem);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }
}

// DTOs
public record ReadingProgressDto(
    Guid EditionId,
    Guid ChapterId,
    string? ChapterSlug,
    string Locator,
    double? Percent,
    DateTimeOffset UpdatedAt,
    /// <summary>Non-null once the book is finished. Clients read this instead of
    /// comparing <paramref name="Percent"/> against a threshold of their own.</summary>
    DateTimeOffset? CompletedAt,
    /// <summary>The logical position, when the row holds one — see
    /// <see cref="Domain.Entities.ReadingProgress.PositionJson"/>. Null on rows
    /// last written by a build that predates it, and on every PDF page position.
    /// A client that understands it prefers it over <paramref name="Locator"/>;
    /// one that does not carries on reading the locator, unchanged.</summary>
    string? PositionJson = null
);

public record UpsertProgressRequest(
    Guid ChapterId,
    string Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt,
    /// <summary>What <paramref name="Percent"/> is a fraction OF. Only "book" is
    /// stored — see <see cref="Application.ReadingTracking.ProgressUnit"/>.
    /// Absent from clients that predate the contract, whose percentages are of
    /// unknown scale and are therefore left unstored.</summary>
    string? PercentUnit = null,
    /// <summary>The logical position this write is really about. Absent means
    /// absent, not unchanged: the stored one is cleared, because a row must
    /// never hold two positions that disagree. See
    /// <see cref="Application.ReadingTracking.ReaderPosition"/>.</summary>
    string? PositionJson = null
);

public record BookmarkDto(
    Guid Id,
    Guid EditionId,
    Guid ChapterId,
    string Locator,
    string? Title,
    DateTimeOffset CreatedAt
);

public record CreateBookmarkRequest(
    Guid EditionId,
    Guid ChapterId,
    string Locator,
    string? Title
);

public record LibraryItemDto(
    Guid EditionId,
    string Slug,
    string Title,
    string Language,
    string? CoverPath,
    DateTimeOffset CreatedAt,
    string? Author
);
