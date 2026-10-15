using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;
using TextStack.Tts;

namespace Api.Endpoints;

public static class TtsEndpoints
{
    public static void MapTtsEndpoints(this WebApplication app)
    {
        // Note: registered at /tts (not /api/tts) because nginx strips /api prefix
        // via proxy_pass trailing slash. Frontend calls /api/tts → nginx → /tts → here.
        var group = app.MapGroup("/tts").WithTags("TTS");

        group.MapGet("", Synthesize).WithName("Synthesize").RequireRateLimiting("tts");
        // Timestamps share the synth rate budget — the first call typically
        // triggers synthesis (same cache key as the audio), subsequent calls
        // are pure cache reads. Giving them a separate bucket would let a
        // client burst through by alternating audio + timestamps requests.
        group.MapGet("/timestamps", GetTimestamps).WithName("GetTimestamps").RequireRateLimiting("tts");
        // Voices list is cheap (cached, no synthesis) — separate bucket so a
        // burst of voice-list polls doesn't starve the synth budget and vice versa.
        group.MapGet("/voices", GetVoices).WithName("GetTtsVoices").RequireRateLimiting("tts-voices");
    }

    // internal: unit-tested (#880 logging).
    internal static async Task<IResult> Synthesize(
        HttpContext http,
        string? text,
        string? lang,
        string? voice,
        double? speed,
        ITtsService tts,
        IOptions<TtsConfiguration> options,
        ILogger<ITtsService> logger,
        CancellationToken ct)
    {
        if (TryPreprocess(http, text, lang, voice, speed, options.Value, out var req, out var shortCircuit))
            return shortCircuit!;

        try
        {
            var audio = await tts.SynthesizeAsync(req.Text, req.Lang, req.Voice, req.Speed, ct);
            WriteCacheHeaders(http, req.Etag, req.ResponseCacheSeconds);
            return Results.File(audio, "audio/mpeg", enableRangeProcessing: true);
        }
        catch (TaskCanceledException ex) { return TimedOut(logger, ex); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return UpstreamFailed(logger, ex, req); }
    }

    private static async Task<IResult> GetTimestamps(
        HttpContext http,
        string? text,
        string? lang,
        string? voice,
        double? speed,
        ITtsService tts,
        IOptions<TtsConfiguration> options,
        ILogger<ITtsService> logger,
        CancellationToken ct)
    {
        if (TryPreprocess(http, text, lang, voice, speed, options.Value, out var req, out var shortCircuit))
            return shortCircuit!;

        try
        {
            var result = await tts.SynthesizeWithTimestampsAsync(req.Text, req.Lang, req.Voice, req.Speed, ct);
            WriteCacheHeaders(http, req.Etag, req.ResponseCacheSeconds);
            return Results.Ok(result.Timestamps);
        }
        catch (TaskCanceledException ex) { return TimedOut(logger, ex); }
        catch (Exception ex) when (ex is not OperationCanceledException) { return UpstreamFailed(logger, ex, req); }
    }

    // #880: these 502s were silent for 5 h when Edge started answering 403 (#827).
    // Error = a Sentry event (MinimumEventLevel = Error); Sentry groups them into one
    // issue by exception + stack, so an outage is one alert, not hundreds.
    // Timeouts stay Warning: Edge is slow at times, and the health-check probe catches
    // a hard hang (504) anyway. No text in the message: it is the reader's passage.
    private static IResult UpstreamFailed(ILogger logger, Exception ex, TtsRequest req)
    {
        logger.LogError(ex, "TTS upstream failed (lang={Lang}, voice={Voice})", req.Lang, req.Voice);
        return Results.Problem(detail: $"TTS service error: {ex.Message}", statusCode: 502);
    }

    private static IResult TimedOut(ILogger logger, Exception ex)
    {
        logger.LogWarning(ex, "TTS request timed out");
        return Results.Problem("TTS request timed out", statusCode: 504);
    }

    // Parsed + validated request shared between /tts and /tts/timestamps.
    // Etag is derived from the same inputs on both endpoints so a client that
    // already has the audio cached can 304 the timestamps cheaply (same key).
    private readonly record struct TtsRequest(string Text, string Lang, string? Voice, double Speed, string Etag, int ResponseCacheSeconds);

    // Shared validation + 304 short-circuit. Returns true when the caller
    // should return `shortCircuit` (BadRequest or 304). When false, `req` is
    // populated with the validated inputs + etag.
    //
    // Bind once via Options instead of `IConfiguration.GetValue` per call.
    // `GetValue` walks the config providers and re-parses the string on
    // every request — Options is cached + already strongly typed, so the
    // hot path is a property read instead of a string lookup + Convert.
    private static bool TryPreprocess(
        HttpContext http,
        string? text,
        string? lang,
        string? voice,
        double? speed,
        TtsConfiguration cfg,
        out TtsRequest req,
        out IResult? shortCircuit)
    {
        req = default;

        if (string.IsNullOrWhiteSpace(text)) { shortCircuit = Results.BadRequest("Text is required"); return true; }
        if (text.Length > cfg.MaxTextLength) { shortCircuit = Results.BadRequest($"Text exceeds maximum length of {cfg.MaxTextLength} characters"); return true; }
        if (string.IsNullOrWhiteSpace(lang)) { shortCircuit = Results.BadRequest("Language is required"); return true; }
        if (lang.StartsWith("uk", StringComparison.OrdinalIgnoreCase)) { shortCircuit = Results.BadRequest("Language 'uk' is not supported"); return true; }

        // Deterministic ETag from inputs — same (text, lang, voice, speed) always
        // yields the same MP3, so a 304 short-circuit saves both bandwidth and a
        // disk read. Browsers / CDNs can honor this even when IndexedDB cache
        // is cleared.
        var etag = ComputeEtag(text, lang, voice, speed ?? 1.0);
        req = new TtsRequest(text, lang, voice, speed ?? 1.0, etag, cfg.ResponseCacheSeconds);

        // RFC 9110: If-None-Match may carry a comma-separated list of validators
        // ("a", "b", W/"c") or the wildcard "*". Raw `inm == etag` only matched
        // a single-value header verbatim — multi-value clients (CDNs, fetch-with-
        // multiple-cached-versions) silently missed the 304 and re-downloaded.
        if (http.Request.Headers.TryGetValue("If-None-Match", out var inm) && IfNoneMatchMatches(inm, etag))
        {
            http.Response.StatusCode = StatusCodes.Status304NotModified;
            // RFC 9111 §4.3.4: a 304 SHOULD generate the same Cache-Control,
            // Content-Location, Date, ETag, Expires, and Vary as the 200 would
            // — so intermediaries can refresh stored freshness metadata. Without
            // it, a CDN's cached entry's max-age may not be re-extended on a
            // successful revalidation, forcing a full GET on next request.
            WriteCacheHeaders(http, etag, cfg.ResponseCacheSeconds);
            shortCircuit = Results.Empty;
            return true;
        }

        shortCircuit = null;
        return false;
    }

    private static void WriteCacheHeaders(HttpContext http, string etag, int maxAgeSeconds)
    {
        http.Response.Headers.ETag = etag;
        http.Response.Headers.CacheControl = new StringValues($"public, max-age={maxAgeSeconds}, immutable");
    }

    private static string ComputeEtag(string text, string lang, string? voice, double speed)
    {
        var input = $"{text}|{lang}|{voice ?? ""}|{speed:F2}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        return $"\"{Convert.ToHexStringLower(hash)[..16]}\"";
    }

    // RFC 9110 §13.1.2: If-None-Match accepts "*", a single ETag, or a
    // comma-separated list. Compare with weak-validator semantics: strip a
    // leading "W/" so W/"abc" matches "abc". Our ETags are always strong, so
    // a weak match-of-strong is acceptable for cache hit purposes.
    //
    // Span-based scan: previous string.Split(',') allocated an intermediate
    // string[] + per-token strings on every TTS request. This walks the header
    // value with IndexOf and slices via ReadOnlySpan<char> — zero allocations
    // on the hot path.
    private static bool IfNoneMatchMatches(StringValues header, string etag)
    {
        var etagSpan = etag.AsSpan();
        foreach (var raw in header)
        {
            if (string.IsNullOrEmpty(raw)) continue;
            var rest = raw.AsSpan();
            while (!rest.IsEmpty)
            {
                int comma = rest.IndexOf(',');
                ReadOnlySpan<char> token;
                if (comma < 0) { token = rest; rest = default; }
                else { token = rest[..comma]; rest = rest[(comma + 1)..]; }

                token = token.Trim();
                if (token.IsEmpty) continue;
                if (token.Length == 1 && token[0] == '*') return true;
                if (token.Length >= 2 && token[0] == 'W' && token[1] == '/')
                    token = token[2..];
                if (token.SequenceEqual(etagSpan)) return true;
            }
        }
        return false;
    }

    private static async Task<IResult> GetVoices(
        string? lang,
        ITtsService tts,
        ILogger<ITtsService> logger,
        CancellationToken ct)
    {
        try
        {
            var voices = await tts.GetVoicesAsync(lang, ct);
            return Results.Ok(voices);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "TTS voice list fetch failed");
            return Results.Problem("Failed to fetch voices", statusCode: 502);
        }
    }
}
