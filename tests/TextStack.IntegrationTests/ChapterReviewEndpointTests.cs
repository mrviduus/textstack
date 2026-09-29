using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// <c>/me/chapter-review</c> and <c>/me/review-questions</c> — the chapter review round trip
/// (docs/05-features/chapter-review.md). What is asserted here lives in Postgres and the endpoint
/// wiring: the spoiler gate against real progress rows, the insight upsert, the jsonb review, the
/// question sync by prompt and the cascade on delete. The rules themselves are unit-tested.
///
/// <para>Uses a catalog edition AWAY from the first one (<see cref="InsightsEndpointTests"/> writes
/// plain insights on the first edition's first chapter, and a review there would turn its saves
/// into 409s). Skips when the DB has no such edition or test-login is off, like the rest of the suite.</para>
/// </summary>
public class ChapterReviewEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private readonly AuthenticatedApiFixture _auth;

    public ChapterReviewEndpointTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    {
        _fixture = fixture;
        _auth = auth;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record Seed(Guid EditionId, (Guid Id, string Slug)[] Chapters);

    /// <summary>An edition with at least three slugged chapters, skipping the first few editions.</summary>
    private async Task<Seed?> FindEditionAsync()
    {
        var list = await GetJsonAsync(_fixture.CreateRequest(HttpMethod.Get, "/books?limit=10&offset=5"), _fixture.Client);
        if (list is not { } l || !l.TryGetProperty("items", out var items)) return null;

        foreach (var item in items.EnumerateArray())
        {
            var book = await GetJsonAsync(
                _fixture.CreateRequest(HttpMethod.Get, $"/books/{item.GetProperty("slug").GetString()}"), _fixture.Client);
            if (book is not { } b || !b.TryGetProperty("chapters", out var chapters)) continue;
            var slugged = chapters.EnumerateArray()
                .Where(c => c.TryGetProperty("slug", out var s) && s.ValueKind == JsonValueKind.String)
                .Select(c => (c.GetProperty("id").GetGuid(), c.GetProperty("slug").GetString()!))
                .ToArray();
            if (slugged.Length >= 3) return new Seed(b.GetProperty("id").GetGuid(), slugged);
        }
        return null;
    }

    private static async Task<JsonElement?> GetJsonAsync(HttpRequestMessage req, HttpClient client)
    {
        var resp = await client.SendAsync(req, Ct);
        return resp.IsSuccessStatusCode ? await resp.Content.ReadFromJsonAsync<JsonElement>(Ct) : null;
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body = null)
    {
        var req = _auth.CreateRequest(method, path);
        if (body is not null) req.Content = JsonContent.Create(body);
        return await _auth.Client.SendAsync(req, Ct);
    }

    private async Task SetProgressAsync(Seed seed, int chapterIndex)
    {
        // A high-water mark never decreases, so reset first: the test states where the reader is.
        await SendAsync(HttpMethod.Delete, $"/me/progress/{seed.EditionId}");
        var resp = await SendAsync(HttpMethod.Put, $"/me/progress/{seed.EditionId}",
            new { chapterId = seed.Chapters[chapterIndex].Id, locator = "scroll:0", percent = (double?)null, updatedAt = (DateTimeOffset?)null });
        Assert.True(resp.IsSuccessStatusCode, $"progress PUT returned {(int)resp.StatusCode}");
    }

    private async Task<Guid> CreateHighlightAsync(Seed seed, int chapterIndex, string text)
    {
        var resp = await SendAsync(HttpMethod.Post, "/me/highlights", new
        {
            editionId = seed.EditionId,
            chapterId = seed.Chapters[chapterIndex].Id,
            anchorJson = JsonSerializer.Serialize(new { prefix = "", exact = text, suffix = "" }),
            color = "yellow",
            selectedText = text,
        });
        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetGuid();
    }

    private static object Review(Guid highlightId, params string[] prompts) => new
    {
        blocks = prompts.Select((p, i) => new
        {
            title = $"Idea {i}",
            problem = $"A concrete problem number {i}.",
            rootCause = $"Because of cause {i}.",
            rule = $"Remember rule {i}.",
            highlightIds = i == 0 ? new[] { highlightId } : Array.Empty<Guid>(),
            question = new { prompt = p, answer = $"Answer to {p}" },
        }).ToArray(),
        applications = new[] { "In my own code review" },
        openThreads = new[] { new { text = "What happens when the leader fails?" } },
    };

    private async Task<JsonElement> DueAsync()
    {
        var resp = await SendAsync(HttpMethod.Get, "/me/review-questions/due?limit=50");
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private static JsonElement[] DueWithPrefix(JsonElement due, string prefix) =>
        due.GetProperty("items").EnumerateArray()
            .Where(i => i.GetProperty("prompt").GetString()!.StartsWith(prefix, StringComparison.Ordinal))
            .ToArray();

    // ── unauthenticated ──

    [Theory]
    [InlineData("GET", "/me/chapter-review?editionId=00000000-0000-0000-0000-000000000001&chapterSlug=x")]
    [InlineData("PUT", "/me/chapter-review")]
    [InlineData("GET", "/me/review-questions/due")]
    [InlineData("POST", "/me/review-questions/00000000-0000-0000-0000-000000000001/answer")]
    public async Task Routes_WithoutAuth_Return401(string method, string path)
    {
        var req = _fixture.CreateRequest(new HttpMethod(method), path);
        if (method is "PUT" or "POST") req.Content = JsonContent.Create(new { });
        var resp = await _fixture.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    // ── target resolution ──

    [Fact]
    public async Task GetChapterReview_BothTargets_Returns400BadRequest()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var resp = await SendAsync(HttpMethod.Get,
            $"/me/chapter-review?editionId={Guid.NewGuid()}&userBookId={Guid.NewGuid()}&chapterSlug=x");

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal("bad_request", (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task GetChapterReview_AnotherUsersBook_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        // A second identity uploads (clips) a book; the test user asking about it gets 404, exactly
        // as for an id that does not exist.
        var register = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        register.Content = JsonContent.Create(new
        {
            email = $"review-other-{Guid.NewGuid():N}@example.test",
            password = "Test12345!",
            name = "Review Other",
        });
        var other = await _fixture.Client.SendAsync(register, Ct);
        Assert.SkipWhen(other.StatusCode == HttpStatusCode.TooManyRequests, "register rate limited");
        Assert.True(other.IsSuccessStatusCode, $"register returned {(int)other.StatusCode}");
        var cookie = string.Join("; ", other.Headers.GetValues("Set-Cookie").Select(c => c.Split(';')[0]));

        var clip = _fixture.CreateRequest(HttpMethod.Post, "/me/books/clip");
        clip.Headers.Add("Cookie", cookie);
        clip.Content = JsonContent.Create(new { title = "Other's book", html = "<h1>Other</h1><p>Private.</p>", language = "en" });
        var clipped = await _fixture.Client.SendAsync(clip, Ct);
        Assert.SkipWhen(clipped.StatusCode == HttpStatusCode.TooManyRequests, "clip rate limited");
        Assert.Equal(HttpStatusCode.OK, clipped.StatusCode);
        var bookId = (await clipped.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("userBookId").GetGuid();

        var resp = await SendAsync(HttpMethod.Get, $"/me/chapter-review?userBookId={bookId}&chapterSlug=anything");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        Assert.Equal("not_found", (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task GetChapterReview_UnknownSlug_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindEditionAsync();
        Assert.SkipWhen(seed is null, "no seeded edition with 3+ slugged chapters");

        var resp = await SendAsync(HttpMethod.Get, $"/me/chapter-review?editionId={seed!.EditionId}&chapterSlug=no-such-chapter");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    // ── spoiler gate ──

    [Fact]
    public async Task GetChapterReview_BeyondProgress_Returns409_ThenAfterProgressPut_Returns200()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindEditionAsync();
        Assert.SkipWhen(seed is null, "no seeded edition with 3+ slugged chapters");

        await SetProgressAsync(seed!, 0);
        var target = seed!.Chapters[2].Slug;

        var refused = await SendAsync(HttpMethod.Get, $"/me/chapter-review?editionId={seed.EditionId}&chapterSlug={target}");
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        var err = await refused.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("chapter_not_reached", err.GetProperty("error").GetString());
        Assert.Contains("set_book_progress", err.GetProperty("message").GetString());
        Assert.Equal(seed.Chapters[0].Slug, err.GetProperty("currentChapterSlug").GetString());

        await SetProgressAsync(seed, 2);
        var ok = await SendAsync(HttpMethod.Get, $"/me/chapter-review?editionId={seed.EditionId}&chapterSlug={target}");

        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        var ctx = await ok.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("catalog", ctx.GetProperty("book").GetProperty("kind").GetString());
        Assert.Equal(target, ctx.GetProperty("chapter").GetProperty("slug").GetString());
        Assert.Equal(1, ctx.GetProperty("chapter").GetProperty("part").GetInt32());
        Assert.StartsWith("# TextStack chapter review", ctx.GetProperty("method").GetString());
        Assert.Equal("save_chapter_review", ctx.GetProperty("saveWith").GetString());
    }

    // ── save ──

    [Fact]
    public async Task SaveChapterReview_Invalid_Returns400WithEveryError()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindEditionAsync();
        Assert.SkipWhen(seed is null, "no seeded edition with 3+ slugged chapters");
        await SetProgressAsync(seed!, 2);

        var resp = await SendAsync(HttpMethod.Put, "/me/chapter-review", new
        {
            editionId = seed!.EditionId,
            chapterSlug = seed.Chapters[1].Slug,
            review = new
            {
                blocks = new[] { new { title = "", problem = "p", rootCause = "a\nb", rule = "r", highlightIds = new[] { Guid.NewGuid() }, question = new { prompt = "q", answer = "a" } } },
                applications = Array.Empty<string>(),
            },
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("review_invalid", err.GetProperty("error").GetString());
        var paths = err.GetProperty("errors").EnumerateArray().Select(e => e.GetProperty("path").GetString()).ToList();
        Assert.Contains("blocks", paths);
        Assert.Contains("blocks[0].title", paths);
        Assert.Contains("blocks[0].rootCause", paths);
        Assert.Contains("blocks[0].highlightIds[0]", paths); // unknown_highlight: not the reader's
        Assert.Contains("applications", paths);
        Assert.StartsWith($"{paths.Count} problems", err.GetProperty("message").GetString());
    }

    [Fact]
    public async Task SaveChapterReview_UnknownProperty_Returns400UnknownProperty()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindEditionAsync();
        Assert.SkipWhen(seed is null, "no seeded edition with 3+ slugged chapters");
        await SetProgressAsync(seed!, 2);

        var resp = await SendAsync(HttpMethod.Put, "/me/chapter-review", new
        {
            editionId = seed!.EditionId,
            chapterSlug = seed.Chapters[1].Slug,
            review = new { blocks = Array.Empty<object>(), applications = new[] { "x" }, summary = "nope" },
        });

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var e = (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("errors")[0];
        Assert.Equal("unknown_property", e.GetProperty("code").GetString());
    }

    [Fact]
    public async Task SaveChapterReview_RoundTrip_InsightCarriesReview_QuestionsSync_DeleteCascades()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindEditionAsync();
        Assert.SkipWhen(seed is null, "no seeded edition with 3+ slugged chapters");
        await SetProgressAsync(seed!, 2);
        var slug = seed!.Chapters[1].Slug;
        var run = $"cr{Guid.NewGuid():N}"[..10];
        var highlightId = await CreateHighlightAsync(seed, 1, $"marked passage {run}");

        // The context lists the highlight and does not demand recall.
        var ctx = await (await SendAsync(HttpMethod.Get, $"/me/chapter-review?editionId={seed.EditionId}&chapterSlug={slug}"))
            .Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Contains(ctx.GetProperty("highlights").EnumerateArray(), h => h.GetProperty("id").GetGuid() == highlightId);
        Assert.False(ctx.GetProperty("recallRequired").GetBoolean());

        // Save.
        var saved = await SendAsync(HttpMethod.Put, "/me/chapter-review", new
        {
            editionId = seed.EditionId,
            chapterSlug = slug,
            review = Review(highlightId, $"{run} keep?", $"{run} drop?", $"{run} third?"),
        });
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var result = await saved.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.True(result.GetProperty("saved").GetBoolean());
        Assert.Equal(3, result.GetProperty("questionCount").GetInt32());
        var insightId = result.GetProperty("insightId").GetGuid();
        Assert.Matches("^t_[0-9a-f]{8}$", result.GetProperty("openThreads")[0].GetProperty("id").GetString());

        // GET /me/insights carries the structure and the rendered Markdown.
        var insights = await (await SendAsync(HttpMethod.Get, $"/me/insights?editionId={seed.EditionId}"))
            .Content.ReadFromJsonAsync<JsonElement>(Ct);
        var row = insights.EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == insightId);
        Assert.Equal(1, row.GetProperty("review").GetProperty("methodVersion").GetInt32());
        Assert.Equal(highlightId, row.GetProperty("review").GetProperty("blocks")[0].GetProperty("highlightIds")[0].GetGuid());
        Assert.Contains("> **Rule:** Remember rule 0.", row.GetProperty("text").GetString());
        Assert.Equal("Chapter review", row.GetProperty("question").GetString());

        // A plain save_insight over the reviewed row is refused, not silently destructive.
        var overwrite = await SendAsync(HttpMethod.Post, "/me/insights", new { editionId = seed.EditionId, chapterSlug = slug, text = "plain" });
        Assert.Equal(HttpStatusCode.Conflict, overwrite.StatusCode);
        Assert.Equal("review_exists", (await overwrite.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("error").GetString());

        // All three are due now; answer "keep" as known → it moves to tomorrow.
        var due = DueWithPrefix(await DueAsync(), run);
        Assert.Equal(3, due.Length);
        Assert.Equal(slug, due[0].GetProperty("chapterSlug").GetString());
        Assert.StartsWith("Idea", due[0].GetProperty("blockTitle").GetString());
        var keep = due.Single(d => d.GetProperty("prompt").GetString() == $"{run} keep?");
        var answer = await SendAsync(HttpMethod.Post, $"/me/review-questions/{keep.GetProperty("id").GetGuid()}/answer",
            new { selfAssessment = "knew" });
        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        var answered = await answer.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal(1, answered.GetProperty("stage").GetInt32());
        Assert.True(answered.GetProperty("nextReviewAt").GetDateTimeOffset() > DateTimeOffset.UtcNow.AddHours(12));

        // Re-save: "keep" unchanged (SRS kept → still not due), "drop" removed, "fresh" new (due).
        var resaved = await SendAsync(HttpMethod.Put, "/me/chapter-review", new
        {
            editionId = seed.EditionId,
            chapterSlug = slug,
            review = Review(highlightId, $"{run} keep?", $"{run} third?", $"{run} fresh?"),
        });
        Assert.Equal(HttpStatusCode.OK, resaved.StatusCode);
        Assert.Equal(insightId, (await resaved.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("insightId").GetGuid());
        var prompts = DueWithPrefix(await DueAsync(), run).Select(d => d.GetProperty("prompt").GetString()).ToHashSet();
        Assert.Equal(new HashSet<string?> { $"{run} third?", $"{run} fresh?" }, prompts);

        // Deleting the insight takes its questions with it.
        var deleted = await SendAsync(HttpMethod.Delete, $"/me/insights/{insightId}");
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Empty(DueWithPrefix(await DueAsync(), run));
    }

    // ── answer ──

    [Fact]
    public async Task AnswerReviewQuestion_BadAssessment_400_UnknownId_404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var bad = await SendAsync(HttpMethod.Post, $"/me/review-questions/{Guid.NewGuid()}/answer", new { selfAssessment = "easy" });
        var missing = await SendAsync(HttpMethod.Post, $"/me/review-questions/{Guid.NewGuid()}/answer", new { selfAssessment = "knew" });

        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
    }
}
