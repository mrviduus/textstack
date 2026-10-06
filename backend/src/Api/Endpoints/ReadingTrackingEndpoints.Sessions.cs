using Api.Extensions;
using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Application.ReadingTracking;
using Contracts.ReadingTracking;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static partial class ReadingTrackingEndpoints
{
    private static async Task<IResult> SubmitSession(
        [FromBody] SubmitSessionRequest request,
        [FromQuery] string? tz,
        HttpContext httpContext,
        AuthService authService,
        ReadingSessionService sessionService,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        // Validation
        if (request.EditionId == null && request.UserBookId == null)
            return Results.BadRequest("EditionId or UserBookId required");
        if (request.DurationSeconds <= 0 || request.DurationSeconds > 14400)
            return Results.BadRequest("DurationSeconds must be 1-14400");
        if (request.StartedAt > DateTimeOffset.UtcNow.AddMinutes(5))
            return Results.BadRequest("StartedAt cannot be in the future");
        if (request.StartedAt < DateTimeOffset.UtcNow.AddDays(-7))
            return Results.BadRequest("StartedAt cannot be older than 7 days");
        var elapsed = (request.EndedAt - request.StartedAt).TotalSeconds;
        if (elapsed < request.DurationSeconds)
            return Results.BadRequest("EndedAt - StartedAt must be >= DurationSeconds");

        // null ⇒ the referenced user_book/edition was deleted (user re-uploaded). Return 404 so the
        // client prunes the stale queued session instead of resubmitting forever (FK-23503 500-flood).
        var result = await sessionService.SubmitAsync(userId.Value, siteId, request, ct, ParseTzOffset(tz));
        return result is null
            ? Results.NotFound("Referenced book no longer exists")
            : Results.Ok(result);
    }

    private static async Task<IResult> GetSessions(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] DateTimeOffset? from,
        [FromQuery] DateTimeOffset? to,
        [FromQuery] int? limit,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        var query = db.ReadingSessions
            .Where(s => s.UserId == userId.Value);

        if (from.HasValue) query = query.Where(s => s.StartedAt >= from.Value);
        if (to.HasValue) query = query.Where(s => s.StartedAt <= to.Value);

        var sessions = await query
            .OrderByDescending(s => s.StartedAt)
            .Take(limit ?? 100)
            .Select(s => new SessionDto(
                s.Id, s.EditionId, s.UserBookId,
                s.StartedAt, s.EndedAt, s.DurationSeconds,
                s.WordsRead, s.StartPercent, s.EndPercent))
            .ToListAsync(ct);

        return Results.Ok(sessions);
    }
}
