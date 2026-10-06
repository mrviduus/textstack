namespace Api.Endpoints;

/// <summary>
/// Reading-tracking HTTP surface. Routes registered via <see cref="MapReadingTrackingEndpoints"/>;
/// handlers are split across partial files by sub-domain to keep each file reviewable:
///
///   - ReadingTrackingEndpoints.Sessions.cs      SubmitSession, GetSessions
///   - ReadingTrackingEndpoints.Stats.cs         GetStats, GetDailyStats
///   - ReadingTrackingEndpoints.Goals.cs         GetGoals, CreateOrUpdateGoal, DeleteGoal
///   - ReadingTrackingEndpoints.Achievements.cs  GetAchievements
///   - ReadingTrackingEndpoints.BookStats.cs     GetBookStats
///   - ReadingTrackingEndpoints.Summary.cs       GetLibrarySummary, GetPace
///
/// This file keeps the route table + the tz query-parse helper + the session/goal request DTOs.
/// The stats aggregations live in <see cref="Application.ReadingTracking.ReadingStatsService"/> and the
/// streak/local-day helpers in <see cref="Application.ReadingTracking.StreakCalculator"/> (R5). Splits use
/// C# `partial` — compile-identical to the original monolithic file.
/// </summary>
public static partial class ReadingTrackingEndpoints
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
        group.MapGet("/book-stats", GetBookStats).WithName("GetBookStats");
        group.MapGet("/pace", GetPace).WithName("GetReadingPace");
        group.MapGet("/library-summary", GetLibrarySummary).WithName("GetLibrarySummary");
    }

    // --- Helpers ---

    /// <summary>
    /// The client's UTC offset in minutes (<c>-new Date().getTimezoneOffset()</c>). Anything that is
    /// not a real offset (beyond ±14h) is UTC: <see cref="DateTimeOffset.ToOffset"/> throws on it.
    /// </summary>
    internal static TimeSpan ParseTzOffset(string? tz) =>
        int.TryParse(tz, out var minutes) && Math.Abs(minutes) <= 14 * 60
            ? TimeSpan.FromMinutes(minutes)
            : TimeSpan.Zero;
}

// DTOs
// SubmitSessionRequest/SubmitSessionResponse moved to Contracts.ReadingTracking (R5 slice-4),
// beside the ReadingSessionService that consumes them.
public record SessionDto(
    Guid Id, Guid? EditionId, Guid? UserBookId,
    DateTimeOffset StartedAt, DateTimeOffset EndedAt,
    int DurationSeconds, int WordsRead,
    double StartPercent, double EndPercent
);

public record GoalDto(Guid Id, string GoalType, int TargetValue, int Year, int StreakMinMinutes, DateTimeOffset UpdatedAt);

public record CreateGoalRequest(string GoalType, int TargetValue, int Year, int? StreakMinMinutes);

public record AchievementDto(string Code, DateTimeOffset UnlockedAt);
