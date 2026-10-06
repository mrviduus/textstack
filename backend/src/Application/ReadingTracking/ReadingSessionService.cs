using Application.Common.Interfaces;
using Contracts.ReadingTracking;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Application.ReadingTracking;

/// <summary>
/// Mutating reading-session submit (R5 slice-4). Body moved verbatim from the former
/// <c>ReadingTrackingEndpoints.SubmitSession</c> handler — kept separate from the read-only
/// <see cref="ReadingStatsService"/>. The side-effect ordering is load-bearing and preserved exactly:
/// dedup pre-check → build session (SiteId set by hand) → Add → SaveChanges (with the
/// 23505 race fallback) → best-effort achievement award. Note the asymmetry the original relied on:
/// the pre-check duplicate returns <c>Guid.Empty</c> (nothing was inserted) while the race fallback
/// returns <c>session.Id</c> (our row lost the insert race but the caller acks idempotently). The
/// achievement block runs strictly AFTER the save because the checker reads persisted state (the just-
/// saved session must already be in the table for e.g. <c>first_session</c> to unlock), and it is
/// best-effort: any exception there is logged and swallowed so the submit still succeeds. The HTTP
/// validations + auth stay in the thin handler.
/// </summary>
public class ReadingSessionService(IAppDbContext db, ILogger<ReadingSessionService> logger)
{
    /// <summary>
    /// Returns null when the referenced book is GONE (the user re-uploaded → the old user_book/edition
    /// row was deleted): the caller maps null → 404 so the client prunes the stale queued session instead
    /// of retrying forever. Otherwise returns the (idempotent) submit result.
    /// <paramref name="tzOffset"/>: the reader's UTC offset, so the streak and the time-of-day
    /// achievements count the reader's days and hours, not UTC's (the stats page already does).
    /// </summary>
    public async Task<SubmitSessionResponse?> SubmitAsync(
        Guid userId, Guid siteId, SubmitSessionRequest request, CancellationToken ct, TimeSpan tzOffset = default)
    {
        // Existence pre-check: a session for a deleted user_book/edition would hit the FK and Npgsql
        // would raise 23503 → an unhandled DbUpdateException → 500, and the client's offline queue
        // resubmits forever (500-flood). Signal "gone" (null → 404) so the client drops the item. The
        // user_book check is owner-scoped and skips taken-down books (their FK row is also unusable).
        if (request.UserBookId != null)
        {
            var liveBook = await db.UserBooks.AnyAsync(
                b => b.Id == request.UserBookId && b.UserId == userId && b.TakedownAt == null, ct);
            if (!liveBook) return null;
        }
        else if (request.EditionId != null)
        {
            var liveEdition = await db.Editions.AnyAsync(e => e.Id == request.EditionId, ct);
            if (!liveEdition) return null;
        }

        // Idempotency: one session per (user, book, started_at). Both clients resubmit — web queues
        // every session AND beacons it, then flushes the queue on the next reader mount; mobile
        // retries a session whose submit failed, and "failed" includes a response lost after the
        // row was written. Partial unique indexes on (user, edition|user_book, started_at) are the
        // source of truth and the 23505 catch below covers a race; this pre-check keeps the common
        // retry off the "SQL error level: ERROR" line Npgsql logs before the catch can swallow it.
        // It used to run for user-book sessions only, on the belief that editions had no index.
        var dup = await db.ReadingSessions.AnyAsync(
            s => s.UserId == userId
              && s.UserBookId == request.UserBookId
              && s.EditionId == request.EditionId
              && s.StartedAt == request.StartedAt,
            ct);
        if (dup) return new SubmitSessionResponse(Guid.Empty, []);

        var session = new ReadingSession
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            SiteId = siteId,
            EditionId = request.EditionId,
            UserBookId = request.UserBookId,
            StartedAt = request.StartedAt,
            EndedAt = request.EndedAt,
            DurationSeconds = request.DurationSeconds,
            WordsRead = request.WordsRead,
            StartPercent = request.StartPercent,
            EndPercent = request.EndPercent,
            CreatedAt = DateTimeOffset.UtcNow,
        };

        db.ReadingSessions.Add(session);

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" })
        {
            // Race-window fallback: another concurrent request slipped in
            // between our pre-check and SaveChanges. The first one won; we
            // ack idempotently.
            return new SubmitSessionResponse(session.Id, []);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23503" })
        {
            // Belt-and-suspenders for the delete-between-check-and-insert race: the referenced
            // user_book/edition was removed after our existence pre-check but before this insert. The
            // FK (23503) is caught here — Debug-logged, benign ack (no 500). The row was NOT inserted,
            // so skip the achievement check.
            logger.LogDebug(ex, "Reading session insert hit FK 23503 (referenced book gone mid-insert)");
            return new SubmitSessionResponse(Guid.Empty, []);
        }

        // Achievement check is best-effort — never fail the session submit because of it.
        List<string> newAchievements = [];
        try
        {
            var streakMinMinutes = await StreakCalculator.GetStreakMinMinutes(db, userId, ct);
            var currentStreak = await StreakCalculator.CalculateStreak(db, userId, streakMinMinutes, request.EndedAt, ct, tzOffset);

            var checker = new AchievementChecker(db);
            newAchievements = await checker.CheckAfterSession(userId, siteId, session, currentStreak, ct, tzOffset);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "AchievementChecker failed for session {SessionId}, session still saved", session.Id);
        }

        return new SubmitSessionResponse(session.Id, newAchievements);
    }
}
