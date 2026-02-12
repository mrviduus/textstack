using Application.Common.Interfaces;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;

namespace Application.ReadingTracking;

public class AchievementChecker
{
    private readonly IAppDbContext _db;

    public AchievementChecker(IAppDbContext db)
    {
        _db = db;
    }

    public async Task<List<string>> CheckAfterSession(
        Guid userId, Guid siteId, ReadingSession session, int currentStreak,
        CancellationToken ct)
    {
        var unlocked = await _db.UserAchievements
            .Where(a => a.UserId == userId && a.SiteId == siteId)
            .Select(a => a.AchievementCode)
            .ToHashSetAsync(ct);

        var newAchievements = new List<string>();

        void TryUnlock(string code)
        {
            if (unlocked.Contains(code)) return;
            unlocked.Add(code);
            newAchievements.Add(code);
            _db.UserAchievements.Add(new UserAchievement
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                SiteId = siteId,
                AchievementCode = code,
                UnlockedAt = DateTimeOffset.UtcNow,
            });
        }

        // First session
        var sessionCount = await _db.ReadingSessions
            .CountAsync(s => s.UserId == userId && s.SiteId == siteId, ct);
        if (sessionCount == 1) TryUnlock("first_session");

        // Books finished (sessions that end at >= 99%)
        var booksFinished = await _db.ReadingSessions
            .Where(s => s.UserId == userId && s.SiteId == siteId && s.EndPercent >= 0.99)
            .Select(s => s.EditionId ?? s.UserBookId)
            .Distinct()
            .CountAsync(ct);

        if (booksFinished >= 1) TryUnlock("first_book");
        if (booksFinished >= 5) TryUnlock("books_5");
        if (booksFinished >= 10) TryUnlock("books_10");
        if (booksFinished >= 25) TryUnlock("books_25");
        if (booksFinished >= 50) TryUnlock("books_50");

        // Streak
        if (currentStreak >= 3) TryUnlock("streak_3");
        if (currentStreak >= 7) TryUnlock("streak_7");
        if (currentStreak >= 14) TryUnlock("streak_14");
        if (currentStreak >= 30) TryUnlock("streak_30");
        if (currentStreak >= 100) TryUnlock("streak_100");

        // Total hours
        var totalSeconds = await _db.ReadingSessions
            .Where(s => s.UserId == userId && s.SiteId == siteId)
            .SumAsync(s => (long)s.DurationSeconds, ct);
        var totalHours = totalSeconds / 3600.0;

        if (totalHours >= 1) TryUnlock("hours_1");
        if (totalHours >= 10) TryUnlock("hours_10");
        if (totalHours >= 50) TryUnlock("hours_50");
        if (totalHours >= 100) TryUnlock("hours_100");

        // Time-of-day achievements (use session's startedAt hour)
        var hour = session.StartedAt.Hour;
        if (hour >= 5 && hour < 7) TryUnlock("early_bird");
        if (hour >= 23 || hour < 3) TryUnlock("night_owl");

        // Speed reader (WPM > 400)
        if (session.DurationSeconds > 0 && session.WordsRead > 0)
        {
            var wpm = session.WordsRead / (session.DurationSeconds / 60.0);
            if (wpm > 400) TryUnlock("speed_reader");
        }

        // Marathon (> 2 hours)
        if (session.DurationSeconds > 7200) TryUnlock("marathon");

        if (newAchievements.Count > 0)
            await _db.SaveChangesAsync(ct);

        return newAchievements;
    }
}
