using Api.Sites;
using Application.Auth;
using Application.Common.Interfaces;
using Application.ReadingTracking;
using Domain.Entities;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

public static class ReadingTrackingEndpoints
{
    public static void MapReadingTrackingEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/me/reading").WithTags("Reading Tracking");

        group.MapPost("/sessions", SubmitSession).WithName("SubmitReadingSession");
        group.MapGet("/sessions", GetSessions).WithName("GetReadingSessions");
        group.MapGet("/stats", GetStats).WithName("GetReadingStats");
        group.MapGet("/stats/daily", GetDailyStats).WithName("GetDailyReadingStats");
        group.MapGet("/goals", GetGoals).WithName("GetReadingGoals");
        group.MapPost("/goals", CreateOrUpdateGoal).WithName("CreateOrUpdateReadingGoal");
        group.MapDelete("/goals/{id:guid}", DeleteGoal).WithName("DeleteReadingGoal");
        group.MapGet("/achievements", GetAchievements).WithName("GetAchievements");
    }

    private static Guid? GetUserId(HttpContext httpContext, AuthService authService)
    {
        var accessToken = httpContext.Request.Cookies["access_token"];
        if (string.IsNullOrEmpty(accessToken)) return null;
        return authService.ValidateAccessToken(accessToken);
    }

    // --- Sessions ---

    private static async Task<IResult> SubmitSession(
        [FromBody] SubmitSessionRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
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

        var session = new ReadingSession
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
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
            // Unique constraint violation (duplicate) — ignore
            return Results.Ok(new SubmitSessionResponse(session.Id, []));
        }

        // Calculate streak for achievement checker
        var streakMinMinutes = await GetStreakMinMinutes(db, userId.Value, siteId, ct);
        var currentStreak = await CalculateStreak(db, userId.Value, siteId, streakMinMinutes, request.EndedAt, ct);

        var checker = new AchievementChecker(db);
        var newAchievements = await checker.CheckAfterSession(userId.Value, siteId, session, currentStreak, ct);

        return Results.Ok(new SubmitSessionResponse(session.Id, newAchievements));
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
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var query = db.ReadingSessions
            .Where(s => s.UserId == userId.Value && s.SiteId == siteId);

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

    // --- Stats ---

    private static async Task<IResult> GetStats(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] string? tz,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var tzOffset = ParseTzOffset(tz);
        var now = DateTimeOffset.UtcNow;

        var allSessions = db.ReadingSessions
            .Where(s => s.UserId == userId.Value && s.SiteId == siteId);

        var totalSeconds = await allSessions.SumAsync(s => (long)s.DurationSeconds, ct);
        var totalWords = await allSessions.SumAsync(s => (long)s.WordsRead, ct);
        var sessionCount = await allSessions.CountAsync(ct);

        var booksFinished = await allSessions
            .Where(s => s.EndPercent >= 0.99)
            .Select(s => s.EditionId ?? s.UserBookId)
            .Distinct()
            .CountAsync(ct);

        // Time-period sums (calculate in user tz, convert to UTC for PostgreSQL)
        var todayLocal = GetDayStart(now, tzOffset);
        var todayStart = todayLocal.ToUniversalTime();
        var weekStart = todayLocal.AddDays(-(int)todayLocal.DayOfWeek).ToUniversalTime();
        var monthStart = new DateTimeOffset(todayLocal.Year, todayLocal.Month, 1, 0, 0, 0, tzOffset).ToUniversalTime();

        var todaySeconds = await allSessions
            .Where(s => s.StartedAt >= todayStart)
            .SumAsync(s => (long)s.DurationSeconds, ct);
        var weekSeconds = await allSessions
            .Where(s => s.StartedAt >= weekStart)
            .SumAsync(s => (long)s.DurationSeconds, ct);
        var monthSeconds = await allSessions
            .Where(s => s.StartedAt >= monthStart)
            .SumAsync(s => (long)s.DurationSeconds, ct);

        // Streak
        var streakMinMinutes = await GetStreakMinMinutes(db, userId.Value, siteId, ct);
        var currentStreak = await CalculateStreak(db, userId.Value, siteId, streakMinMinutes, now, ct);
        var longestStreak = await CalculateLongestStreak(db, userId.Value, siteId, streakMinMinutes, ct);

        // Averages
        double avgDailyMinutes = 0;
        double avgWordsPerMinute = 0;
        if (sessionCount > 0)
        {
            var firstSession = await allSessions
                .OrderBy(s => s.StartedAt)
                .Select(s => s.StartedAt)
                .FirstOrDefaultAsync(ct);
            var daysSinceFirst = Math.Max(1, (now - firstSession).TotalDays);
            avgDailyMinutes = totalSeconds / 60.0 / daysSinceFirst;

            if (totalSeconds > 0)
                avgWordsPerMinute = totalWords / (totalSeconds / 60.0);
        }

        // Daily goal
        var dailyGoal = await db.ReadingGoals
            .Where(g => g.UserId == userId.Value && g.SiteId == siteId
                && g.GoalType == "daily_minutes" && g.IsActive)
            .FirstOrDefaultAsync(ct);

        object? dailyGoalObj = null;
        if (dailyGoal != null)
        {
            var todayMinutes = todaySeconds / 60.0;
            dailyGoalObj = new
            {
                target = dailyGoal.TargetValue,
                today = Math.Round(todayMinutes, 1),
                met = todayMinutes >= dailyGoal.TargetValue,
            };
        }

        return Results.Ok(new
        {
            totalSeconds,
            totalWords,
            booksFinished,
            currentStreak,
            longestStreak,
            streakMinMinutes,
            avgDailyMinutes = Math.Round(avgDailyMinutes, 1),
            avgWordsPerMinute = Math.Round(avgWordsPerMinute, 1),
            todaySeconds,
            weekSeconds,
            monthSeconds,
            dailyGoal = dailyGoalObj,
        });
    }

    private static async Task<IResult> GetDailyStats(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] DateTimeOffset? from,
        [FromQuery] DateTimeOffset? to,
        [FromQuery] string? tz,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var tzOffset = ParseTzOffset(tz);
        var now = DateTimeOffset.UtcNow;
        var start = from ?? now.AddDays(-90);
        var end = to ?? now;

        // Get raw sessions in range
        var sessions = await db.ReadingSessions
            .Where(s => s.UserId == userId.Value && s.SiteId == siteId
                && s.StartedAt >= start && s.StartedAt <= end)
            .Select(s => new { s.StartedAt, s.DurationSeconds, s.WordsRead })
            .ToListAsync(ct);

        // Group by local date
        var daily = sessions
            .GroupBy(s => s.StartedAt.ToOffset(tzOffset).Date)
            .Select(g => new DailyStatDto(
                g.Key,
                g.Sum(s => s.DurationSeconds),
                g.Sum(s => s.WordsRead),
                g.Count()))
            .OrderBy(d => d.Date)
            .ToList();

        return Results.Ok(daily);
    }

    // --- Goals ---

    private static async Task<IResult> GetGoals(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var goals = await db.ReadingGoals
            .Where(g => g.UserId == userId.Value && g.SiteId == siteId && g.IsActive)
            .Select(g => new GoalDto(g.Id, g.GoalType, g.TargetValue, g.Year, g.StreakMinMinutes, g.UpdatedAt))
            .ToListAsync(ct);

        return Results.Ok(goals);
    }

    private static async Task<IResult> CreateOrUpdateGoal(
        [FromBody] CreateGoalRequest request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        if (request.GoalType != "daily_minutes" && request.GoalType != "books_per_year")
            return Results.BadRequest("GoalType must be daily_minutes or books_per_year");
        if (request.TargetValue <= 0)
            return Results.BadRequest("TargetValue must be positive");

        var existing = await db.ReadingGoals
            .FirstOrDefaultAsync(g => g.UserId == userId.Value && g.SiteId == siteId
                && g.GoalType == request.GoalType, ct);

        if (existing != null)
        {
            existing.TargetValue = request.TargetValue;
            existing.Year = request.Year;
            existing.IsActive = true;
            if (request.StreakMinMinutes.HasValue)
                existing.StreakMinMinutes = request.StreakMinMinutes.Value;
            existing.UpdatedAt = DateTimeOffset.UtcNow;
        }
        else
        {
            existing = new ReadingGoal
            {
                Id = Guid.NewGuid(),
                UserId = userId.Value,
                SiteId = siteId,
                GoalType = request.GoalType,
                TargetValue = request.TargetValue,
                Year = request.Year,
                IsActive = true,
                StreakMinMinutes = request.StreakMinMinutes ?? 5,
                CreatedAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow,
            };
            db.ReadingGoals.Add(existing);
        }

        await db.SaveChangesAsync(ct);

        return Results.Ok(new GoalDto(existing.Id, existing.GoalType, existing.TargetValue,
            existing.Year, existing.StreakMinMinutes, existing.UpdatedAt));
    }

    private static async Task<IResult> DeleteGoal(
        Guid id,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();

        var goal = await db.ReadingGoals
            .FirstOrDefaultAsync(g => g.Id == id && g.UserId == userId.Value, ct);
        if (goal == null) return Results.NotFound();

        db.ReadingGoals.Remove(goal);
        await db.SaveChangesAsync(ct);

        return Results.NoContent();
    }

    // --- Achievements ---

    private static async Task<IResult> GetAchievements(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        CancellationToken ct)
    {
        var userId = GetUserId(httpContext, authService);
        if (userId == null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var unlocked = await db.UserAchievements
            .Where(a => a.UserId == userId.Value && a.SiteId == siteId)
            .Select(a => new AchievementDto(a.AchievementCode, a.UnlockedAt))
            .ToListAsync(ct);

        return Results.Ok(unlocked);
    }

    // --- Helpers ---

    private static TimeSpan ParseTzOffset(string? tz)
    {
        if (string.IsNullOrEmpty(tz)) return TimeSpan.Zero;
        if (int.TryParse(tz, out var minutes))
            return TimeSpan.FromMinutes(minutes);
        return TimeSpan.Zero;
    }

    private static DateTimeOffset GetDayStart(DateTimeOffset now, TimeSpan tzOffset)
    {
        var local = now.ToOffset(tzOffset);
        return new DateTimeOffset(local.Year, local.Month, local.Day, 0, 0, 0, tzOffset);
    }

    private static async Task<int> GetStreakMinMinutes(IAppDbContext db, Guid userId, Guid siteId, CancellationToken ct)
    {
        var goal = await db.ReadingGoals
            .Where(g => g.UserId == userId && g.SiteId == siteId && g.GoalType == "daily_minutes" && g.IsActive)
            .Select(g => (int?)g.StreakMinMinutes)
            .FirstOrDefaultAsync(ct);
        return goal ?? 5;
    }

    internal static async Task<int> CalculateStreak(
        IAppDbContext db, Guid userId, Guid siteId, int streakMinMinutes,
        DateTimeOffset now, CancellationToken ct)
    {
        // Get daily totals for last 365 days, ordered descending
        var since = now.AddDays(-365);
        var dailyTotals = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.SiteId == siteId && s.StartedAt >= since)
            .GroupBy(s => s.StartedAt.Date)
            .Select(g => new { Date = g.Key, TotalSeconds = g.Sum(s => s.DurationSeconds) })
            .OrderByDescending(d => d.Date)
            .ToListAsync(ct);

        if (dailyTotals.Count == 0) return 0;

        var thresholdSeconds = streakMinMinutes * 60;
        var qualifyingDates = dailyTotals
            .Where(d => d.TotalSeconds >= thresholdSeconds)
            .Select(d => d.Date)
            .ToHashSet();

        var today = now.Date;
        var streak = 0;
        var checkDate = today;

        // If today doesn't qualify, start from yesterday
        if (!qualifyingDates.Contains(checkDate))
            checkDate = checkDate.AddDays(-1);

        while (qualifyingDates.Contains(checkDate))
        {
            streak++;
            checkDate = checkDate.AddDays(-1);
        }

        return streak;
    }

    private static async Task<int> CalculateLongestStreak(
        IAppDbContext db, Guid userId, Guid siteId, int streakMinMinutes, CancellationToken ct)
    {
        var dailyTotals = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.SiteId == siteId)
            .GroupBy(s => s.StartedAt.Date)
            .Select(g => new { Date = g.Key, TotalSeconds = g.Sum(s => s.DurationSeconds) })
            .OrderBy(d => d.Date)
            .ToListAsync(ct);

        if (dailyTotals.Count == 0) return 0;

        var thresholdSeconds = streakMinMinutes * 60;
        var longest = 0;
        var current = 0;
        DateTime? lastDate = null;

        foreach (var day in dailyTotals)
        {
            if (day.TotalSeconds < thresholdSeconds)
            {
                current = 0;
                lastDate = null;
                continue;
            }

            if (lastDate.HasValue && (day.Date - lastDate.Value).Days == 1)
                current++;
            else
                current = 1;

            lastDate = day.Date;
            if (current > longest) longest = current;
        }

        return longest;
    }
}

// DTOs
public record SubmitSessionRequest(
    Guid? EditionId,
    Guid? UserBookId,
    DateTimeOffset StartedAt,
    DateTimeOffset EndedAt,
    int DurationSeconds,
    int WordsRead,
    double StartPercent,
    double EndPercent
);

public record SubmitSessionResponse(Guid SessionId, List<string> NewAchievements);

public record SessionDto(
    Guid Id, Guid? EditionId, Guid? UserBookId,
    DateTimeOffset StartedAt, DateTimeOffset EndedAt,
    int DurationSeconds, int WordsRead,
    double StartPercent, double EndPercent
);

public record DailyStatDto(DateTime Date, int TotalSeconds, int TotalWords, int SessionCount);

public record GoalDto(Guid Id, string GoalType, int TargetValue, int Year, int StreakMinMinutes, DateTimeOffset UpdatedAt);

public record CreateGoalRequest(string GoalType, int TargetValue, int Year, int? StreakMinMinutes);

public record AchievementDto(string Code, DateTimeOffset UnlockedAt);
