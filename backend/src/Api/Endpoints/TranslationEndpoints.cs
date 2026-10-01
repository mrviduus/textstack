using Application.Ai;
using Application.Common.Interfaces;
using Application.Vocabulary;
using Domain.LLM;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class TranslationEndpoints
{
    public static void MapTranslationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/translate").WithTags("Translation");

        group.MapPost("", Translate).WithName("Translate").RequireRateLimiting("translate");
        group.MapGet("/languages", GetLanguages).WithName("GetTranslationLanguages");

        // Also map without /api/ prefix for nginx compatibility
        app.MapPost("/translate", Translate).WithTags("Translation").WithName("TranslateCompat").RequireRateLimiting("translate");
    }

    private static async Task<IResult> Translate(
        [FromBody] TranslateRequest request,
        IConfiguration config,
        ILlmServiceFactory llmFactory,
        IAppDbContext db,
        IFrequencyFilter freqFilter,
        ILogger<Program> logger,
        CancellationToken ct)
    {
        var maxLength = config.GetValue("OpenAI:Translate:MaxTextLength", 500);
        var maxSentenceLength = config.GetValue("OpenAI:Translate:MaxSentenceLength", 800);
        var cachePath = config.GetValue<string>("Translate:CachePath") ?? "/tmp/translate-cache";
        var cacheTtlDays = config.GetValue("Translate:CacheTtlDays", 30);

        if (string.IsNullOrWhiteSpace(request.Text))
            return Results.BadRequest("Text is required");

        if (request.Text.Length > maxLength)
            return Results.BadRequest($"Text exceeds maximum length of {maxLength} characters");

        if (string.IsNullOrWhiteSpace(request.SourceLang))
            return Results.BadRequest("Source language is required");

        if (string.IsNullOrWhiteSpace(request.TargetLang))
            return Results.BadRequest("Target language is required");

        // Soft-cap on sentence — we still translate the word, we just drop the
        // context to keep prompt size predictable.
        var sentence = request.Sentence;
        if (!string.IsNullOrWhiteSpace(sentence) && sentence.Length > maxSentenceLength)
            sentence = null;

        var srcLang = request.SourceLang.Split('-')[0];
        var tgtLang = request.TargetLang.Split('-')[0];

        // Peek-time "save recommendation" hint for the reader toolbar: classify a
        // single word by frequency so the client can emphasize Save for words worth
        // learning and de-emphasize ones the reader already knows. Dataset is
        // en-only, so only hint for English source; null = no recommendation.
        // This does NOT gate saving — manual save always commits.
        string? category = null;
        var trimmedText = request.Text.Trim();
        if (srcLang == "en" && trimmedText.Length > 0 && !trimmedText.Contains(' '))
        {
            try
            {
                var cls = await freqFilter.ClassifyAsync(trimmedText.ToLowerInvariant(), srcLang, 0, ct);
                category = cls.Kind switch
                {
                    FrequencyClassKind.SrsEligible => "common",      // top ~5k — likely known
                    FrequencyClassKind.RequiresRetap => "learnable", // mid-tier — worth learning
                    _ => "rare",                                     // rare / OOV / proper noun
                };
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Translate frequency-classify failed; no save hint");
            }
        }

        var genre = await ExplainEndpoints.ResolveGenreAsync(request.Genre, request.BookId, db, logger, ct);

        var cache = new FileJsonCache<TranslateResponse>(cachePath, cacheTtlDays, logger);
        var cacheKey = ComputeCacheKey(request.Text, srcLang, tgtLang, genre, sentence);
        if (await cache.TryReadAsync(cacheKey, ct) is { } cachedResp && !string.IsNullOrWhiteSpace(cachedResp.TranslatedText))
            // Re-attach a fresh category — it's word-only (cache key
            // also varies by sentence/genre, so don't trust the stored one).
            return Results.Ok(cachedResp with { Category = category });

        var systemPrompt = TranslatePrompt.BuildSystemPrompt(srcLang, tgtLang, genre, sentence);

        try
        {
            var llm = llmFactory.Get("Translate");
            var translated = await llm.CompleteAsync(
                systemPrompt,
                request.Text,
                maxOutputTokens: Math.Min(maxLength * 2, 1000),
                ct);

            if (string.IsNullOrWhiteSpace(translated))
                return Results.Problem("Translation returned empty result", statusCode: 502);

            var resp = new TranslateResponse(translated, request.SourceLang, request.TargetLang, category);

            await cache.WriteAsync(cacheKey, resp, ct);

            return Results.Ok(resp);
        }
        catch (TaskCanceledException)
        {
            return Results.Problem("Translation request timed out", statusCode: 504);
        }
        catch (Exception ex)
        {
            return Results.Problem(
                detail: $"Translation service unavailable: {ex.Message}",
                statusCode: 503
            );
        }
    }

    /// <summary>
    /// Cache key includes genre + sentence so a domain-specific translation of
    /// "polling" in a CS book does not poison the cache for the same word in a
    /// political-news article.
    /// </summary>
    private static string ComputeCacheKey(string text, string srcLang, string tgtLang, string? genre, string? sentence) =>
        FileJsonCache<TranslateResponse>.Key($"{srcLang}|{tgtLang}|{genre ?? ""}|{sentence ?? ""}|{text}");

    private static IResult GetLanguages()
    {
        // Static list — OpenAI handles any BCP47 pair, but clients want a UI list.
        // Matches prior LibreTranslate set + a few extras.
        var languages = new[]
        {
            new LanguageInfo("en", "English"),
            new LanguageInfo("es", "Spanish"),
            new LanguageInfo("fr", "French"),
            new LanguageInfo("de", "German"),
            new LanguageInfo("it", "Italian"),
            new LanguageInfo("pt", "Portuguese"),
            new LanguageInfo("ru", "Russian"),
            new LanguageInfo("uk", "Ukrainian"),
            new LanguageInfo("pl", "Polish"),
            new LanguageInfo("nl", "Dutch"),
            new LanguageInfo("ja", "Japanese"),
            new LanguageInfo("ko", "Korean"),
            new LanguageInfo("zh", "Chinese"),
            new LanguageInfo("ar", "Arabic"),
            new LanguageInfo("tr", "Turkish"),
            new LanguageInfo("hi", "Hindi"),
        };
        return Results.Ok(languages);
    }
}

public record TranslateRequest(
    string Text,
    string SourceLang,
    string TargetLang,
    string? BookId = null,
    string? Sentence = null,
    string? Genre = null
);

public record TranslateResponse(
    string TranslatedText,
    string SourceLang,
    string TargetLang,
    // Frequency "save recommendation" for a single word: "common" | "learnable" |
    // "rare" | null (phrase / non-en / unknown). Informational only — never gates save.
    string? Category = null
);

public record LanguageInfo(string Code, string Name);
