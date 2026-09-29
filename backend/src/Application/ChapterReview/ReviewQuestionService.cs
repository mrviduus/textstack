using Application.Common.Interfaces;
using Contracts.ChapterReview;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using TextStack.Vocabulary;

namespace Application.ChapterReview;

/// <summary>
/// The chapter-review questions' own SRS queue — a separate section of Practice, never mixed into
/// the word session (spec §11). Same stages and intervals as words: <see cref="ISrsEngine"/>.
/// </summary>
public sealed class ReviewQuestionService(IAppDbContext db, ISrsEngine srs)
{
    public const int DefaultLimit = 20, MaxLimit = 50;

    public async Task<DueReviewQuestionsDto> GetDueAsync(Guid userId, int limit, CancellationToken ct)
    {
        limit = Math.Clamp(limit, 1, MaxLimit);
        var now = DateTimeOffset.UtcNow;
        var due = db.ReviewQuestions.Where(q => q.UserId == userId && !q.IsRetired && q.NextReviewAt <= now);

        var total = await due.CountAsync(ct);
        var rows = await due
            .OrderBy(q => q.NextReviewAt)
            .Take(limit)
            .Select(q => new
            {
                q.Id,
                q.Prompt,
                q.Answer,
                q.BlockIndex,
                q.BookInsight.ReviewJson,
                q.BookInsight.ChapterSlug,
                q.BookInsight.UserBookId,
                q.BookInsight.EditionId,
            })
            .ToListAsync(ct);
        if (rows.Count == 0) return new(total, []);

        var userBookIds = rows.Where(r => r.UserBookId != null).Select(r => r.UserBookId!.Value).Distinct().ToList();
        var editionIds = rows.Where(r => r.EditionId != null).Select(r => r.EditionId!.Value).Distinct().ToList();
        var slugs = rows.Where(r => r.ChapterSlug != null).Select(r => r.ChapterSlug!).Distinct().ToList();

        var titles = new Dictionary<Guid, string>();
        var chapterTitles = new Dictionary<(Guid, string), string>();
        if (userBookIds.Count > 0)
        {
            foreach (var b in await db.UserBooks.Where(b => userBookIds.Contains(b.Id)).Select(b => new { b.Id, b.Title }).ToListAsync(ct))
                titles[b.Id] = b.Title;
            foreach (var c in await db.UserChapters
                .Where(c => userBookIds.Contains(c.UserBookId) && c.Slug != null && slugs.Contains(c.Slug))
                .Select(c => new { c.UserBookId, c.Slug, c.Title }).ToListAsync(ct))
                chapterTitles[(c.UserBookId, c.Slug!)] = c.Title;
        }
        if (editionIds.Count > 0)
        {
            foreach (var e in await db.Editions.Where(e => editionIds.Contains(e.Id)).Select(e => new { e.Id, e.Title }).ToListAsync(ct))
                titles[e.Id] = e.Title;
            foreach (var c in await db.Chapters
                .Where(c => editionIds.Contains(c.EditionId) && c.Slug != null && slugs.Contains(c.Slug))
                .Select(c => new { c.EditionId, c.Slug, c.Title }).ToListAsync(ct))
                chapterTitles[(c.EditionId, c.Slug!)] = c.Title;
        }

        var items = rows.Select(r =>
        {
            var bookId = r.UserBookId ?? r.EditionId!.Value;
            var block = ChapterReviewService.ReadStored(r.ReviewJson)?.Blocks.ElementAtOrDefault(r.BlockIndex);
            return new DueReviewQuestionDto(
                r.Id, r.Prompt, r.Answer, block?.Title, block?.Rule,
                titles.GetValueOrDefault(bookId, ""),
                r.ChapterSlug is { } s ? chapterTitles.GetValueOrDefault((bookId, s)) : null,
                r.ChapterSlug, r.UserBookId, r.EditionId);
        }).ToList();

        return new(total, items);
    }

    /// <summary>Null when the question does not exist or is not this user's.</summary>
    public async Task<AnswerReviewQuestionResponse?> AnswerAsync(
        Guid userId, Guid questionId, bool knew, CancellationToken ct)
    {
        var q = await db.ReviewQuestions.FirstOrDefaultAsync(x => x.Id == questionId && x.UserId == userId, ct);
        if (q is null) return null;

        Apply(q, knew, srs, DateTimeOffset.UtcNow);
        await db.SaveChangesAsync(ct);
        return new(q.Stage, q.NextReviewAt, q.IsRetired);
    }

    /// <summary>
    /// Maps a self-assessment to correctness the way <c>FlashCard.tsx</c> does: only "knew" is
    /// correct. Null for anything else than forgot / almost / knew.
    /// </summary>
    public static bool? IsCorrect(string? selfAssessment) => selfAssessment switch
    {
        "knew" => true,
        "almost" or "forgot" => false,
        _ => null,
    };

    /// <summary>One answer → new SRS state, retiring the question once it is truly learned. Pure.</summary>
    public static void Apply(ReviewQuestion q, bool isCorrect, ISrsEngine srs, DateTimeOffset now)
    {
        var (stage, interval, consecutive) = srs.Calculate(q.Stage, q.ConsecutiveCorrect, q.IntervalDays, isCorrect);
        q.Stage = stage;
        q.IntervalDays = interval;
        q.ConsecutiveCorrect = consecutive;
        q.NextReviewAt = now.AddDays(interval);
        q.LastReviewedAt = now;
        q.TotalReviews++;
        if (isCorrect) q.CorrectReviews++;
        if (srs.ShouldAutoRetire(stage, consecutive, interval)) q.IsRetired = true;
        q.UpdatedAt = now;
    }
}
