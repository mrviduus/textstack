using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// <c>/me/insights</c> — the conclusions an outside assistant writes back into a book.
///
/// <para>Four properties are load-bearing and none of them is visible from a unit test, because
/// every one of them lives in Postgres:</para>
/// <list type="number">
///   <item><b>Upsert.</b> One insight per (user, book, chapter), so a second pass over a book
///   refreshes the конспект instead of duplicating it.</item>
///   <item><b>Upsert of the BOOK-LEVEL one.</b> Its chapter_slug is NULL, and Postgres treats NULLs
///   in a unique index as distinct unless the index says otherwise — so the overview, the single row
///   most likely to be rewritten, is exactly the row a default index would fail to protect. The
///   mapping sets NULLS NOT DISTINCT; this asserts it took.</item>
///   <item><b>Chapter resolution at read time.</b> The slug is resolved to a number and title on the
///   way out, so a re-ingest that renumbers chapters cannot leave a stale ordinal behind.</item>
///   <item><b>Isolation.</b> Another user asking about the same book gets nothing.</item>
/// </list>
///
/// <para>Requires: docker compose up, and ENABLE_TEST_AUTH=true for the authenticated half.
/// Skips (does not fail) when either is unavailable, like the rest of this suite.</para>
/// </summary>
public class InsightsEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private readonly AuthenticatedApiFixture _auth;

    public InsightsEndpointTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    {
        _fixture = fixture;
        _auth = auth;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>An edition with at least one slugged chapter, or null when the DB has none seeded.</summary>
    private async Task<(Guid EditionId, string ChapterSlug)?> FindSeededChapterAsync()
    {
        var listReq = _fixture.CreateRequest(HttpMethod.Get, "/books?limit=1");
        var listResp = await _fixture.Client.SendAsync(listReq, Ct);
        if (!listResp.IsSuccessStatusCode) return null;

        var list = await listResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        if (!list.TryGetProperty("items", out var items) || items.GetArrayLength() == 0) return null;
        var slug = items[0].GetProperty("slug").GetString();

        var bookReq = _fixture.CreateRequest(HttpMethod.Get, $"/books/{slug}");
        var bookResp = await _fixture.Client.SendAsync(bookReq, Ct);
        if (!bookResp.IsSuccessStatusCode) return null;

        var book = await bookResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        var editionId = book.GetProperty("id").GetGuid();
        if (!book.TryGetProperty("chapters", out var chapters)) return null;

        foreach (var c in chapters.EnumerateArray())
        {
            if (c.TryGetProperty("slug", out var s) && s.ValueKind == JsonValueKind.String)
                return (editionId, s.GetString()!);
        }

        return null;
    }

    /// <summary>
    /// Saves and returns the row. Accepts 201 or 200, deliberately: whether the FIRST save of a run
    /// creates or replaces depends on whether a previous run left a row behind, and this suite runs
    /// against a live database as the same test user. 201-vs-200 is therefore a fact about the
    /// database's history, not about the feature. What the feature promises — one row per
    /// (user, book, chapter) — is asserted on the id.
    /// </summary>
    private async Task<JsonElement> SaveAsync(object body)
    {
        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(body);
        var resp = await _auth.Client.SendAsync(req, Ct);
        Assert.True(
            resp.StatusCode is HttpStatusCode.Created or HttpStatusCode.OK,
            $"save returned {(int)resp.StatusCode}");
        return await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
    }

    /// <summary>Saves and requires a REPLACE (200) — used for the second write of a pair.</summary>
    private async Task<JsonElement> ResaveAsync(object body)
    {
        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(body);
        var resp = await _auth.Client.SendAsync(req, Ct);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
    }

    // ── unauthenticated ─────────────────────────────────────────────────────────

    [Fact]
    public async Task GetInsights_WithoutAuth_Returns401()
    {
        var req = _fixture.CreateRequest(HttpMethod.Get, $"/me/insights?editionId={Guid.NewGuid()}");
        var resp = await _fixture.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task SaveInsight_WithoutAuth_Returns401()
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new { editionId = Guid.NewGuid(), text = "x" });
        var resp = await _fixture.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    // ── the XOR ─────────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(true, true)]    // both targets
    [InlineData(false, false)]  // neither
    public async Task SaveInsight_NotExactlyOneTarget_Returns400(bool edition, bool userBook)
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new
        {
            editionId = edition ? Guid.NewGuid() : (Guid?)null,
            userBookId = userBook ? Guid.NewGuid() : (Guid?)null,
            text = "x",
        });
        var resp = await _auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task GetInsights_NotExactlyOneTarget_Returns400(bool edition, bool userBook)
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var query = (edition, userBook) switch
        {
            (true, true) => $"?editionId={Guid.NewGuid()}&userBookId={Guid.NewGuid()}",
            _ => "",
        };
        var req = _auth.CreateRequest(HttpMethod.Get, $"/me/insights{query}");
        var resp = await _auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // ── validation ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task SaveInsight_UnknownEdition_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new { editionId = Guid.NewGuid(), text = "x" });
        var resp = await _auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task SaveInsight_ChapterSlugThatDoesNotExist_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new
        {
            editionId = seed!.Value.EditionId,
            chapterSlug = "no-such-chapter-anywhere",
            text = "x",
        });
        var resp = await _auth.Client.SendAsync(req, Ct);

        // A hallucinated slug is refused while the caller can still fix it, rather
        // than stored as an insight that never places in the конспект.
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task SaveInsight_EmptyText_Returns400()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new { editionId = seed!.Value.EditionId, text = "   " });
        var resp = await _auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task SaveInsight_OversizedText_Returns400()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");

        var req = _auth.CreateRequest(HttpMethod.Post, "/me/insights");
        req.Content = JsonContent.Create(new
        {
            editionId = seed!.Value.EditionId,
            text = new string('x', 20_001),
        });
        var resp = await _auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
    }

    // ── upsert + read-back ──────────────────────────────────────────────────────

    [Fact]
    public async Task SaveInsight_SameChapterTwice_ReplacesInsteadOfDuplicating()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");
        var (editionId, chapterSlug) = seed!.Value;

        var first = await SaveAsync(
            new { editionId, chapterSlug, text = "First pass.", question = "what is going on here?" });

        var second = await ResaveAsync(
            new { editionId, chapterSlug, text = "Second pass, rewritten." });

        Assert.Equal(first.GetProperty("id").GetGuid(), second.GetProperty("id").GetGuid());
        Assert.Equal("Second pass, rewritten.", second.GetProperty("text").GetString());
    }

    [Fact]
    public async Task SaveInsight_BookLevelTwice_AlsoReplaces_NullsAreNotDistinct()
    {
        // The regression this exists for: with a default unique index, chapter_slug
        // IS NULL rows do not collide, so the конспект's overview — the row rewritten
        // most often — would be the only one that silently accumulated duplicates.
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");
        var editionId = seed!.Value.EditionId;

        var first = await SaveAsync(new { editionId, text = "Overview, first pass." });
        var second = await ResaveAsync(new { editionId, text = "Overview, second pass." });

        Assert.Equal(first.GetProperty("id").GetGuid(), second.GetProperty("id").GetGuid());
    }

    [Fact]
    public async Task GetInsights_ResolvesChapterPlacement_AndPutsTheOverviewFirst()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");
        var (editionId, chapterSlug) = seed!.Value;

        await SaveAsync(new { editionId, text = "The book in one paragraph." });
        await SaveAsync(new { editionId, chapterSlug, text = "About this chapter." });

        var req = _auth.CreateRequest(HttpMethod.Get, $"/me/insights?editionId={editionId}");
        var resp = await _auth.Client.SendAsync(req, Ct);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var rows = await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        var items = rows.EnumerateArray().ToArray();
        Assert.True(items.Length >= 2);

        // Reading order: the whole-book overview leads.
        Assert.Equal(JsonValueKind.Null, items[0].GetProperty("chapterSlug").ValueKind);

        // The chapter one carries a number and a title resolved from the slug at
        // read time — not a number frozen when it was written.
        var chapterRow = items.Single(i => i.GetProperty("chapterSlug").GetString() == chapterSlug);
        Assert.Equal(JsonValueKind.Number, chapterRow.GetProperty("chapterNumber").ValueKind);
        Assert.False(string.IsNullOrWhiteSpace(chapterRow.GetProperty("chapterTitle").GetString()));
    }

    [Fact]
    public async Task GetInsights_UnknownBook_Returns404_NotAnEmptyList()
    {
        // The read filters by user_id, so a stranger's book leaks nothing either way.
        // But an empty list is a truthful answer to "what have I worked out about this
        // book", and letting a wrong id borrow that answer is how a mistake reads as a
        // fact. Mirrors GET /me/highlights/userbook/{id}.
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        foreach (var query in new[] { $"userBookId={Guid.NewGuid()}", $"editionId={Guid.NewGuid()}" })
        {
            var req = _auth.CreateRequest(HttpMethod.Get, $"/me/insights?{query}");
            var resp = await _auth.Client.SendAsync(req, Ct);
            Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
        }
    }

    // ── isolation ───────────────────────────────────────────────────────────────

    [Fact]
    public async Task GetInsights_AnotherUser_SeesNothing()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");
        var seed = await FindSeededChapterAsync();
        Assert.SkipWhen(seed is null, "no seeded book with a slugged chapter");
        var editionId = seed!.Value.EditionId;

        await SaveAsync(new { editionId, text = "Only this user's conclusion." });

        // A second identity. Registration, not a guest session: the guest policy is 3
        // per 5 minutes per IP, so a guest here skips this test on any run that has
        // minted one — and this is the assertion in this file least worth skipping.
        // Registration is the same knob family with an order of magnitude more room.
        var registerReq = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        registerReq.Content = JsonContent.Create(new
        {
            email = $"insight-isolation-{Guid.NewGuid():N}@example.test",
            password = "Test12345!",
            name = "Insight Isolation",
        });
        var otherUser = await _fixture.Client.SendAsync(registerReq, Ct);
        Assert.SkipWhen(otherUser.StatusCode == HttpStatusCode.TooManyRequests,
            "user-login rate limited (RateLimits:UserLoginPermitLimit)");
        Assert.True(otherUser.IsSuccessStatusCode, $"register returned {(int)otherUser.StatusCode}");

        var cookie = string.Join("; ", otherUser.Headers.GetValues("Set-Cookie")
            .Select(c => c.Split(';')[0].Trim()));

        // A catalog edition exists for everyone, so this is the read succeeding and
        // returning nothing — isolation, not a 404 standing in for it.
        var otherReq = _fixture.CreateRequest(HttpMethod.Get, $"/me/insights?editionId={editionId}");
        otherReq.Headers.Add("Cookie", cookie);
        var otherResp = await _fixture.Client.SendAsync(otherReq, Ct);

        Assert.Equal(HttpStatusCode.OK, otherResp.StatusCode);
        var rows = await otherResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        Assert.Empty(rows.EnumerateArray());
    }
}

/// <summary>
/// <c>GET /me/library/search</c> — the library full-text search.
///
/// <para>One test, for one reason. The endpoint's raw SQL aliased its columns in PascalCase while
/// the context is built with <c>UseSnakeCaseNamingConvention</c>, which applies to the
/// <c>SqlQueryRaw</c> row type as well — so EF asked for <c>chapter_slug</c>, got
/// <c>"ChapterSlug"</c>, and threw on <b>every</b> call. It answered 500 for its whole life and
/// nobody noticed, because the web caller renders an empty result on failure and an empty library
/// search looks exactly like a library with nothing matching.</para>
///
/// <para>No unit test can catch this: it is only wrong once real SQL meets a real database. This
/// asserts the shape of the answer, not its contents, so it holds on any seeded database.</para>
/// </summary>
public class UserLibrarySearchEndpointTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Theory]
    [InlineData("q=quorum")]
    [InlineData("q=quorum&tags=nonexistent-tag")] // the other SQL branch — it is built separately
    public async Task SearchLibrary_Authenticated_Returns200AndAJsonArray(string query)
    {
        Assert.SkipUnless(auth.IsAuthenticated, "test-login unavailable (ENABLE_TEST_AUTH)");

        var req = auth.CreateRequest(HttpMethod.Get, $"/me/library/search?{query}");
        var resp = await auth.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        Assert.Equal(JsonValueKind.Array, body.ValueKind);
    }

    [Fact]
    public async Task SearchLibrary_WithoutAuth_Returns401()
    {
        var req = fixture.CreateRequest(HttpMethod.Get, "/me/library/search?q=quorum");
        var resp = await fixture.Client.SendAsync(req, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
