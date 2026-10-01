using System.Net.ServerSentEvents;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Api.Extensions;
using Application.Ai;
using Application.Auth;
using Application.Common.Interfaces;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Core;
using TextStack.Ai.Tools;

namespace Api.Endpoints;

/// <summary>
/// Contextual word explanation (Phase 5: streams). Content-negotiated (AI-031a): an
/// <c>Accept: text/event-stream</c> request gets token-by-token SSE (<c>delta</c> events, then
/// <c>done</c>); anything else gets the original JSON shape — the mobile client keeps working
/// unchanged. Both paths share validation, genre resolution, the SHA256 file cache, and the
/// <see cref="ILlmService"/> gateway seam (FeatureTag <c>explain</c> — traced, routed).
/// </summary>
public static class ExplainEndpoints
{
    private const string FeatureTag = "explain";
    private const int MaxOutputTokens = 500;
    private const int RetryOutputTokens = 1000;

    public static void MapExplainEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/explain").WithTags("Explain");
        group.MapPost("", Explain).WithName("Explain").RequireRateLimiting("explain");
    }

    private static async Task<IResult> Explain(
        [FromBody] ExplainRequest request,
        HttpContext httpContext,
        IConfiguration config,
        ILlmService llm,
        IAppDbContext db,
        AuthService authService,
        IToolRegistry toolRegistry,
        ToolCallingSession toolSession,
        ILogger<Program> logger,
        CancellationToken ct)
    {
        var maxWordLength = config.GetValue("Explain:MaxWordLength", 100);
        var maxSentenceLength = config.GetValue("Explain:MaxSentenceLength", 800);

        if (string.IsNullOrWhiteSpace(request.Word))
            return Results.BadRequest("Word is required");
        if (request.Word.Length > maxWordLength)
            return Results.BadRequest($"Word exceeds {maxWordLength} chars");
        if (string.IsNullOrWhiteSpace(request.Sentence))
            return Results.BadRequest("Sentence is required");
        if (request.Sentence.Length > maxSentenceLength)
            return Results.BadRequest($"Sentence exceeds {maxSentenceLength} chars");

        var targetLang = string.IsNullOrWhiteSpace(request.TargetLang) ? "en" : request.TargetLang.Split('-')[0];
        var genre = await ResolveGenreAsync(request.Genre, request.BookId, db, logger, ct);
        var cache = new FileJsonCache<ExplainResponse>(
            config.GetValue<string>("Explain:CachePath") ?? "/tmp/explain-cache", config.GetValue("Explain:CacheTtlDays", 30), logger);
        var cacheKey = ComputeCacheKey(request.Word, request.Sentence, genre, targetLang);

        // Function-calling (AI-031b): which tools this request may use. Book tools need an edition in
        // context; the highlights tool additionally needs a signed-in user. Kill switch:
        // Explain:ToolsEnabled.
        var userId = httpContext.GetUserId(authService);
        Guid? editionId = !string.IsNullOrWhiteSpace(request.BookId) && Guid.TryParse(request.BookId, out var parsed)
            ? parsed
            : null;
        var tools = ResolveTools(toolRegistry, config, request.Sentence, editionId, userId);
        var toolCtx = new ToolContext(userId, editionId, AgentRunId: Guid.NewGuid(), httpContext.RequestServices);

        var systemPrompt = ExplainPrompt.BuildSystemPrompt(genre, targetLang, withTools: tools.Count > 0);
        var userPrompt = ExplainPrompt.BuildUserPrompt(request.Word, request.Sentence);

        var wantsSse = httpContext.Request.Headers.Accept.Any(v =>
            v is not null && v.Contains("text/event-stream", StringComparison.OrdinalIgnoreCase));

        return wantsSse
            ? ExplainSse(request.Word, systemPrompt, userPrompt, cache, cacheKey, llm, toolSession, tools, toolCtx, httpContext, logger)
            : await ExplainJson(request.Word, systemPrompt, userPrompt, cache, cacheKey, llm, toolSession, tools, toolCtx, logger, ct);
    }

    /// <summary>The tool schemas this request is allowed to call (empty = plain completion).</summary>
    private static IReadOnlyList<ToolSchema> ResolveTools(
        IToolRegistry registry, IConfiguration config, string sentence, Guid? editionId, Guid? userId)
    {
        if (!config.GetValue("Explain:ToolsEnabled", true))
            return [];

        // Deterministic pre-routing (AI-033): tools are offered ONLY when the sentence's wording
        // contains a matching lexical signal (chapter number / "my highlights").
        // The eval showed nano can't hold both sides of this decision in-prompt — code decides IF,
        // the prompt steers WHICH. No book in context → no book to fetch from → no tools at all.
        if (editionId is null)
            return [];

        var names = ExplainToolTriggers.TriggeredTools(sentence, hasUser: userId is not null);
        return names.Count == 0 ? [] : registry.SchemasFor(names);
    }

    // ---- JSON path (original contract; mobile + non-streaming clients) ----

    private static async Task<IResult> ExplainJson(
        string word, string systemPrompt, string userPrompt,
        FileJsonCache<ExplainResponse> cache, string cacheKey, ILlmService llm,
        ToolCallingSession toolSession, IReadOnlyList<ToolSchema> tools, ToolContext toolCtx,
        ILogger logger, CancellationToken ct)
    {
        if (await ReadCachedAsync(cache, cacheKey, ct) is { } cachedText)
            return Results.Ok(new ExplainResponse(cachedText, word, Cached: true));

        try
        {
            var (response, usedTools) = await toolSession.CompleteAsync(
                llm, BuildRequest(systemPrompt, userPrompt, MaxOutputTokens, tools), toolCtx, ct);
            var text = response.Text;

            // Reasoning models can exhaust the visible budget on internal reasoning
            // and return empty. Retry once with doubled budget (no tools) before giving up.
            if (string.IsNullOrWhiteSpace(text))
            {
                logger.LogWarning("Explain got empty result at {Max} tokens, retrying with {Retry}",
                    MaxOutputTokens, RetryOutputTokens);
                text = (await llm.CompleteAsync(BuildRequest(systemPrompt, userPrompt, RetryOutputTokens), ct)).Text;
            }

            if (string.IsNullOrWhiteSpace(text))
                return Results.Problem("LLM returned empty explanation", statusCode: 502);

            // Tool-grounded answers can be user-specific (highlights, progress-gated search) —
            // never write them to the shared cache.
            if (!usedTools)
                await WriteCachedAsync(cache, cacheKey, text, ct);
            return Results.Ok(new ExplainResponse(text, word, Cached: false));
        }
        catch (TaskCanceledException)
        {
            return Results.Problem("Explain request timed out", statusCode: 504);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Explain LLM call failed");
            return Results.Problem(detail: "Explain service unavailable", statusCode: 503);
        }
    }

    // ---- SSE path (AI-031a): delta* -> done | error ----

    private static IResult ExplainSse(
        string word, string systemPrompt, string userPrompt,
        FileJsonCache<ExplainResponse> cache, string cacheKey, ILlmService llm,
        ToolCallingSession toolSession, IReadOnlyList<ToolSchema> tools, ToolContext toolCtx,
        HttpContext httpContext, ILogger logger)
    {
        // Cloudflare/nginx must not buffer the stream (playbook Phase 5 risk).
        httpContext.Response.Headers["X-Accel-Buffering"] = "no";
        httpContext.Response.Headers.CacheControl = "no-cache";

        // Tool-grounded answers can be user-specific — skip the shared-cache write for them.
        // The flag is set before round 2 streams, so it's final by the time persist runs.
        var usedTools = false;

        return TypedResults.ServerSentEvents(StreamEventsAsync(
            word,
            primary: ct => toolSession.StreamAsync(
                llm, BuildRequest(systemPrompt, userPrompt, MaxOutputTokens, tools), toolCtx,
                onToolRound: () => usedTools = true, ct),
            fallback: async ct =>
                (await llm.CompleteAsync(BuildRequest(systemPrompt, userPrompt, RetryOutputTokens), ct)).Text,
            readCache: ct => ReadCachedAsync(cache, cacheKey, ct),
            persist: (text, ct) => usedTools ? Task.CompletedTask : WriteCachedAsync(cache, cacheKey, text, ct),
            onException: ex => logger.LogError(ex, "Explain stream failed"),
            ct: httpContext.RequestAborted));
    }

    /// <summary>
    /// The Explain SSE event stream: cache hit → one <c>delta</c> + <c>done(cached)</c>; miss → a
    /// <c>delta</c> per token from <paramref name="primary"/>, then persist + <c>done</c>. An empty
    /// stream falls back to <paramref name="fallback"/> (the empty-reasoning retry); a mid-stream
    /// failure emits <c>error</c> as the terminal event. Pure over its delegates — unit-tested directly.
    /// </summary>
    public static async IAsyncEnumerable<SseItem<string>> StreamEventsAsync(
        string word,
        Func<CancellationToken, IAsyncEnumerable<LlmDelta>> primary,
        Func<CancellationToken, Task<string>> fallback,
        Func<CancellationToken, Task<string?>> readCache,
        Func<string, CancellationToken, Task> persist,
        Action<Exception>? onException = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        if (await readCache(ct) is { } cachedText)
        {
            yield return new SseItem<string>(cachedText, "delta");
            yield return Done(word, cached: true);
            yield break;
        }

        var text = new StringBuilder();
        string? error = null;

        // Provider resolution happens inside primary() (gateway → keyed provider ctor) and can throw
        // on a keyless host — that must surface as an SSE error event, not a broken stream.
        IAsyncEnumerable<LlmDelta>? stream = null;
        try
        {
            stream = primary(ct);
        }
        catch (Exception ex)
        {
            onException?.Invoke(ex);
            error = "Explain service unavailable";
        }

        if (error is null)
        {
            await using var e = stream!.GetAsyncEnumerator(ct);
            while (true)
            {
                LlmDelta delta;
                try
                {
                    if (!await e.MoveNextAsync())
                        break;
                    delta = e.Current;
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested)
                {
                    throw; // client disconnected — nothing to emit
                }
                catch (Exception ex)
                {
                    onException?.Invoke(ex);
                    error = "Explain service unavailable";
                    break;
                }

                if (delta.TextDelta is { Length: > 0 } fragment)
                {
                    text.Append(fragment);
                    yield return new SseItem<string>(fragment, "delta");
                }
            }
        }

        if (error is not null)
        {
            yield return new SseItem<string>(error, "error");
            yield break;
        }

        // Empty stream (reasoning budget exhausted) → one-shot retry with a doubled budget.
        if (text.Length == 0)
        {
            string? retried = null;
            try
            {
                retried = await fallback(ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                onException?.Invoke(ex);
                error = "Explain service unavailable";
            }

            if (error is null && string.IsNullOrWhiteSpace(retried))
                error = "LLM returned empty explanation";
            if (error is not null)
            {
                yield return new SseItem<string>(error, "error");
                yield break;
            }

            text.Append(retried);
            yield return new SseItem<string>(retried!, "delta");
        }

        await persist(text.ToString(), ct);
        yield return Done(word, cached: false);
    }

    private static SseItem<string> Done(string word, bool cached) =>
        new(JsonSerializer.Serialize(new { word, cached }), "done");

    // ---- shared pieces ----

    private static async Task<string?> ReadCachedAsync(FileJsonCache<ExplainResponse> cache, string key, CancellationToken ct) =>
        (await cache.TryReadAsync(key, ct))?.Explanation is { } e && !string.IsNullOrWhiteSpace(e) ? e : null;

    // Word/Cached mirror what the JSON path historically persisted; readers flip Cached on hit.
    private static Task WriteCachedAsync(FileJsonCache<ExplainResponse> cache, string key, string explanation, CancellationToken ct) =>
        cache.WriteAsync(key, new ExplainResponse(explanation, "", false), ct);

    private static LlmRequest BuildRequest(
        string systemPrompt, string userPrompt, int maxTokens, IReadOnlyList<ToolSchema>? tools = null) =>
        new(systemPrompt, [new LlmMessage("user", userPrompt)], maxTokens,
            Tools: tools is { Count: > 0 } ? tools : null, FeatureTag: FeatureTag);

    /// <summary>
    /// Genre for the domain prompt: explicit request value → catalog Edition → user upload. Shared with
    /// Translate. Fail-soft: a lookup error logs and returns null (the no-domain prompt), never a 500.
    /// </summary>
    internal static async Task<string?> ResolveGenreAsync(
        string? genre, string? bookIdText, IAppDbContext db, ILogger logger, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(genre))
            return genre;
        if (string.IsNullOrWhiteSpace(bookIdText) || !Guid.TryParse(bookIdText, out var bookId))
            return null;

        try
        {
            var resolved = await db.Editions
                .Where(e => e.Id == bookId)
                .SelectMany(e => e.Genres.Select(g => g.Name))
                .FirstOrDefaultAsync(ct);
            if (string.IsNullOrWhiteSpace(resolved))
            {
                resolved = await db.UserBooks
                    .Where(ub => ub.Id == bookId)
                    .Select(ub => ub.Genre)
                    .FirstOrDefaultAsync(ct);
            }
            return resolved;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Genre lookup failed, using 'general' domain");
            return null;
        }
    }

    private static string ComputeCacheKey(string word, string sentence, string? genre, string targetLang)
    {
        return FileJsonCache<ExplainResponse>.Key($"{word.ToLowerInvariant()}|{sentence}|{genre ?? ""}|{targetLang}");
    }
}

/// <summary>
/// SHA256-keyed JSON file cache shared by Explain + Translate: TTL in days (file mtime), best-effort IO —
/// any failure logs and behaves as a miss / no-op. DictionaryCache is deliberately separate (stale-serving).
/// </summary>
internal sealed class FileJsonCache<T>(string path, int ttlDays, ILogger logger) where T : class
{
    public static string Key(string payload) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload))).ToLowerInvariant();

    public async Task<T?> TryReadAsync(string key, CancellationToken ct)
    {
        try
        {
            var file = Path.Combine(path, key + ".json");
            if (!File.Exists(file) || new FileInfo(file).LastWriteTimeUtc <= DateTime.UtcNow.AddDays(-ttlDays))
                return null;
            return JsonSerializer.Deserialize<T>(await File.ReadAllTextAsync(file, ct));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "{Type} cache read failed, falling through to LLM", typeof(T).Name);
            return null;
        }
    }

    public async Task WriteAsync(string key, T value, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(path);
            await File.WriteAllTextAsync(Path.Combine(path, key + ".json"), JsonSerializer.Serialize(value), ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "{Type} cache write failed", typeof(T).Name);
        }
    }
}

public record ExplainRequest(
    string Word,
    string Sentence,
    string? Genre,
    string? BookId,
    string? TargetLang
);

public record ExplainResponse(
    string Explanation,
    string Word,
    bool Cached
);
