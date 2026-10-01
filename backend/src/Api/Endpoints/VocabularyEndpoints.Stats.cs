using Application.Auth;
using Application.Common.Interfaces;
using Application.Vocabulary;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Api.Endpoints;

/// <summary>
/// Stats endpoints — overview (`GET /me/vocabulary/stats`) for the home
/// card + per-day aggregation (`GET /me/vocabulary/stats/daily`) for the
/// calendar heatmap. Pure read-side; no writes.
/// </summary>
public static partial class VocabularyEndpoints
{
    private static async Task<IResult> GetStats(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        WeeklyBudgetService weeklyBudget,
        DailyCapService dailyCap,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var now = DateTimeOffset.UtcNow;
        var todayStart = new DateTimeOffset(now.Date, TimeSpan.Zero);

        // Base scope: everything the user owns. Stage breakdown + totalWords
        // keep retired rows (user still wants to see "2000 mastered" even if
        // they no longer appear in the queue).
        var words = db.VocabularyWords
            .Where(w => w.UserId == userId);

        var totalWords = await words.CountAsync(ct);

        var byStage = await words
            .GroupBy(w => w.Stage)
            .Select(g => new { Stage = g.Key, Count = g.Count() })
            .ToListAsync(ct);

        var stageDict = byStage.ToDictionary(s => s.Stage, s => s.Count);
        // dueNow intentionally excludes retired rows — matches what the review
        // queue actually returns, so the banner never over-promises work.
        var dueNow = await words.CountAsync(w => !w.IsRetired && w.NextReviewAt <= now, ct);
        var retiredCount = await words.CountAsync(w => w.IsRetired, ct);

        // Single query for today's review stats
        var todayStats = await db.VocabularyReviews
            .Where(r => r.UserId == userId && r.CreatedAt >= todayStart)
            .GroupBy(_ => 1)
            .Select(g => new
            {
                Total = g.Count(),
                Correct = g.Count(r => r.IsCorrect),
                Practice = g.Count(r => r.ReviewMode.StartsWith("practice_")),
                PracticeCorrect = g.Count(r => r.ReviewMode.StartsWith("practice_") && r.IsCorrect),
            })
            .FirstOrDefaultAsync(ct);

        var reviewedToday = todayStats?.Total ?? 0;
        var correctToday = todayStats?.Correct ?? 0;
        var practiceToday = todayStats?.Practice ?? 0;
        var practiceCorrectToday = todayStats?.PracticeCorrect ?? 0;
        var srsReviewedToday = reviewedToday - practiceToday;
        var srsCorrectToday = correctToday - practiceCorrectToday;

        // Single query for all-time review stats
        var allStats = await db.VocabularyReviews
            .Where(r => r.UserId == userId)
            .GroupBy(_ => 1)
            .Select(g => new { Total = g.Count(), Correct = g.Count(r => r.IsCorrect) })
            .FirstOrDefaultAsync(ct);

        var totalReviews = allStats?.Total ?? 0;
        var totalCorrect = allStats?.Correct ?? 0;

        // Streak: consecutive days with reviews (HashSet for O(1) lookup)
        var reviewDays = (await db.VocabularyReviews
            .Where(r => r.UserId == userId)
            .Select(r => r.CreatedAt.Date)
            .Distinct()
            .OrderByDescending(d => d)
            .Take(365)
            .ToListAsync(ct))
            .ToHashSet();

        var streak = 0;
        var checkDate = now.Date;
        if (!reviewDays.Contains(checkDate))
            checkDate = checkDate.AddDays(-1);
        while (reviewDays.Contains(checkDate))
        {
            streak++;
            checkDate = checkDate.AddDays(-1);
        }

        var wordsByBook = await words
            .Where(w => w.BookTitle != null)
            .GroupBy(w => new { w.EditionId, w.UserBookId, w.BookTitle })
            .Select(g => new { g.Key.EditionId, g.Key.UserBookId, g.Key.BookTitle, Count = g.Count() })
            .OrderByDescending(b => b.Count)
            .Take(20)
            .ToListAsync(ct);

        var weeklyProgress = ToDto(await weeklyBudget.GetProgressAsync(userId, siteId, ct));
        var capStatus = await dailyCap.GetStatusAsync(userId, siteId, ct);
        var pendingCount = await db.PendingVocabularyWords
            .CountAsync(p => p.UserId == userId, ct);
        var lookupCount = await db.WordLookups
            .CountAsync(l => l.UserId == userId, ct);
        var clusterCount = await db.WordClusters
            .CountAsync(c => c.UserId == userId && !c.IsDismissed && c.CompletedAt == null, ct);

        return Results.Ok(new
        {
            totalWords,
            byStage = new
            {
                @new = stageDict.GetValueOrDefault(0),
                recognition = stageDict.GetValueOrDefault(1),
                recall = stageDict.GetValueOrDefault(2),
                context = stageDict.GetValueOrDefault(3),
                mastered = stageDict.GetValueOrDefault(4),
            },
            dueNow,
            retiredCount,
            pendingCount,
            lookupCount,
            clusterCount,
            weeklyProgress,
            dailyCap = new { used = capStatus.Used, cap = capStatus.Cap, remaining = capStatus.Remaining },
            reviewedToday,
            correctRateToday = reviewedToday > 0 ? Math.Round((double)correctToday / reviewedToday * 100, 1) : 0,
            srsReviewedToday,
            srsCorrectRateToday = srsReviewedToday > 0 ? Math.Round((double)srsCorrectToday / srsReviewedToday * 100, 1) : 0,
            practicedToday = practiceToday,
            practiceCorrectRateToday = practiceToday > 0 ? Math.Round((double)practiceCorrectToday / practiceToday * 100, 1) : 0,
            totalReviews,
            overallCorrectRate = totalReviews > 0 ? Math.Round((double)totalCorrect / totalReviews * 100, 1) : 0,
            streak,
            wordsByBook,
        });
    }

    // --- Daily Stats ---

    private static async Task<IResult> GetDailyStats(
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        [FromQuery] DateTimeOffset? from,
        [FromQuery] DateTimeOffset? to,
        [FromQuery] string? tz,
        CancellationToken ct)
    {
        if (!TryGetAuth(httpContext, authService, out var userId, out var siteId))
            return Results.Unauthorized();

        var tzOffset = ReadingTrackingEndpoints.ParseTzOffset(tz);
        var now = DateTimeOffset.UtcNow;
        var start = from ?? now.AddDays(-365);
        var end = to ?? now;

        // Reviews per day
        var reviews = await db.VocabularyReviews
            .Where(r => r.UserId == userId && r.CreatedAt >= start && r.CreatedAt <= end)
            .Select(r => new { r.CreatedAt, r.IsCorrect, r.ReviewMode })
            .ToListAsync(ct);

        var reviewsByDay = reviews
            .GroupBy(r => r.CreatedAt.ToOffset(tzOffset).Date)
            .ToDictionary(
                g => g.Key,
                g => new
                {
                    ReviewCount = g.Count(),
                    CorrectCount = g.Count(r => r.IsCorrect),
                    PracticeCount = g.Count(r => r.ReviewMode.StartsWith("practice_")),
                    SrsCount = g.Count(r => !r.ReviewMode.StartsWith("practice_")),
                });

        // Words added per day
        var words = await db.VocabularyWords
            .Where(w => w.UserId == userId && w.CreatedAt >= start && w.CreatedAt <= end)
            .Select(w => w.CreatedAt)
            .ToListAsync(ct);

        var wordsByDay = words
            .GroupBy(d => d.ToOffset(tzOffset).Date)
            .ToDictionary(g => g.Key, g => g.Count());

        // Merge all dates
        var allDates = reviewsByDay.Keys.Union(wordsByDay.Keys).OrderBy(d => d);

        var result = allDates.Select(date =>
        {
            reviewsByDay.TryGetValue(date, out var r);
            return new
            {
                date,
                wordsAdded = wordsByDay.GetValueOrDefault(date, 0),
                reviewCount = r?.ReviewCount ?? 0,
                correctCount = r?.CorrectCount ?? 0,
                practiceCount = r?.PracticeCount ?? 0,
                srsCount = r?.SrsCount ?? 0,
            };
        }).ToList();

        return Results.Ok(result);
    }
}
