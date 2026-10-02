using Application.Common.Interfaces;
using Contracts.ReadingTracking;
using Microsoft.EntityFrameworkCore;

namespace Application.ReadingTracking;

/// <summary>
/// Read-only reading-statistics aggregations (R5). Behaviour is moved verbatim from the former
/// <c>ReadingTrackingEndpoints.GetBookStats</c> handler — the 6 <c>.ToListAsync()</c> materialization
/// boundaries and every in-memory aggregation are preserved byte-for-byte so the JSON response is
/// identical. Site scope is enforced by the R1b EF query filter (no explicit SiteId here).
/// </summary>
public class ReadingStatsService(IAppDbContext db)
{
    public async Task<BookStatsResponse> GetBookStatsAsync(Guid userId, int? year, CancellationToken ct)
    {
        // 1. Find finished editions: first session where EndPercent >= 0.99 per edition
        var finishEvents = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.EditionId != null && s.EndPercent >= 0.99)
            .GroupBy(s => s.EditionId!.Value)
            .Select(g => new { EditionId = g.Key, FinishedAt = g.Min(s => s.EndedAt) })
            .ToListAsync(ct);

        // Also find finished user books (with metadata for breakdowns)
        var userBookFinishEvents = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.UserBookId != null && s.EndPercent >= 0.99)
            .GroupBy(s => s.UserBookId!.Value)
            .Select(g => new { UserBookId = g.Key, FinishedAt = g.Min(s => s.EndedAt) })
            .ToListAsync(ct);

        // Available years (both editions and user books)
        var availableYears = finishEvents.Select(f => f.FinishedAt.Year)
            .Concat(userBookFinishEvents.Select(f => f.FinishedAt.Year))
            .Distinct()
            .OrderDescending()
            .ToList();

        // 2. Year filter
        if (year.HasValue && year.Value > 0)
        {
            finishEvents = finishEvents.Where(f => f.FinishedAt.Year == year.Value).ToList();
            userBookFinishEvents = userBookFinishEvents.Where(f => f.FinishedAt.Year == year.Value).ToList();
        }

        var editionIds = finishEvents.Select(f => f.EditionId).ToList();
        var finishMap = finishEvents.ToDictionary(f => f.EditionId, f => f.FinishedAt);
        var userBookIds = userBookFinishEvents.Select(f => f.UserBookId).ToList();
        var userBookFinishMap = userBookFinishEvents.ToDictionary(f => f.UserBookId, f => f.FinishedAt);

        // 3. Load edition metadata
        var editions = await db.Editions
            .Where(e => editionIds.Contains(e.Id))
            .Select(e => new
            {
                e.Id,
                e.Language,
                WordCount = e.Chapters.Sum(c => (int?)c.WordCount) ?? 0,
                Genres = e.Genres.Select(g => new { g.Name, g.Slug }).ToList(),
                Authors = e.EditionAuthors
                    .Where(ea => ea.Role == Domain.Enums.AuthorRole.Author)
                    .OrderBy(ea => ea.Order)
                    .Select(ea => new { ea.Author.Name, ea.Author.Slug })
                    .ToList(),
            })
            .ToListAsync(ct);

        // 3b. Load finished user book metadata
        var userBooks = userBookIds.Count > 0
            ? await db.UserBooks
                .Where(b => userBookIds.Contains(b.Id))
                .Select(b => new { b.Id, b.Language, b.Genre, b.Author, b.TotalWordCount })
                .ToListAsync(ct)
            : [];

        // 4. First session per edition (for avg days to finish)
        var firstSessions = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.EditionId != null && editionIds.Contains(s.EditionId!.Value))
            .GroupBy(s => s.EditionId!.Value)
            .Select(g => new { EditionId = g.Key, FirstStarted = g.Min(s => s.StartedAt) })
            .ToListAsync(ct);
        var firstSessionMap = firstSessions.ToDictionary(f => f.EditionId, f => f.FirstStarted);

        // 5. Reading time per edition (for pace + time-by-genre/author)
        var sessionsByEdition = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.EditionId != null && editionIds.Contains(s.EditionId!.Value))
            .GroupBy(s => s.EditionId!.Value)
            .Select(g => new { EditionId = g.Key, TotalSeconds = g.Sum(s => s.DurationSeconds), TotalWords = g.Sum(s => s.WordsRead) })
            .ToListAsync(ct);
        var sessionMap = sessionsByEdition.ToDictionary(s => s.EditionId);

        // --- Aggregations ---
        var userBookPages = userBooks.Sum(b => (b.TotalWordCount ?? 0)) / 250;
        var totalPages = editions.Sum(e => e.WordCount) / 250 + userBookPages;

        // Avg days to finish
        var daysToFinish = editions
            .Where(e => finishMap.ContainsKey(e.Id) && firstSessionMap.ContainsKey(e.Id))
            .Select(e => (finishMap[e.Id] - firstSessionMap[e.Id]).TotalDays)
            .ToList();
        var avgDaysToFinish = daysToFinish.Count > 0 ? Math.Round(daysToFinish.Average(), 1) : 0;

        // Genre stats (editions + user books with genre)
        var genreItems = editions
            .SelectMany(e => e.Genres.Select(g => new { g.Name, g.Slug }))
            .Concat(userBooks
                .Where(b => !string.IsNullOrEmpty(b.Genre))
                .Select(b => new { Name = b.Genre!, Slug = b.Genre!.ToLowerInvariant().Replace(' ', '-') }));
        var genreStats = genreItems
            .GroupBy(g => g.Slug)
            .Select(g => new GenreStatDto(g.First().Name, g.Key, g.Count()))
            .OrderByDescending(g => g.Count)
            .ToList();

        // Author stats (editions + user books with author)
        var authorItems = editions
            .SelectMany(e => e.Authors.Select(a => new { a.Name, a.Slug }))
            .Concat(userBooks
                .Where(b => !string.IsNullOrEmpty(b.Author))
                .Select(b => new { Name = b.Author!, Slug = b.Author!.ToLowerInvariant().Replace(' ', '-') }));
        var authorStats = authorItems
            .GroupBy(a => a.Slug)
            .Select(g => new AuthorStatDto(g.First().Name, g.Key, g.Count()))
            .OrderByDescending(a => a.Count)
            .Take(10)
            .ToList();

        // Language stats (editions + user books)
        var languageItems = editions.Select(e => e.Language)
            .Concat(userBooks.Select(b => b.Language));
        var languageStats = languageItems
            .GroupBy(l => l)
            .Select(g => new LanguageStatDto(g.Key, g.Count()))
            .OrderByDescending(l => l.Count)
            .ToList();

        // Books over time (editions + user books)
        var allFinishEvents = finishEvents
            .Select(f => new { f.FinishedAt, EditionId = (Guid?)f.EditionId, UserBookId = (Guid?)null })
            .Concat(userBookFinishEvents
                .Select(f => new { f.FinishedAt, EditionId = (Guid?)null, UserBookId = (Guid?)f.UserBookId }));
        var booksOverTime = allFinishEvents
            .GroupBy(f => year.HasValue && year.Value > 0
                ? f.FinishedAt.ToString("yyyy-MM")
                : f.FinishedAt.Year.ToString())
            .Select(g =>
            {
                var eIds = g.Where(f => f.EditionId != null).Select(f => f.EditionId!.Value).ToHashSet();
                var ubIds = g.Where(f => f.UserBookId != null).Select(f => f.UserBookId!.Value).ToHashSet();
                var pages = editions.Where(e => eIds.Contains(e.Id)).Sum(e => e.WordCount) / 250
                          + userBooks.Where(b => ubIds.Contains(b.Id)).Sum(b => (b.TotalWordCount ?? 0)) / 250;
                return new BooksOverTimeDto(g.Key, g.Count(), pages);
            })
            .OrderBy(b => b.Period)
            .ToList();

        // Book length distribution (editions + user books)
        var lengthPages = editions.Select(e => e.WordCount / 250)
            .Concat(userBooks.Where(b => b.TotalWordCount > 0).Select(b => b.TotalWordCount!.Value / 250));
        var lengthBuckets = lengthPages
            .GroupBy(p => p < 150 ? "short" : p < 400 ? "medium" : "long")
            .Select(g => new BookLengthBucketDto(g.Key, g.Count()))
            .ToList();

        // Pace stats (auto-calc: seconds per word → slow/medium/fast)
        var paceList = editions
            .Where(e => sessionMap.ContainsKey(e.Id) && e.WordCount > 0)
            .Select(e =>
            {
                var wpm = sessionMap[e.Id].TotalWords / Math.Max(1.0, sessionMap[e.Id].TotalSeconds / 60.0);
                return wpm < 150 ? "slow" : wpm < 300 ? "medium" : "fast";
            })
            .GroupBy(p => p)
            .Select(g => new PaceStatDto(g.Key, g.Count()))
            .ToList();

        // Reading time by genre
        var timeByGenre = editions
            .Where(e => sessionMap.ContainsKey(e.Id))
            .SelectMany(e => e.Genres.Select(g => new { g.Name, g.Slug, sessionMap[e.Id].TotalSeconds }))
            .GroupBy(x => x.Slug)
            .Select(g => new ReadingTimeStatDto(g.First().Name, g.Key, g.Sum(x => x.TotalSeconds)))
            .OrderByDescending(x => x.Seconds)
            .ToList();

        // Reading time by author
        var timeByAuthor = editions
            .Where(e => sessionMap.ContainsKey(e.Id))
            .SelectMany(e => e.Authors.Select(a => new { a.Name, a.Slug, sessionMap[e.Id].TotalSeconds }))
            .GroupBy(x => x.Slug)
            .Select(g => new ReadingTimeStatDto(g.First().Name, g.Key, g.Sum(x => x.TotalSeconds)))
            .OrderByDescending(x => x.Seconds)
            .Take(10)
            .ToList();

        return new BookStatsResponse(
            BooksFinished: editionIds.Count + userBookIds.Count,
            TotalPages: totalPages,
            AvgDaysToFinish: avgDaysToFinish,
            GenreStats: genreStats,
            AuthorStats: authorStats,
            LanguageStats: languageStats,
            BooksOverTime: booksOverTime,
            BookLengthDistribution: lengthBuckets,
            PaceStats: paceList,
            ReadingTimeByGenre: timeByGenre,
            ReadingTimeByAuthor: timeByAuthor,
            AvailableYears: availableYears
        );
    }

    /// <summary>
    /// Aggregate reading stats (R5 slice-3). Body moved verbatim from the former
    /// <c>ReadingTrackingEndpoints.GetStats</c> handler; the caller resolves the tz offset and passes
    /// <paramref name="now"/> (was <c>DateTimeOffset.UtcNow</c> inline) so the time-window boundaries are
    /// deterministic under test. Every server-side aggregate keeps its <c>(long)</c> cast and the daily-goal
    /// effective-minutes math is preserved, so the JSON is byte-identical. Site scope is enforced by the
    /// R1b EF query filter (no explicit SiteId here).
    /// </summary>
    public async Task<ReadingStatsResponse> GetStatsAsync(
        Guid userId, TimeSpan tzOffset, DateTimeOffset now, CancellationToken ct)
    {
        var allSessions = db.ReadingSessions
            .Where(s => s.UserId == userId);

        // Totals in one round trip (was three).
        var totals = await allSessions
            .GroupBy(_ => 1)
            .Select(g => new { Seconds = g.Sum(s => (long)s.DurationSeconds), Words = g.Sum(s => (long)s.WordsRead), Count = g.Count() })
            .FirstOrDefaultAsync(ct);
        var totalSeconds = totals?.Seconds ?? 0;
        var totalWords = totals?.Words ?? 0;
        var sessionCount = totals?.Count ?? 0;

        var booksFinished = await allSessions
            .Where(s => s.EndPercent >= 0.99)
            .Select(s => s.EditionId ?? s.UserBookId)
            .Distinct()
            .CountAsync(ct);

        // Time-period sums (calculate in user tz, convert to UTC for PostgreSQL)
        var todayLocal = StreakCalculator.GetDayStart(now, tzOffset);
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
        var streakMinMinutes = await StreakCalculator.GetStreakMinMinutes(db, userId, ct);
        var currentStreak = await StreakCalculator.CalculateStreak(db, userId, streakMinMinutes, now, ct, tzOffset);
        var longestStreak = await StreakCalculator.CalculateLongestStreak(db, userId, streakMinMinutes, ct, tzOffset);

        // Averages. Words-per-minute is a displayed measurement, so it is the real average (0 with
        // no data) — never the 200 wpm fallback, which is for estimates only (ReadingPace).
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

        // Vocab reviews today
        var todayVocabReviews = await db.VocabularyReviews
            .Where(r => r.UserId == userId && r.CreatedAt >= todayStart)
            .CountAsync(ct);

        // Daily goal (reading + vocab reviews as effective minutes)
        var dailyGoal = await db.ReadingGoals
            .Where(g => g.UserId == userId && g.GoalType == "daily_minutes" && g.IsActive)
            .FirstOrDefaultAsync(ct);

        DailyGoalStatusDto? dailyGoalObj = null;
        if (dailyGoal != null)
        {
            var effectiveTodayMinutes = todaySeconds / 60.0 + todayVocabReviews * 0.5;
            dailyGoalObj = new DailyGoalStatusDto(
                Target: dailyGoal.TargetValue,
                Today: Math.Round(effectiveTodayMinutes, 1),
                Met: effectiveTodayMinutes >= dailyGoal.TargetValue);
        }

        return new ReadingStatsResponse(
            TotalSeconds: totalSeconds,
            TotalWords: totalWords,
            BooksFinished: booksFinished,
            CurrentStreak: currentStreak,
            LongestStreak: longestStreak,
            StreakMinMinutes: streakMinMinutes,
            AvgDailyMinutes: Math.Round(avgDailyMinutes, 1),
            AvgWordsPerMinute: Math.Round(avgWordsPerMinute, 1),
            TodaySeconds: todaySeconds,
            TodayVocabReviews: todayVocabReviews,
            WeekSeconds: weekSeconds,
            MonthSeconds: monthSeconds,
            DailyGoal: dailyGoalObj);
    }

    /// <summary>
    /// Daily reading buckets (R5 slice-2). Body moved verbatim from the former
    /// <c>ReadingTrackingEndpoints.GetDailyStats</c> handler. The caller resolves the tz offset and
    /// the <paramref name="from"/>/<paramref name="to"/> defaults from the query string; here the
    /// single <c>.ToListAsync()</c> boundary and the in-memory <c>ToOffset(tzOffset).Date</c> day
    /// bucketing are preserved byte-for-byte so the JSON response is identical. Sessions near local
    /// midnight land in the day the tz offset shifts them into.
    /// </summary>
    public async Task<List<DailyStatDto>> GetDailyStatsAsync(
        Guid userId, DateTimeOffset from, DateTimeOffset to, TimeSpan tzOffset, CancellationToken ct)
    {
        // Get raw sessions in range
        var sessions = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.StartedAt >= from && s.StartedAt <= to)
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

        return daily;
    }

    /// <summary>
    /// Library summary card (slice 20 / R5 slice-3). Body moved verbatim from the former
    /// <c>ReadingTrackingEndpoints.GetLibrarySummary</c> handler; the <c>IMemoryCache</c> lookup/store stays
    /// in the caller (this service is cache-free). The caller resolves the tz offset and passes
    /// <paramref name="now"/> so the month/year window boundaries are deterministic. The integer division
    /// (words/250 → pages, seconds/60 → minutes) and the daily→yearly goal precedence are preserved so the
    /// JSON is byte-identical.
    /// </summary>
    public async Task<LibrarySummaryDto> GetLibrarySummaryAsync(
        Guid userId, TimeSpan tzOffset, DateTimeOffset now, CancellationToken ct)
    {
        var todayLocal = StreakCalculator.GetDayStart(now, tzOffset);
        var monthStart = new DateTimeOffset(todayLocal.Year, todayLocal.Month, 1, 0, 0, 0, tzOffset).ToUniversalTime();
        var yearStart = new DateTimeOffset(todayLocal.Year, 1, 1, 0, 0, 0, tzOffset).ToUniversalTime();

        var monthAgg = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.StartedAt >= monthStart)
            .GroupBy(_ => 1)
            .Select(g => new { Words = g.Sum(s => (long)s.WordsRead), Seconds = g.Sum(s => (long)s.DurationSeconds) })
            .FirstOrDefaultAsync(ct);

        var pagesThisMonth = (int)((monthAgg?.Words ?? 0) / 250);
        var minutesThisMonth = (int)((monthAgg?.Seconds ?? 0) / 60);

        var streakMinMinutes = await StreakCalculator.GetStreakMinMinutes(db, userId, ct);
        var currentStreak = await StreakCalculator.CalculateStreak(db, userId, streakMinMinutes, now, ct, tzOffset);

        var booksFinishedYtd = await db.ReadingSessions
            .Where(s => s.UserId == userId && s.EndPercent >= 0.99 && s.EndedAt >= yearStart)
            .Select(s => s.EditionId ?? s.UserBookId)
            .Distinct()
            .CountAsync(ct);

        var dailyGoal = await db.ReadingGoals
            .Where(g => g.UserId == userId && g.GoalType == "daily_minutes" && g.IsActive)
            .Select(g => new { g.TargetValue, g.StreakMinMinutes })
            .FirstOrDefaultAsync(ct);
        var yearlyGoal = await db.ReadingGoals
            .Where(g => g.UserId == userId && g.GoalType == "books_per_year" && g.IsActive)
            .Select(g => new { g.TargetValue, g.Year })
            .FirstOrDefaultAsync(ct);

        GoalSummaryDto? goal = null;
        if (dailyGoal != null)
        {
            var todayStart = todayLocal.ToUniversalTime();
            var todaySeconds = await db.ReadingSessions
                .Where(s => s.UserId == userId && s.StartedAt >= todayStart)
                .SumAsync(s => (long)s.DurationSeconds, ct);
            goal = new GoalSummaryDto("daily_minutes", (int)(todaySeconds / 60), dailyGoal.TargetValue);
        }
        else if (yearlyGoal != null)
        {
            goal = new GoalSummaryDto("books_per_year", booksFinishedYtd, yearlyGoal.TargetValue);
        }

        return new LibrarySummaryDto(
            PagesThisMonth: pagesThisMonth,
            MinutesThisMonth: minutesThisMonth,
            CurrentStreak: currentStreak,
            StreakMinMinutes: streakMinMinutes,
            BooksFinishedYtd: booksFinishedYtd,
            Goal: goal
        );
    }

    /// <summary>Reading pace — see <see cref="ReadingPace"/>, the one rule. Cache stays in the caller.</summary>
    public Task<ReadingPaceDto> GetPaceAsync(Guid userId, CancellationToken ct) =>
        ReadingPace.GetAsync(db, userId, ct);
}
