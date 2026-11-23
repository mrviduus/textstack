using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using TextStack.Ai.Mcp.Auth;

namespace TextStack.Ai.Mcp.Http;

/// <summary>
/// Thin, stateless client over the TextStack V2 sync API (<c>/me/v2</c>). The MCP server reuses the real
/// endpoints — their validation, auth and per-user isolation — instead of touching the DB.
///
/// Every call is user-scoped: the Host header plus <c>Authorization: Bearer {token}</c> (token from
/// <see cref="IMcpTokenProvider"/>). A 401 surfaces as <see cref="McpUnauthorizedException"/> so the
/// handler can map it to the auth-required message. Transport / timeout / parse failures THROW
/// (<see cref="HttpRequestException"/>, <see cref="OperationCanceledException"/>, <see cref="JsonException"/>)
/// — the catalog's shared wrapper maps these to a clean <c>IsError</c> tool result.
/// </summary>
public sealed partial class TextStackApiClient
{
    private readonly HttpClient _http;
    private readonly string _siteHost;
    private readonly IMcpTokenProvider _tokenProvider;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public TextStackApiClient(HttpClient http, McpBridgeOptions options, IMcpTokenProvider tokenProvider)
    {
        _http = http;
        _siteHost = options.SiteHost;
        _tokenProvider = tokenProvider;
    }

    /// <summary><c>DELETE /me/v2/vocabulary/words/{id}</c>. 200 (the tombstone) → success.</summary>
    public Task<ApiResult<JsonElement>> DeleteWordAsync(Guid id, CancellationToken ct) =>
        SendAsync<object>(HttpMethod.Delete, $"/me/v2/vocabulary/words/{id}", null, ct);

    /// <summary>One authorized JSON request (a body when given), answered by <see cref="ReadResultAsync"/>.</summary>
    private async Task<ApiResult<JsonElement>> SendAsync<T>(HttpMethod method, string url, T? body, CancellationToken ct)
    {
        using var request = await AuthorizedRequestAsync(method, url, ct);
        if (body is not null) request.Content = JsonContent.Create(body, options: JsonOptions);
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        return await ReadResultAsync(response, ct);
    }

    // 200/201 → the body; 204 → success with no body; 401 → McpUnauthorizedException; a structured
    // refusal → its message (or ProblemDetails `detail`, or a bare `error` code, or a JSON string body)
    // plus one "path: message" line per field error; anything else → a bare status line.
    private static async Task<ApiResult<JsonElement>> ReadResultAsync(HttpResponseMessage response, CancellationToken ct)
    {
        ThrowIfRefused(response);

        if (response.StatusCode is HttpStatusCode.OK or HttpStatusCode.Created)
            return new(await response.Content.ReadFromJsonAsync<JsonElement>(JsonOptions, ct), null, response.StatusCode);

        if (response.StatusCode is HttpStatusCode.NoContent)
            return new(default, null, response.StatusCode);

        var body = await response.Content.ReadAsStringAsync(ct);
        try
        {
            if (body.TrimStart().StartsWith('"'))
            {
                if (JsonSerializer.Deserialize<string>(body) is { Length: > 0 } text)
                    return new(default, text, response.StatusCode);
            }
            else if (JsonSerializer.Deserialize<ReviewErrorJson>(body, JsonOptions) is { } err
                     && (err.Message ?? err.Detail ?? err.Error) is { Length: > 0 } message)
            {
                var lines = (err.Errors ?? []).Select(e => $"{e.Path}: {e.Message}");
                return new(default, string.Join("\n", lines.Prepend(message)), response.StatusCode, err.Code);
            }
        }
        catch (JsonException)
        {
            // Not our error shape (a proxy page, an empty body) — fall through to the status line.
        }

        return new(default, $"upstream answered {(int)response.StatusCode}", response.StatusCode);
    }

    // ── request builders ─────────────────────────────────────────────────────────

    // Build a relative URI that PRESERVES any path prefix on BaseAddress (e.g.
    // ".../api/"). A leading slash would make HttpClient resolve from the host
    // root and drop the prefix, so strip it; BaseAddress is normalized to end
    // with "/" at registration so the prefix segment isn't treated as a file.
    private static Uri Relative(string url) => new(url.TrimStart('/'), UriKind.Relative);

    // User-scoped route: Host header + Bearer. Asks the token provider; a
    // non-Authorized result throws McpUnauthorizedException (carrying the
    // verification URL/code for Pending, or the message for Failed) up front so
    // the HTTP call never leaves the process. The catalog maps it to an
    // actionable IsError.
    /// <summary>
    /// <c>GET /oauth/token-status</c> with this request's bearer: true only on a definite 401. Lets
    /// the http host answer an expired OAuth token with a 401 challenge — the signal MCP clients
    /// refresh on — instead of a 200 whose every tool call fails. Transport faults throw.
    /// </summary>
    public async Task<bool> IsTokenRejectedAsync(CancellationToken ct)
    {
        using var request = await AuthorizedRequestAsync(HttpMethod.Get, "/oauth/token-status", ct);
        using var response = await _http.SendAsync(request, ct);
        return response.StatusCode is HttpStatusCode.Unauthorized;
    }

    private async Task<HttpRequestMessage> AuthorizedRequestAsync(HttpMethod method, string url, CancellationToken ct)
    {
        var token = await _tokenProvider.GetTokenAsync(ct);
        switch (token)
        {
            case TokenResult.Authorized a:
                var request = new HttpRequestMessage(method, Relative(url));
                request.Headers.Host = _siteHost;
                request.Headers.Authorization =
                    new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", a.AccessToken);
                return request;
            case TokenResult.Pending p:
                throw new McpUnauthorizedException(verificationUri: p.VerificationUri, userCode: p.UserCode);
            case TokenResult.Failed f:
                throw new McpUnauthorizedException(message: f.Message);
            default:
                throw new McpUnauthorizedException();
        }
    }

    /// <summary>401 → <see cref="McpUnauthorizedException"/>.</summary>
    private static void ThrowIfRefused(HttpResponseMessage response)
    {
        if (response.StatusCode is HttpStatusCode.Unauthorized) throw new McpUnauthorizedException();
    }
}

/// <summary>
/// Typed "no/invalid auth" signal for user-scoped tools. Raised when the token
/// provider can't supply a usable token, or the API answers 401. The catalog maps
/// it to a clean, actionable <c>IsError</c> — it is NOT a transport fault, so the
/// shared wrapper rethrows it for the catalog to translate.
///
/// When a device flow is in progress the provider yields
/// <see cref="TokenResult.Pending"/>, surfaced here via
/// <see cref="VerificationUri"/> + <see cref="UserCode"/> so the catalog can tell
/// the user where to authorize. Otherwise <see cref="Message"/> carries the reason
/// (e.g. "no TEXTSTACK_MCP_TOKEN configured") or the default (401 from the API).
/// </summary>
public sealed class McpUnauthorizedException : Exception
{
    /// <summary>Device-flow verification URL (set only for the Pending case).</summary>
    public string? VerificationUri { get; }

    /// <summary>Device-flow user code (set only for the Pending case).</summary>
    public string? UserCode { get; }

    public McpUnauthorizedException()
        : base("Unauthorized: no valid TextStack token.") { }

    public McpUnauthorizedException(string message)
        : base(message) { }

    public McpUnauthorizedException(string verificationUri, string userCode)
        : base("Unauthorized: device authorization pending.")
    {
        VerificationUri = verificationUri;
        UserCode = userCode;
    }
}

// ── The shapes the tool catalog maps from. The V2 partials (TextStackApiClient.V2*.cs) read the
//    Contracts.Sync DTOs and answer in these. ─────────────────────────────────────

// A highlight; the chapter of an upload is UserChapterId.
public sealed record HighlightJson(
    Guid Id,
    Guid? ChapterId,
    Guid? UserChapterId,
    string Color,
    string SelectedText,
    string? NoteText,
    DateTimeOffset CreatedAt);

public sealed record VocabularyPageJson(int Total, IReadOnlyList<VocabWordJson> Items);

public sealed record VocabWordJson(
    Guid Id,
    string Word,
    string Language,
    string? Translation,
    string? Definition,
    int Stage,
    string? BookTitle,
    DateTimeOffset NextReviewAt);

// One word of add_vocabulary_words. UserBookId goes as its example's bookId (TextStackApiClient.Vocabulary.cs).
public sealed record SaveWordJson(
    string Word,
    string Language,
    string? Translation,
    string? Definition,
    Guid? UserBookId,
    string? Sentence,
    string? BookTitle);

// `Id` is the book id — the only identifier an upload has.
public sealed record UserBookSearchHitJson(
    Guid Id,
    string Title,
    string? Author,
    string? CoverPath,
    string Language,
    double Rank,
    string? Excerpt,
    string? ChapterSlug);

public sealed record UserBookDetailJson(
    Guid Id,
    string Title,
    string Slug,
    string Language,
    string? Author,
    string? Description,
    string? Genre,
    int? PublishedYear,
    // True when the upload is a PDF, read as the original document (ADR-012): a highlight written from
    // here is saved and listed but not drawn over the page (BuildGetMyBook says so).
    bool HasOriginalPdf,
    IReadOnlyList<UserChapterSummaryJson>? Chapters);

// A TOC entry; Depth and Fraction (where it starts, 0-1) come only from the reader's TOC (ADR-033).
public sealed record UserChapterSummaryJson(
    Guid Id, int ChapterNumber, string? Slug, string Title, int? Depth, decimal? Fraction);

public sealed record BookInsightJson(
    Guid Id,
    Guid? EditionId,
    Guid? UserBookId,
    string? ChapterSlug,
    int? ChapterNumber,
    string? ChapterTitle,
    string Text,
    string? Question,
    string Source,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <summary>A call that either produced a value or a message worth showing the model.</summary>
/// <summary><see cref="Code"/> is a V2 refusal's machine code (<c>book_not_found</c>, …), null for every other upstream.</summary>
public sealed record ApiResult<T>(T? Value, string? Error, HttpStatusCode? Status = null, string? Code = null);

// Every structured refusal: a V2 error body ({ error, message, code, errors }) or ProblemDetails (detail).
public sealed record ReviewErrorJson(string? Error, string? Message, List<ReviewFieldErrorJson>? Errors, string? Detail = null, string? Code = null);

public sealed record ReviewFieldErrorJson(string Path, string Code, string Message);

// get_my_reading's shelves: "what am I reading" and "what did I just finish".
public sealed record ShelvesJson(
    IReadOnlyList<ShelfItemJson>? ContinueReading,
    IReadOnlyList<ShelfItemJson>? RecentlyAdded,
    IReadOnlyList<ShelfItemJson>? FinishedThisMonth);

public sealed record ShelfItemJson(
    Guid Id,
    string Type,
    string Title,
    string? Author,
    string? Slug,
    double ProgressPercent,
    DateTimeOffset? LastOpenedAt,
    string? ChapterSlug);

// get_my_reading's allBooks: every upload, opened or not.
public sealed record MyBookJson(
    Guid Id,
    string Title,
    string Slug,
    string? Author,
    string Status,
    int ChapterCount,
    double? ProgressPercent,
    string? ProgressChapterSlug,
    DateTimeOffset? CompletedAt);

public sealed record UserBookProgressJson(
    string? ChapterSlug,
    string? Locator,
    double? Percent,
    DateTimeOffset? UpdatedAt);
