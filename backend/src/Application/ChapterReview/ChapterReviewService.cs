using System.Text.Json;
using Application.Common.Interfaces;
using Contracts.ChapterReview;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Application.ChapterReview;

/// <summary>A service outcome: a value, or an HTTP status with the error body the endpoint returns.</summary>
public sealed record ReviewResult<T>(T? Value, int Status, ReviewErrorDto? Error)
{
    public static ReviewResult<T> Ok(T value) => new(value, 200, null);
    public static ReviewResult<T> Fail(int status, ReviewErrorDto error) => new(default, status, error);
}

/// <summary>
/// Chapter review — the context a review needs (tool <c>get_chapter_review</c>) and the save
/// (tool <c>save_chapter_review</c>). We run no LLM: the reader's own assistant does the reviewing,
/// and only the structured result comes home. Spec: docs/05-features/chapter-review.md; storage ADR-016.
/// Guests may use it — it costs us no inference (owner decision 2026-09-29).
/// </summary>
public sealed class ChapterReviewService(IAppDbContext db, ILogger<ChapterReviewService> logger)
{
    /// <summary>Saved words sent with the context; enough to be useful, bounded for the tool result.</summary>
    public const int MaxWords = 200;
    public const int MaxPart = 20;
    public const string InsightQuestion = "Chapter review";

    internal static readonly JsonSerializerOptions StoreOptions = new(JsonSerializerDefaults.Web);

    /// <summary>Stored <c>review_json</c> → DTO; null for a plain insight or unreadable JSON.</summary>
    public static ChapterReviewDto? ReadStored(string? reviewJson)
    {
        if (string.IsNullOrWhiteSpace(reviewJson)) return null;
        try { return JsonSerializer.Deserialize<ChapterReviewDto>(reviewJson, StoreOptions); }
        catch (JsonException) { return null; }
    }

    // ── GET /me/chapter-review ─────────────────────────────────────────────────────────────────────

    public async Task<ReviewResult<ChapterReviewContextDto>> GetContextAsync(
        Guid userId, Guid? userBookId, Guid? editionId, string? chapterSlug, int part, CancellationToken ct)
    {
        if (part is < 1 or > MaxPart)
            return ReviewResult<ChapterReviewContextDto>.Fail(400, new("bad_request", $"part must be 1–{MaxPart}"));

        var (target, fail) = await ResolveAsync(userId, userBookId, editionId, chapterSlug, ct);
        if (target is null) return ReviewResult<ChapterReviewContextDto>.Fail(fail!.Value.Status, fail.Value.Error);

        var plainText = target.IsUpload
            ? await db.UserChapters.Where(c => c.Id == target.Chapter.Id).Select(c => c.PlainText).FirstAsync(ct)
            : await db.Chapters.Where(c => c.Id == target.Chapter.Id).Select(c => c.PlainText).FirstAsync(ct);

        var parts = ChapterParts.Split(plainText);
        if (part > parts.Count)
            return ReviewResult<ChapterReviewContextDto>.Fail(400,
                new("bad_request", $"part {part} does not exist — this chapter has {parts.Count} part(s)"));

        var chapter = new ReviewChapterDto(target.Chapter.Slug!, target.Chapter.Title, part, parts.Count, parts[part - 1]);
        if (part > 1) return ReviewResult<ChapterReviewContextDto>.Ok(new(target.Book, chapter));

        var highlights = await LoadHighlightsAsync(userId, target, ct);
        var inChapter = highlights
            .Where(h => HighlightPlacement.IsIn(h.Ref, target.Chapter))
            .OrderBy(h => h.CreatedAt)
            .Select(h => new ReviewHighlightDto(h.Ref.Id, h.Text, h.Note))
            .ToList();

        var words = await LoadWordsAsync(userId, target, plainText, ct);
        var openThreads = OpenThreads.Compute(target.Reviews, target.Chapter.Number);
        var existing = target.Reviews.FirstOrDefault(r => r.ChapterSlug == target.Chapter.Slug)?.Review;

        return ReviewResult<ChapterReviewContextDto>.Ok(new(
            target.Book, chapter, ReviewMethod.Text, ReviewMethod.Version,
            inChapter, words, openThreads, existing,
            RecallRequired: inChapter.Count == 0,
            SaveWith: "save_chapter_review"));
    }

    // ── PUT /me/chapter-review ─────────────────────────────────────────────────────────────────────

    public async Task<ReviewResult<ChapterReviewSavedDto>> SaveAsync(
        Guid userId, Guid siteId, SaveChapterReviewRequest request, CancellationToken ct)
    {
        var (target, fail) = await ResolveAsync(userId, request.UserBookId, request.EditionId, request.ChapterSlug, ct);
        if (target is null) return ReviewResult<ChapterReviewSavedDto>.Fail(fail!.Value.Status, fail.Value.Error);

        var (input, parseError) = ChapterReviewValidator.Parse(request.Review);
        if (input is null) return Rejected(target, [parseError!]);

        var highlights = await LoadHighlightsAsync(userId, target, ct);
        var bookHighlights = highlights.ToDictionary(
            h => h.Ref.Id, h => HighlightPlacement.ChapterNumberOf(h.Ref, target.Chapters));
        var targetHighlights = highlights
            .Where(h => HighlightPlacement.IsIn(h.Ref, target.Chapter))
            .Select(h => h.Ref.Id)
            .ToHashSet();
        var openThreads = OpenThreads.Compute(target.Reviews, target.Chapter.Number);

        var errors = ChapterReviewValidator.Validate(
            input, new ReviewValidationContext(target.Chapter.Number, bookHighlights, targetHighlights, openThreads));
        if (errors.Count > 0) return Rejected(target, errors);

        var slug = target.Chapter.Slug!;
        var review = new ChapterReviewDto(
            ReviewMethod.Version,
            string.IsNullOrWhiteSpace(input.Recall) ? null : input.Recall.Trim(),
            input.Blocks!.Select(b => new ReviewBlockDto(
                b!.Title!.Trim(), b.Problem!.Trim(), b.RootCause!.Trim(), b.Rule!.Trim(),
                b.HighlightIds!.Select(id => Guid.Parse(id!)).Distinct().ToList(),
                new ReviewQuestionDto(b.Question!.Prompt!.Trim(), b.Question.Answer!.Trim()))).ToList(),
            input.Applications!.Select(a => a!.Trim()).ToList(),
            (input.OpenThreads ?? [])
                .Select(t => new ReviewThreadDto(OpenThreads.ThreadId(slug, t!.Text!), t.Text!.Trim()))
                .DistinctBy(t => t.Id)
                .ToList(),
            (input.ClosedThreadIds ?? []).Select(id => id!).Distinct().ToList());

        var closedTexts = openThreads.ToDictionary(t => t.Id, t => t.Text);
        var now = DateTimeOffset.UtcNow;

        var insight = await db.BookInsights.FirstOrDefaultAsync(
            i => i.UserId == userId
                && i.UserBookId == request.UserBookId
                && i.EditionId == request.EditionId
                && i.ChapterSlug == slug,
            ct);
        if (insight is null)
        {
            insight = new BookInsight
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                SiteId = siteId,
                EditionId = request.EditionId,
                UserBookId = request.UserBookId,
                ChapterSlug = slug,
                Source = "mcp",
                CreatedAt = now,
            };
            db.BookInsights.Add(insight);
        }
        insight.ReviewJson = JsonSerializer.Serialize(review, StoreOptions);
        insight.Text = ReviewMarkdownRenderer.Render(review, target.Chapter.Title, closedTexts);
        insight.Question = InsightQuestion;
        insight.UpdatedAt = now;

        await SyncQuestionsAsync(insight.Id, userId, siteId, review, now, ct);
        await db.SaveChangesAsync(ct);

        logger.LogInformation(
            "chapter_review.saved bookKind={BookKind} blocks={Blocks} questions={Questions} threadsOpened={ThreadsOpened} threadsClosed={ThreadsClosed}",
            target.Book.Kind, review.Blocks.Count, review.Blocks.Count, review.OpenThreads.Count, review.ClosedThreadIds.Count);

        return ReviewResult<ChapterReviewSavedDto>.Ok(new(
            true, insight.Id, slug, review.Blocks.Count, review.OpenThreads, review.ClosedThreadIds, now));
    }

    private ReviewResult<ChapterReviewSavedDto> Rejected(Target target, IReadOnlyList<ReviewFieldErrorDto> errors)
    {
        logger.LogInformation(
            "chapter_review.rejected bookKind={BookKind} errorCount={ErrorCount} codes={Codes}",
            target.Book.Kind, errors.Count, string.Join(",", errors.Select(e => e.Code).Distinct()));
        var noun = errors.Count == 1 ? "problem" : "problems";
        return ReviewResult<ChapterReviewSavedDto>.Fail(400, new(
            "review_invalid",
            $"{errors.Count} {noun} — fix all of them and call save_chapter_review again.",
            errors));
    }

    /// <summary>
    /// Questions follow the review by prompt: an unchanged prompt keeps its SRS state (answer and
    /// position refreshed), a removed one is deleted, a new one starts due now.
    /// </summary>
    private async Task SyncQuestionsAsync(
        Guid insightId, Guid userId, Guid siteId, ChapterReviewDto review, DateTimeOffset now, CancellationToken ct)
    {
        var existing = await db.ReviewQuestions.Where(q => q.BookInsightId == insightId).ToListAsync(ct);
        var byHash = existing.ToDictionary(q => q.PromptHash, StringComparer.Ordinal);
        var kept = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < review.Blocks.Count; i++)
        {
            var question = review.Blocks[i].Question;
            var hash = OpenThreads.PromptHash(question.Prompt);
            kept.Add(hash);
            if (byHash.TryGetValue(hash, out var q))
            {
                q.Prompt = question.Prompt;
                q.Answer = question.Answer;
                q.BlockIndex = i;
                q.UpdatedAt = now;
                continue;
            }
            db.ReviewQuestions.Add(new ReviewQuestion
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                SiteId = siteId,
                BookInsightId = insightId,
                BlockIndex = i,
                Prompt = question.Prompt,
                Answer = question.Answer,
                PromptHash = hash,
                NextReviewAt = now,
                CreatedAt = now,
                UpdatedAt = now,
            });
        }

        db.ReviewQuestions.RemoveRange(existing.Where(q => !kept.Contains(q.PromptHash)));
    }

    // ── shared resolution: target → book → chapter → spoiler gate ─────────────────────────────────

    private sealed record Target(
        ReviewBookDto Book,
        bool IsUpload,
        Guid BookId,
        IReadOnlyList<ChapterRef> Chapters,
        ChapterRef Chapter,
        IReadOnlyList<PlacedReview> Reviews);

    private readonly record struct Failure(int Status, ReviewErrorDto Error);

    private async Task<(Target?, Failure?)> ResolveAsync(
        Guid userId, Guid? userBookId, Guid? editionId, string? chapterSlug, CancellationToken ct)
    {
        if (userBookId.HasValue == editionId.HasValue)
            return (null, new(400, new("bad_request", "Provide exactly one of userBookId or editionId")));
        var slug = chapterSlug?.Trim();
        if (string.IsNullOrEmpty(slug) || slug.Length > 300)
            return (null, new(400, new("bad_request", "chapterSlug is required (at most 300 characters)")));

        ReviewBookDto book;
        List<ChapterRef> chapters;
        ProgressSnapshot? progress;

        if (userBookId is { } ubId)
        {
            var ub = await db.UserBooks
                .Where(b => b.Id == ubId && b.UserId == userId)
                .Select(b => new
                {
                    b.Title,
                    b.Author,
                    b.CompletedAt,
                    b.ProgressPercent,
                    b.ProgressChapterSlug,
                    b.ProgressLocator,
                })
                .FirstOrDefaultAsync(ct);
            if (ub is null) return (null, new(404, new("not_found", "User book not found")));

            book = new ReviewBookDto("userbook", ubId, null, ub.Title, ub.Author);
            chapters = await db.UserChapters
                .Where(c => c.UserBookId == ubId)
                .Select(c => new ChapterRef(c.Id, c.Slug, c.ChapterNumber, c.Title, c.SourceStartPage, c.SourceEndPage))
                .ToListAsync(ct);
            progress = new ProgressSnapshot(
                ub.CompletedAt, Percent: ub.ProgressPercent, ChapterSlug: ub.ProgressChapterSlug,
                Locator: ub.ProgressLocator, IsUpload: true);
        }
        else
        {
            var edId = editionId!.Value;
            var ed = await db.Editions
                .Where(e => e.Id == edId)
                .Select(e => new
                {
                    e.Title,
                    Author = e.EditionAuthors.OrderBy(a => a.Order).Select(a => a.Author.Name).FirstOrDefault(),
                })
                .FirstOrDefaultAsync(ct);
            if (ed is null) return (null, new(404, new("not_found", "Edition not found")));

            book = new ReviewBookDto("catalog", null, edId, ed.Title, ed.Author);
            chapters = await db.Chapters
                .Where(c => c.EditionId == edId)
                .Select(c => new ChapterRef(c.Id, c.Slug, c.ChapterNumber, c.Title, null, null))
                .ToListAsync(ct);
            progress = await db.ReadingProgresses
                .Where(p => p.UserId == userId && p.EditionId == edId)
                .Select(p => new ProgressSnapshot(p.CompletedAt, p.MaxChapterNumber, p.ChapterId, null, null, null, false))
                .FirstOrDefaultAsync(ct);
        }

        var chapter = chapters.FirstOrDefault(c => c.Slug == slug);
        if (chapter is null)
            return (null, new(404, new("not_found", $"No chapter '{slug}' in this book")));

        var bookId = userBookId ?? editionId!.Value;
        var reviewRows = await db.BookInsights
            .Where(i => i.UserId == userId && i.ReviewJson != null && i.ChapterSlug != null
                && (userBookId.HasValue ? i.UserBookId == bookId : i.EditionId == bookId))
            .Select(i => new { i.ChapterSlug, i.ReviewJson })
            .ToListAsync(ct);
        var reviews = reviewRows
            .Select(r => (r.ChapterSlug, Review: ReadStored(r.ReviewJson), Chapter: chapters.FirstOrDefault(c => c.Slug == r.ChapterSlug)))
            .Where(r => r.Review is not null)
            .Select(r => new PlacedReview(r.ChapterSlug!, r.Chapter?.Number, r.Chapter?.Title ?? r.ChapterSlug!, r.Review!))
            .ToList();

        var maxReviewed = reviews.Max(r => r.ChapterNumber);
        var frontier = ChapterFrontier.Resolve(progress, chapters, maxReviewed);
        if (frontier is null || chapter.Number > frontier)
        {
            var current = frontier is { } f
                ? chapters.Where(c => c.Number <= f).OrderBy(c => c.Number).LastOrDefault()
                : null;
            var at = current is null ? "they have not started it" : $"they are at '{current.Title}'";
            return (null, new(409, new(
                "chapter_not_reached",
                $"The reader has not reached '{chapter.Title}' in TextStack ({at}). If they finished it "
                + "elsewhere — audiobook, paper — confirm with them, call set_book_progress for this "
                + "chapter, then retry.",
                CurrentChapterSlug: current?.Slug,
                CurrentChapterTitle: current?.Title)));
        }

        return (new Target(book, userBookId.HasValue, bookId, chapters, chapter, reviews), null);
    }

    private sealed record LoadedHighlight(HighlightRef Ref, string Text, string? Note, DateTimeOffset CreatedAt);

    private async Task<List<LoadedHighlight>> LoadHighlightsAsync(Guid userId, Target target, CancellationToken ct)
    {
        var rows = await db.Highlights
            .Where(h => h.UserId == userId
                && (target.IsUpload ? h.UserBookId == target.BookId : h.EditionId == target.BookId))
            .Select(h => new { h.Id, h.ChapterId, h.UserChapterId, h.AnchorJson, h.SelectedText, h.NoteText, h.CreatedAt })
            .ToListAsync(ct);
        return rows
            .Select(h => new LoadedHighlight(
                new HighlightRef(h.Id, h.ChapterId ?? h.UserChapterId, h.AnchorJson), h.SelectedText, h.NoteText, h.CreatedAt))
            .ToList();
    }

    /// <summary>
    /// The reader's words from this book. A word's sentence is sent only when it occurs in the
    /// target chapter — a sentence saved in a later chapter is a spoiler.
    /// </summary>
    private async Task<List<ReviewWordDto>> LoadWordsAsync(Guid userId, Target target, string plainText, CancellationToken ct)
    {
        var rows = await db.VocabularyWords
            .Where(w => w.UserId == userId
                && (target.IsUpload ? w.UserBookId == target.BookId : w.EditionId == target.BookId))
            .OrderBy(w => w.CreatedAt)
            .Take(MaxWords)
            .Select(w => new { w.Word, w.Translation, w.Definition, w.Sentence })
            .ToListAsync(ct);

        var chapterText = OpenThreads.Normalize(plainText);
        return rows
            .Select(w => new ReviewWordDto(
                w.Word, w.Translation, w.Definition,
                w.Sentence is { } s && !string.IsNullOrWhiteSpace(s) && chapterText.Contains(OpenThreads.Normalize(s), StringComparison.Ordinal)
                    ? s
                    : null))
            .ToList();
    }
}
