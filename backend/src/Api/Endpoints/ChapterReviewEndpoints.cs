using Api.Extensions;
using Api.Sites;
using Application.Auth;
using Application.ChapterReview;
using Contracts.ChapterReview;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

/// <summary>
/// Chapter review — the reader's own assistant reviews a chapter over MCP and the result comes home
/// as structure (docs/05-features/chapter-review.md, ADR-016). Thin: the logic is in
/// <see cref="ChapterReviewService"/> and <see cref="ReviewQuestionService"/>.
///
/// <list type="bullet">
///   <item><c>GET  /me/chapter-review?userBookId=|editionId=&amp;chapterSlug=&amp;part=1</c> — the context
///   (tool <c>get_chapter_review</c>).</item>
///   <item><c>PUT  /me/chapter-review</c> — validate + save (tool <c>save_chapter_review</c>); a
///   refusal lists every problem in one <see cref="ReviewErrorDto"/>.</item>
///   <item><c>GET  /me/review-questions/due?limit=20</c> and
///   <c>POST /me/review-questions/{id}/answer</c> — the questions' own SRS queue.</item>
/// </list>
///
/// Guests are allowed: no inference runs on our side (owner decision 2026-09-29).
/// </summary>
public static class ChapterReviewEndpoints
{
    public static void MapChapterReviewEndpoints(this WebApplication app)
    {
        var review = app.MapGroup("/me/chapter-review").WithTags("ChapterReview");
        review.MapGet("", GetContext).WithName("GetChapterReview");
        review.MapPut("", Save).WithName("SaveChapterReview").RequireRateLimiting("insights");

        var questions = app.MapGroup("/me/review-questions").WithTags("ChapterReview");
        questions.MapGet("/due", GetDue).WithName("GetDueReviewQuestions");
        questions.MapPost("/{id:guid}/answer", Answer).WithName("AnswerReviewQuestion");
    }

    private static async Task<IResult> GetContext(
        HttpContext httpContext,
        AuthService authService,
        ChapterReviewService service,
        [FromQuery] Guid? userBookId,
        [FromQuery] Guid? editionId,
        [FromQuery] string? chapterSlug,
        [FromQuery] int? part,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        return ToResult(await service.GetContextAsync(userId.Value, userBookId, editionId, chapterSlug, part ?? 1, ct));
    }

    private static async Task<IResult> Save(
        [FromBody] SaveChapterReviewRequest request,
        HttpContext httpContext,
        AuthService authService,
        ChapterReviewService service,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        return ToResult(await service.SaveAsync(userId.Value, httpContext.GetSiteId(), request, ct));
    }

    private static async Task<IResult> GetDue(
        HttpContext httpContext,
        AuthService authService,
        ReviewQuestionService service,
        [FromQuery] int? limit,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        return Results.Ok(await service.GetDueAsync(userId.Value, limit ?? ReviewQuestionService.DefaultLimit, ct));
    }

    private static async Task<IResult> Answer(
        Guid id,
        [FromBody] AnswerReviewQuestionRequest request,
        HttpContext httpContext,
        AuthService authService,
        ReviewQuestionService service,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId == null) return Results.Unauthorized();

        if (ReviewQuestionService.IsCorrect(request.SelfAssessment) is not { } knew)
            return Results.BadRequest(new ReviewErrorDto("bad_request", "selfAssessment must be forgot, almost or knew"));

        var result = await service.AnswerAsync(userId.Value, id, knew, ct);
        return result is null
            ? Results.NotFound(new ReviewErrorDto("not_found", "Question not found"))
            : Results.Ok(result);
    }

    private static IResult ToResult<T>(ReviewResult<T> r) =>
        r.Error is null ? Results.Ok(r.Value) : Results.Json(r.Error, statusCode: r.Status);
}
