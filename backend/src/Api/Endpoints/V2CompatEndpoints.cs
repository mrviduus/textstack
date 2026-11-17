using Api.Extensions;
using Api.V2;
using Application.Ai;
using Application.Annotations;
using Application.Auth;
using Application.Library;
using Application.Vocabulary;
using Domain.LLM;
using Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;
using TextStack.Ai.Tools;

namespace Api.Endpoints;

/// <summary>
/// M5.1 Part C (docs/internal/v2/m5-part-c-routes.md): the legacy routes the new clients still call, answered from
/// V2 in <c>Database:Mode=v2</c>. Mapped only in v2 mode, on the legacy path and shape, ordered before the legacy
/// handler (<c>WithOrder(-1)</c>), so legacy mode maps and runs exactly what it did. Behind <see cref="V2Gate"/>
/// like every <c>/me/v2</c> route. Goes at M6 with the legacy handlers.
/// </summary>
public static class V2CompatEndpoints
{
    public static void MapV2CompatEndpoints(this WebApplication app)
    {
        if (!app.Services.GetRequiredService<DatabaseMode>().IsV2) return;

        var highlights = app.MapGroup("/me/highlights").WithMetadata(V2SelectedRoute.Instance).WithTags("Highlights").AddEndpointFilter<V2Gate>();
        highlights.MapGet("/all", GetAllHighlights).WithOrder(-1);

        // Anonymous on purpose, as legacy (the reading loop): no V2Gate. Spend: V2 traces (V2LlmSpendSource).
        app.MapGroup("/explain").WithMetadata(V2SelectedRoute.Instance).WithTags("Explain")
            .MapPost("", Explain).RequireRateLimiting("explain").WithOrder(-1);
        app.MapGroup("/api/translate").WithMetadata(V2SelectedRoute.Instance).WithTags("Translation")
            .MapPost("", Translate).RequireRateLimiting("translate").WithOrder(-1);
        app.MapPost("/translate", Translate).WithMetadata(V2SelectedRoute.Instance).WithTags("Translation")
            .RequireRateLimiting("translate").WithOrder(-1);
    }

    /// <summary>The legacy explain on V2: the genre from the caller's V2 book, no tools (they read legacy's catalog).</summary>
    private static Task<IResult> Explain(
        [FromBody] ExplainRequest request, HttpContext http, IConfiguration config, IOptions<OpenAiOptions> openAi,
        TextStack.Ai.Core.ILlmService llm, IAuthService auth, ILibraryRepository library, ToolCallingSession toolSession,
        ILogger<Program> logger, CancellationToken ct)
    {
        var userId = http.GetUserId(auth);
        return ExplainEndpoints.ExplainAsync(request, http, config, openAi, llm,
            token => GenreAsync(request.Genre, request.BookId, userId, library, logger, token), userId,
            toolRegistry: null, toolSession, logger, ct);
    }

    /// <summary>The legacy translate on V2: the genre from the caller's V2 book.</summary>
    private static Task<IResult> Translate(
        [FromBody] TranslateRequest request, HttpContext http, IConfiguration config, IOptions<OpenAiOptions> openAi,
        ILlmServiceFactory llmFactory, IAuthService auth, ILibraryRepository library, IFrequencyFilter freqFilter,
        ILogger<Program> logger, CancellationToken ct)
    {
        var userId = http.GetUserId(auth);
        return TranslationEndpoints.TranslateAsync(request,
            token => GenreAsync(request.Genre, request.BookId, userId, library, logger, token),
            config, openAi, llmFactory, freqFilter, logger, ct);
    }

    /// <summary>
    /// Legacy's genre rule on V2: the request's, else the caller's own book's. No catalog editions in V2, and an
    /// anonymous caller has no books. Fail-soft as legacy: an error logs and answers null (the no-domain prompt).
    /// </summary>
    internal static async Task<string?> GenreAsync(
        string? genre, string? bookIdText, Guid? userId, ILibraryRepository library, ILogger logger, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(genre)) return genre;
        if (userId is null || !Guid.TryParse(bookIdText, out var bookId)) return null;
        try
        {
            return (await library.GetAsync(userId.Value, bookId, ct))?.Genre;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "V2 genre lookup failed, using 'general' domain");
            return null;
        }
    }

    /// <summary>
    /// <c>GET /me/highlights/all</c> on V2 annotations, the legacy query and shape. A V2 highlight is in an upload
    /// (no catalog editions): <c>bookType=edition</c> lists none; covers are not served here (null).
    /// </summary>
    private static async Task<IResult> GetAllHighlights(
        HttpContext http, IAuthService auth, IAnnotationRepository annotations,
        [FromQuery] int limit = 50, [FromQuery] int offset = 0, [FromQuery] string? bookType = "all",
        [FromQuery] string? sort = "newest", [FromQuery] string? search = null, [FromQuery] string? color = null,
        CancellationToken ct = default)
    {
        if (bookType == "edition") return Results.Ok(new { items = Array.Empty<HighlightListItemDto>(), totalCount = 0 });

        var page = await annotations.ListAllAsync(http.GetUserId(auth)!.Value, search, color, sort == "oldest",
            Math.Clamp(limit, 1, 100), Math.Max(offset, 0), ct);
        var items = page.Items.Select(h => new HighlightListItemDto(
            h.Id, h.SelectedText, h.AnchorJson, h.Color, h.NoteText, h.CreatedAt,
            null, null, null, null,
            h.BookId, h.BookTitle, null,
            null, h.ChapterId, null, h.ChapterTitle, null, h.ChapterKey,
            null));
        return Results.Ok(new { items, totalCount = page.TotalCount });
    }
}
