using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// A hermetic in-process stub of the TextStack public API — the exact routes the
/// MCP bridge's <c>TextStackApiClient</c> calls, returning canned camelCase JSON
/// matching the client's local DTOs. It RECORDS the last request seen per route
/// (method, path+query, Authorization, Host, body) so the over-the-wire tests can
/// assert the bridge issued the right upstream call.
///
/// Hosted on a loopback port (no Docker, no live API, no external network); the
/// real <c>BuildHttp</c> MCP host is pointed at it via <c>McpBridgeOptions.ApiBaseUrl</c>.
/// </summary>
public sealed class StubBackend : IAsyncDisposable
{
    // Two canned editions: the "good" one answers ask_book; the "spoiler" one
    // returns Insufficient=true (the spoiler-gate variant).
    public const string GoodEdition = "33333333-3333-3333-3333-333333333333";
    public const string SpoilerEdition = "55555555-5555-5555-5555-555555555555";
    public const string ChapterId = "44444444-4444-4444-4444-444444444444";

    // An UPLOADED book (UserBook) and one of its chapters. Deliberately different
    // ids from the catalog edition above: the my-library tools must never hand
    // back an editionId, and a shared constant would hide that if they did.
    public const string UserBookId = "77777777-7777-7777-7777-777777777777";
    public const string UserChapterId = "88888888-8888-8888-8888-888888888888";
    public const string InsightId = "99999999-9999-9999-9999-999999999999";

    // An upload whose progress write is REFUSED upstream (the shape LocatorSpace.MayReplace
    // produces: a position in a coordinate space this write may not replace). It exists because a
    // refusal that a tool reports as success is worse than no tool at all.
    public const string RefusingBookId = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    // An edition the reader has never opened: GET progress 404s, which is not an error and must
    // come back as "not started" rather than as a failure.
    public const string UnopenedEdition = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    public const string NewHighlightId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    private readonly WebApplication _app;
    private readonly Dictionary<string, RecordedRequest> _records = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public string BaseUrl { get; }

    /// <summary>A snapshot of a single recorded upstream request.</summary>
    public sealed record RecordedRequest(
        string Method, string PathAndQuery, string? Authorization, string? Host, string Body);

    /// <summary>Total upstream requests this stub has served (any route).</summary>
    public int TotalRequests
    {
        get { lock (_gate) return _hits; }
    }

    private int _hits;

    private StubBackend(WebApplication app, string baseUrl)
    {
        _app = app;
        BaseUrl = baseUrl;
    }

    /// <summary>Last request recorded under <paramref name="key"/>, or null.</summary>
    public RecordedRequest? Last(string key)
    {
        lock (_gate)
            return _records.TryGetValue(key, out var r) ? r : null;
    }

    public static async Task<StubBackend> StartAsync(CancellationToken ct)
    {
        var port = FreeTcpPort();
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders(); // keep test output clean
        var app = builder.Build();
        app.Urls.Add($"http://127.0.0.1:{port}");

        var stub = new StubBackend(app, $"http://127.0.0.1:{port}");
        stub.MapRoutes();
        await app.StartAsync(ct);
        return stub;
    }

    private void MapRoutes()
    {
        // GET /search → search page (Dracula hit).
        _app.MapGet("/search", async ctx =>
        {
            await RecordAsync("search", ctx);
            await WriteJsonAsync(ctx, SearchBody);
        });

        // GET /books/{slug} → BookDetail incl. id (=editionId) + chapters.
        _app.MapGet("/books/{slug}", async ctx =>
        {
            await RecordAsync("get_book", ctx);
            // One extra canned book, for the percentage only. Dracula's two chapters are almost the
            // same length, so chapters-done/total and a word-weighted fraction agree to within two
            // points there — a fixture that cannot tell the two formulas apart.
            var slug = (string?)ctx.Request.RouteValues["slug"];
            await WriteJsonAsync(ctx,
                string.Equals(slug, FrontMatterSlug, StringComparison.Ordinal)
                    ? FrontMatterBookDetailBody
                    : BookDetailBody);
        });

        // GET /books/{slug}/chapters/{chapterSlug} → ChapterDto (html, prev/next).
        _app.MapGet("/books/{slug}/chapters/{chapterSlug}", async ctx =>
        {
            await RecordAsync("get_chapter", ctx);
            await WriteJsonAsync(ctx, ChapterBody);
        });

        // GET /me/library/search → 401 if no bearer, else canned upload hits.
        _app.MapGet("/me/library/search", async ctx =>
        {
            await RecordAsync("search_my_library", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, MyLibrarySearchBody);
        });

        // GET /me/books/{id} → 401 if no bearer, else UserBookDetail incl. chapters.
        _app.MapGet("/me/books/{id}", async ctx =>
        {
            await RecordAsync("get_my_book", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            var bookId = (string?)ctx.Request.RouteValues["id"];
            if (string.Equals(bookId, RefusingBookId, StringComparison.OrdinalIgnoreCase))
            { await WriteJsonAsync(ctx, MyBookBody.Replace(UserBookId, RefusingBookId)); return; }
            await WriteJsonAsync(ctx, MyBookBody);
        });

        // GET /me/books/{id}/chapters/{slug} → 401 if no bearer, else UserChapter.
        _app.MapGet("/me/books/{id}/chapters/{slug}", async ctx =>
        {
            await RecordAsync("get_my_chapter", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, MyChapterBody);
        });

        // GET /me/highlights/{editionId} → 401 if no bearer, else canned list.
        _app.MapGet("/me/highlights/{editionId}", async ctx =>
        {
            await RecordAsync("list_my_highlights", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, HighlightsBody);
        });

        // GET /me/vocabulary/words → 401 if no bearer, else canned page.
        _app.MapGet("/me/vocabulary/words", async ctx =>
        {
            await RecordAsync("list_my_vocabulary", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, VocabularyBody);
        });

        // POST /me/highlights → 401 if no bearer, else 201 HighlightDto.
        _app.MapPost("/me/highlights", async ctx =>
        {
            await RecordAsync("save_highlight", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, CreatedHighlightBody, StatusCodes.Status201Created);
        });

        // GET /me/highlights/userbook/{id} → 401 if no bearer, else canned list.
        _app.MapGet("/me/highlights/userbook/{id}", async ctx =>
        {
            await RecordAsync("list_my_book_highlights", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, UserBookHighlightsBody);
        });

        // GET /me/insights?userBookId=|editionId= → 401 if no bearer, else canned list.
        _app.MapGet("/me/insights", async ctx =>
        {
            await RecordAsync("get_my_insights", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, InsightsBody);
        });

        // POST /me/insights → 401 if no bearer, else 201 BookInsightDto.
        _app.MapPost("/me/insights", async ctx =>
        {
            await RecordAsync("save_insight", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, SavedInsightBody, StatusCodes.Status201Created);
        });

        // GET /me/library/shelves → the shelf, both book kinds.
        _app.MapGet("/me/library/shelves", async ctx =>
        {
            await RecordAsync("get_shelves", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, ShelvesBody);
        });

        // GET /me/books → every upload, not paged.
        _app.MapGet("/me/books", async ctx =>
        {
            await RecordAsync("get_my_books", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, MyBooksBody);
        });

        // GET /me/progress/{editionId} → 404 for the edition never opened.
        _app.MapGet("/me/progress/{editionId}", async ctx =>
        {
            await RecordAsync("get_edition_progress", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            if (string.Equals((string?)ctx.Request.RouteValues["editionId"], UnopenedEdition, StringComparison.OrdinalIgnoreCase))
            { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            await WriteJsonAsync(ctx, EditionProgressBody);
        });

        // GET /me/books/{id}/progress.
        _app.MapGet("/me/books/{id}/progress", async ctx =>
        {
            await RecordAsync("get_my_book_progress", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, UserBookProgressBody);
        });

        // PUT /me/progress/{editionId} → 200 with the stored row.
        _app.MapPut("/me/progress/{editionId}", async ctx =>
        {
            await RecordAsync("set_edition_progress", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            await WriteJsonAsync(ctx, EditionProgressBody);
        });

        // PUT /me/books/{id}/progress → 400 for the refusing book, else 204.
        _app.MapPut("/me/books/{id}/progress", async ctx =>
        {
            await RecordAsync("set_my_book_progress", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            if (string.Equals((string?)ctx.Request.RouteValues["id"], RefusingBookId, StringComparison.OrdinalIgnoreCase))
            { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            ctx.Response.StatusCode = StatusCodes.Status204NoContent;
        });

        // POST /books/{editionId}/ask → 401 if no bearer; spoiler edition → Insufficient.
        _app.MapPost("/books/{editionId}/ask", async ctx =>
        {
            await RecordAsync("ask_book", ctx);
            if (!HasBearer(ctx)) { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return; }
            var editionId = (string?)ctx.Request.RouteValues["editionId"];
            await WriteJsonAsync(ctx,
                string.Equals(editionId, SpoilerEdition, StringComparison.OrdinalIgnoreCase)
                    ? AskInsufficientBody
                    : AskBody);
        });
    }

    private static bool HasBearer(HttpContext ctx)
    {
        var header = ctx.Request.Headers.Authorization.ToString();
        return header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            && header["Bearer ".Length..].Trim().Length > 0;
    }

    private async Task RecordAsync(string key, HttpContext ctx)
    {
        ctx.Request.EnableBuffering();
        string body;
        using (var reader = new StreamReader(ctx.Request.Body, leaveOpen: true))
            body = await reader.ReadToEndAsync();
        ctx.Request.Body.Position = 0;

        var record = new RecordedRequest(
            ctx.Request.Method,
            ctx.Request.Path + ctx.Request.QueryString,
            ctx.Request.Headers.Authorization.Count > 0 ? ctx.Request.Headers.Authorization.ToString() : null,
            ctx.Request.Host.HasValue ? ctx.Request.Host.Value : null,
            body);

        lock (_gate)
        {
            _records[key] = record;
            _hits++;
        }
    }

    private static async Task WriteJsonAsync(HttpContext ctx, string json, int status = StatusCodes.Status200OK)
    {
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json";
        await ctx.Response.WriteAsync(json);
    }

    private static int FreeTcpPort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public async ValueTask DisposeAsync()
    {
        await _app.StopAsync();
        await _app.DisposeAsync();
    }

    // ── canned camelCase bodies (mirror TextStackApiClient's local DTOs) ─────────

    private const string SearchBody =
        """
        {
          "total": 1,
          "items": [
            {
              "chapterId": "11111111-1111-1111-1111-111111111111",
              "chapterSlug": "ch-1",
              "chapterTitle": "I",
              "chapterNumber": 1,
              "edition": {
                "id": "33333333-3333-3333-3333-333333333333",
                "slug": "dracula",
                "title": "Dracula",
                "language": "en",
                "authors": "Bram Stoker",
                "coverPath": null
              },
              "highlights": ["the Count <b>Dracula</b> stirred"]
            }
          ]
        }
        """;

    private const string BookDetailBody =
        """
        {
          "id": "33333333-3333-3333-3333-333333333333",
          "slug": "dracula",
          "title": "Dracula",
          "language": "en",
          "description": "A vampire tale.",
          "authors": [{ "id": "1", "slug": "bs", "name": "Bram Stoker", "role": "author" }],
          "genres": [{ "id": "2", "slug": "horror", "name": "Horror" }],
          "chapters": [
            { "id": "44444444-4444-4444-4444-444444444444", "chapterNumber": 1, "slug": "ch-1", "title": "Jonathan Harker's Journal", "wordCount": 4200 },
            { "id": "66666666-6666-6666-6666-666666666666", "chapterNumber": 2, "slug": "ch-2", "title": "Jonathan Harker's Journal Continued", "wordCount": 3900 }
          ]
        }
        """;

    /// <summary>
    /// A book whose chapters are NOT the same size: five short front-matter chapters and one long
    /// body chapter, which is the ordinary shape of a non-fiction upload. It exists so the
    /// percentage <c>set_book_progress</c> writes can be compared against the word-weighted one the
    /// app's own <c>computeBookProgress</c> produces for the same position.
    /// </summary>
    public const string FrontMatterSlug = "front-matter";

    private const string FrontMatterBookDetailBody =
        """
        {
          "id": "33333333-3333-3333-3333-333333333333",
          "slug": "front-matter",
          "title": "A Book With Front Matter",
          "language": "en",
          "description": "Five short chapters and one long one.",
          "authors": [{ "id": "1", "slug": "an", "name": "A. N. Other", "role": "author" }],
          "genres": [{ "id": "2", "slug": "nonfiction", "name": "Non-fiction" }],
          "chapters": [
            { "id": "10000000-0000-0000-0000-000000000001", "chapterNumber": 1, "slug": "title-page", "title": "Title Page", "wordCount": 14 },
            { "id": "10000000-0000-0000-0000-000000000002", "chapterNumber": 2, "slug": "copyright", "title": "Copyright", "wordCount": 333 },
            { "id": "10000000-0000-0000-0000-000000000003", "chapterNumber": 3, "slug": "dedication", "title": "Dedication", "wordCount": 125 },
            { "id": "10000000-0000-0000-0000-000000000004", "chapterNumber": 4, "slug": "contents", "title": "Contents", "wordCount": 232 },
            { "id": "10000000-0000-0000-0000-000000000005", "chapterNumber": 5, "slug": "preface", "title": "Preface", "wordCount": 1184 },
            { "id": "10000000-0000-0000-0000-000000000006", "chapterNumber": 6, "slug": "the-book-itself", "title": "The Book Itself", "wordCount": 43310 }
          ]
        }
        """;

    /// <summary>Word counts of <see cref="FrontMatterBookDetailBody"/>, in order.</summary>
    public static readonly int[] FrontMatterWordCounts = [14, 333, 125, 232, 1184, 43310];

    private const string ChapterBody =
        """
        {
          "id": "44444444-4444-4444-4444-444444444444",
          "chapterNumber": 1,
          "slug": "ch-1",
          "title": "Jonathan Harker's Journal",
          "html": "<p>3 May. <b>Bistritz</b>. &mdash; Left Munich at 8:35 P.M.</p>",
          "wordCount": 11,
          "edition": { "id": "33333333-3333-3333-3333-333333333333", "slug": "dracula", "title": "Dracula", "language": "en" },
          "prev": null,
          "next": { "slug": "ch-2", "title": "Jonathan Harker's Journal Continued" }
        }
        """;

    private const string MyLibrarySearchBody =
        """
        [
          {
            "id": "77777777-7777-7777-7777-777777777777",
            "title": "Designing Data-Intensive Applications",
            "author": "Martin Kleppmann",
            "coverPath": null,
            "language": "en",
            "rank": 0.42,
            "excerpt": "a <mark>quorum</mark> of replicas must acknowledge",
            "chapterSlug": "replication"
          }
        ]
        """;

    private const string MyBookBody =
        """
        {
          "id": "77777777-7777-7777-7777-777777777777",
          "title": "Designing Data-Intensive Applications",
          "slug": "designing-data-intensive-applications",
          "language": "en",
          "author": "Martin Kleppmann",
          "description": "The big ideas behind reliable systems.",
          "coverPath": null,
          "genre": "Computing",
          "publishedYear": 2017,
          "totalWordCount": 210000,
          "status": "Ready",
          "errorMessage": null,
          "hasOriginalPdf": false,
          "chapters": [
            { "id": "88888888-8888-8888-8888-888888888888", "chapterNumber": 5, "slug": "replication", "title": "Replication", "wordCount": 14200, "sourceStartPage": 151 }
          ],
          "toc": null
        }
        """;

    private const string MyChapterBody =
        """
        {
          "id": "88888888-8888-8888-8888-888888888888",
          "chapterNumber": 5,
          "slug": "replication",
          "title": "Replication",
          "html": "<p>Replication means keeping a <b>copy</b> of the same data.</p>",
          "wordCount": 10,
          "previous": null,
          "next": { "chapterNumber": 6, "slug": "partitioning", "title": "Partitioning" }
        }
        """;

    private const string HighlightsBody =
        """
        [
          {
            "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "editionId": "33333333-3333-3333-3333-333333333333",
            "chapterId": "44444444-4444-4444-4444-444444444444",
            "userBookId": null, "userChapterId": null,
            "anchorJson": "{}", "color": "yellow",
            "selectedText": "the dead travel fast", "noteText": "ominous",
            "version": 1,
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00"
          }
        ]
        """;

    private const string VocabularyBody =
        """
        {
          "total": 1,
          "items": [
            {
              "id": "1", "word": "crepuscular", "language": "en",
              "translation": "сутінковий", "definition": "of twilight",
              "editionId": null, "chapterId": null, "userBookId": null,
              "sentence": null, "bookTitle": "Dracula", "hint": null,
              "stage": 2, "intervalDays": 3, "consecutiveCorrect": 1,
              "nextReviewAt": "2026-02-01T00:00:00+00:00", "lastReviewedAt": null,
              "totalReviews": 4, "correctReviews": 3,
              "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-01T00:00:00+00:00"
            }
          ]
        }
        """;

    private const string UserBookHighlightsBody =
        """
        [
          {
            "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "editionId": null, "chapterId": null,
            "userBookId": "77777777-7777-7777-7777-777777777777",
            "userChapterId": "88888888-8888-8888-8888-888888888888",
            "anchorJson": "{}", "color": "blue",
            "selectedText": "a quorum of replicas", "noteText": "the core trade-off",
            "version": 1,
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00"
          }
        ]
        """;

    private const string InsightsBody =
        """
        [
          {
            "id": "99999999-9999-9999-9999-999999999999",
            "editionId": null,
            "userBookId": "77777777-7777-7777-7777-777777777777",
            "chapterSlug": null, "chapterNumber": null, "chapterTitle": null,
            "text": "The book's argument in one paragraph.",
            "question": "what is this book actually about?",
            "source": "mcp",
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-02T00:00:00+00:00"
          },
          {
            "id": "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa",
            "editionId": null,
            "userBookId": "77777777-7777-7777-7777-777777777777",
            "chapterSlug": "replication", "chapterNumber": 5, "chapterTitle": "Replication",
            "text": "Quorums are about overlap, not majorities.",
            "question": "why w + r > n?",
            "source": "mcp",
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-02T00:00:00+00:00"
          }
        ]
        """;

    private const string SavedInsightBody =
        """
        {
          "id": "99999999-9999-9999-9999-999999999999",
          "editionId": null,
          "userBookId": "77777777-7777-7777-7777-777777777777",
          "chapterSlug": "replication", "chapterNumber": null, "chapterTitle": null,
          "text": "Quorums are about overlap, not majorities.",
          "question": "why w + r > n?",
          "source": "mcp",
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-02T00:00:00+00:00"
        }
        """;

    private const string CreatedHighlightBody =
        """
        {
          "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "editionId": "33333333-3333-3333-3333-333333333333",
          "chapterId": "44444444-4444-4444-4444-444444444444",
          "userBookId": null, "userChapterId": null,
          "anchorJson": "{}", "color": "green",
          "selectedText": "Listen to them, the children of the night",
          "noteText": "famous line",
          "version": 1,
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-01T00:00:00+00:00"
        }
        """;

    private const string ShelvesBody =
        """
        {
          "continueReading": [
            {
              "id": "77777777-7777-7777-7777-777777777777",
              "type": "userbook",
              "title": "Designing Data-Intensive Applications",
              "author": "Martin Kleppmann",
              "coverPath": null,
              "slug": "designing-data-intensive-applications",
              "language": "en",
              "progressPercent": 0.35,
              "lastOpenedAt": "2026-09-01T10:00:00+00:00",
              "createdAt": "2026-08-01T10:00:00+00:00",
              "estimatedMinutesRemaining": 420,
              "chapterSlug": "replication"
            },
            {
              "id": "33333333-3333-3333-3333-333333333333",
              "type": "savedbook",
              "title": "Dracula",
              "author": "Bram Stoker",
              "coverPath": null,
              "slug": "dracula",
              "language": "en",
              "progressPercent": 0.5,
              "lastOpenedAt": "2026-09-02T10:00:00+00:00",
              "createdAt": "2026-08-01T10:00:00+00:00",
              "estimatedMinutesRemaining": 120,
              "chapterSlug": "ch-1"
            }
          ],
          "recentlyAdded": [],
          "quickReads": [],
          "finishedThisMonth": []
        }
        """;

    private const string MyBooksBody =
        """
        [
          {
            "id": "77777777-7777-7777-7777-777777777777",
            "title": "Designing Data-Intensive Applications",
            "slug": "designing-data-intensive-applications",
            "language": "en",
            "author": "Martin Kleppmann",
            "description": null, "coverPath": null, "genre": "Computing",
            "status": "Ready", "errorMessage": null,
            "chapterCount": 12, "totalWordCount": 210000,
            "createdAt": "2026-08-01T10:00:00+00:00",
            "completedAt": null,
            "progressPercent": 0.35,
            "progressUpdatedAt": "2026-09-01T10:00:00+00:00",
            "progressChapterSlug": "replication",
            "tags": [], "suggestedTags": [],
            "sourceUrl": null, "isClip": false, "isRead": false, "readAt": null,
            "hasOriginalPdf": false
          },
          {
            "id": "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
            "title": "The Mom Test",
            "slug": "the-mom-test",
            "language": "en",
            "author": "Rob Fitzpatrick",
            "description": null, "coverPath": null, "genre": null,
            "status": "Ready", "errorMessage": null,
            "chapterCount": 9, "totalWordCount": 30000,
            "createdAt": "2026-08-20T10:00:00+00:00",
            "completedAt": null,
            "progressPercent": null,
            "progressUpdatedAt": null,
            "progressChapterSlug": null,
            "tags": [], "suggestedTags": [],
            "sourceUrl": null, "isClip": false, "isRead": false, "readAt": null,
            "hasOriginalPdf": false
          }
        ]
        """;

    private const string EditionProgressBody =
        """
        {
          "editionId": "33333333-3333-3333-3333-333333333333",
          "chapterId": "44444444-4444-4444-4444-444444444444",
          "chapterSlug": "ch-1",
          "locator": "scroll:ch-1:1200",
          "percent": 0.5,
          "updatedAt": "2026-09-02T10:00:00+00:00",
          "completedAt": null,
          "positionJson": null
        }
        """;

    private const string UserBookProgressBody =
        """
        {
          "chapterSlug": "replication",
          "locator": "scroll:replication:900",
          "percent": 0.35,
          "updatedAt": "2026-09-01T10:00:00+00:00",
          "positionJson": null
        }
        """;

    private const string AskBody =
        """
        {
          "answer": "Jonathan Harker travels to Transylvania to meet Count Dracula. [1]",
          "citations": [
            { "marker": 1, "chunkId": "c", "chapterId": "44444444-4444-4444-4444-444444444444", "chapterOrd": 1, "charStart": 0, "charEnd": 9, "preview": "Left Munich at 8:35 P.M." }
          ],
          "lastReadOrd": 2,
          "insufficient": false
        }
        """;

    private const string AskInsufficientBody =
        """
        { "answer": "", "citations": [], "lastReadOrd": 0, "insufficient": true }
        """;
}
