using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// <c>POST /auth/guest</c> — the endpoint mobile calls on first launch.
/// Requires: docker compose up (API at localhost:8080).
///
/// This suite creates several guests, so it needs the guest-session limiter raised:
/// <c>RateLimits__GuestSessionPermitLimit</c> (compose env, CI sets it; production keeps 3).
/// It is a knob and not a bypass — the limiter runs on the same code path here as in production,
/// which is why hitting it SKIPS with an actionable message instead of silently passing.
/// </summary>
public class GuestSessionEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public GuestSessionEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    /// <param name="bearer">Access token to present, or null for an anonymous call.</param>
    /// <param name="scheme">Auth scheme spelling — exercised because it used to matter (see the
    /// lowercase-bearer merge test).</param>
    private async Task<HttpResponseMessage> PostGuestAsync(
        CancellationToken ct, string? bearer = null, bool mobile = false,
        string scheme = "Bearer", string? cookie = null)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/guest");
        if (mobile)
            req.Headers.Add("X-Client", "mobile");
        if (bearer != null)
            req.Headers.TryAddWithoutValidation("Authorization", $"{scheme} {bearer}");
        if (cookie != null)
            req.Headers.Add("Cookie", cookie);
        return await _fixture.Client.SendAsync(req, ct);
    }

    private static void SkipIfUnusable(HttpResponseMessage resp)
    {
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/auth/guest unavailable");
        Assert.SkipWhen(
            resp.StatusCode == HttpStatusCode.TooManyRequests,
            "guest-session rate limit hit — raise RateLimits__GuestSessionPermitLimit in the compose env");
    }

    private static async Task<JsonElement> BodyAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        SkipIfUnusable(resp);
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    private static string RequireNonEmpty(JsonElement body, string property)
    {
        Assert.True(body.TryGetProperty(property, out var el), $"response has no `{property}`");
        var value = el.GetString();
        Assert.False(string.IsNullOrEmpty(value), $"`{property}` was null/empty");
        return value!;
    }

    /// <summary>Extracts an access_token cookie value from Set-Cookie, or null if absent.</summary>
    private static string? AccessCookie(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Set-Cookie", out var cookies)) return null;
        return cookies
            .Select(c => c.Split(';')[0].Trim())
            .FirstOrDefault(c => c.StartsWith("access_token=", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateGuestSession_MobileClientAnonymous_ReturnsBothTokensAndGuestUser()
    {
        var ct = TestContext.Current.CancellationToken;

        var resp = await PostGuestAsync(ct, mobile: true);
        var body = await BodyAsync(resp, ct);

        RequireNonEmpty(body, "accessToken");
        RequireNonEmpty(body, "refreshToken");
        Assert.True(body.GetProperty("user").GetProperty("isGuest").GetBoolean());
    }

    /// <summary>
    /// The regression this endpoint change exists for. A mobile client calling
    /// <c>ensureGuestSession()</c> while a valid access token already sits in SecureStore used to
    /// get a <c>{user}</c>-only body — so <c>accessToken</c> was <c>undefined</c>, and
    /// <c>signInWithTokens(res.accessToken, …)</c> wrote that <c>undefined</c> over a WORKING
    /// session and destroyed it. The second call must return a usable pair for the SAME user.
    /// If this ever fails with a present-but-empty token, mobile is one release away from
    /// wiping sessions again.
    /// </summary>
    [Fact]
    public async Task CreateGuestSession_MobileClientWithExistingSession_ReissuesTokensForSameUser()
    {
        var ct = TestContext.Current.CancellationToken;

        var first = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var token = RequireNonEmpty(first, "accessToken");
        var userId = first.GetProperty("user").GetProperty("id").GetString();

        var second = await BodyAsync(await PostGuestAsync(ct, bearer: token, mobile: true), ct);

        Assert.Equal(userId, second.GetProperty("user").GetProperty("id").GetString());
        RequireNonEmpty(second, "accessToken");
        RequireNonEmpty(second, "refreshToken");
    }

    [Fact]
    public async Task CreateGuestSession_MobileClient_SetsNoAuthCookies()
    {
        var ct = TestContext.Current.CancellationToken;

        var resp = await PostGuestAsync(ct, mobile: true);
        SkipIfUnusable(resp);
        resp.EnsureSuccessStatusCode();

        // Mobile carries tokens in the body; a cookie here would be dead weight the app can't use.
        var setCookies = resp.Headers.TryGetValues("Set-Cookie", out var v) ? v.ToList() : [];
        Assert.DoesNotContain(setCookies, c => c.StartsWith("access_token=", StringComparison.Ordinal));
        Assert.DoesNotContain(setCookies, c => c.StartsWith("refresh_token=", StringComparison.Ordinal));
    }

    /// <summary>
    /// Web contract is unchanged: with a valid cookie session the body stays <c>{user}</c>-only
    /// (the cookie is already set, re-issuing would just churn refresh-token rows).
    /// </summary>
    [Fact]
    public async Task CreateGuestSession_WebClientWithExistingSession_ReturnsUserWithoutTokens()
    {
        var ct = TestContext.Current.CancellationToken;

        var firstResp = await PostGuestAsync(ct);
        var first = await BodyAsync(firstResp, ct);
        var userId = first.GetProperty("user").GetProperty("id").GetString();
        var cookie = AccessCookie(firstResp);
        Assert.SkipWhen(cookie is null, "web /auth/guest did not set an access_token cookie");

        var secondResp = await PostGuestAsync(ct, cookie: cookie);
        var second = await BodyAsync(secondResp, ct);

        Assert.False(second.TryGetProperty("accessToken", out _), "web response must not carry tokens");
        Assert.False(second.TryGetProperty("refreshToken", out _), "web response must not carry tokens");
        Assert.Equal(userId, second.GetProperty("user").GetProperty("id").GetString());
    }

    private async Task<HttpResponseMessage> RegisterAsync(
        string guestToken, string scheme, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        req.Headers.TryAddWithoutValidation("Authorization", $"{scheme} {guestToken}");
        req.Content = JsonContent.Create(new
        {
            email = AccountEmail(),
            password = AccountPassword,
            name = "Merge Probe",
        });
        return await _fixture.Client.SendAsync(req, ct);
    }

    /// <summary>
    /// Registration promotes the guest IN PLACE, so a successful merge is observable as "the new
    /// account has the guest's user id". Anything else means the guest was authenticated but its
    /// data was silently orphaned.
    /// </summary>
    private async Task AssertGuestPromotedInPlaceAsync(string scheme, CancellationToken ct)
    {
        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");
        var guestId = guest.GetProperty("user").GetProperty("id").GetString();

        var resp = await RegisterAsync(guestToken, scheme, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/auth/register unavailable");
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        var user = body.GetProperty("user");
        Assert.Equal(guestId, user.GetProperty("id").GetString());
        Assert.False(user.GetProperty("isGuest").GetBoolean());
    }

    // --- Guest -> existing account merge (different user ids, MergeGuestAsync path) ---

    private const string AccountPassword = "correct-horse-battery";
    private static string AccountEmail() => $"guest-merge-{Guid.NewGuid():N}@textstack.test";

    private async Task SetNativeLanguageAsync(string token, string language, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Put, "/me/profile");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        // Name is sent too: UpdateProfile assigns Name unconditionally, so omitting it clears it.
        req.Content = JsonContent.Create(new { name = "Merge Probe", nativeLanguage = language });

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/profile unavailable");
        resp.EnsureSuccessStatusCode();
    }

    private async Task<string?> GetNativeLanguageAsync(string token, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Get, "/me/profile");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/profile unavailable");
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        return body.GetProperty("user").GetProperty("nativeLanguage").GetString();
    }

    /// <summary>Logs into an existing account while presenting the guest's token, which is what
    /// triggers <c>MergeGuestAsync</c> across two different user ids. Returns the account's new token.</summary>
    private async Task<string> LoginMergingGuestAsync(string email, string guestToken, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/login");
        req.Headers.Add("X-Client", "mobile");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {guestToken}");
        req.Content = JsonContent.Create(new { email, password = AccountPassword });

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/auth/login unavailable");
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        return RequireNonEmpty(body, "accessToken");
    }

    private async Task<(string Email, string Token)> RegisterAccountWithEmailAsync(
        string? nativeLanguage, CancellationToken ct)
    {
        var email = AccountEmail();
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        req.Headers.Add("X-Client", "mobile");
        req.Content = JsonContent.Create(new { email, password = AccountPassword, name = "Merge Account" });

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/auth/register unavailable");
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        var token = RequireNonEmpty(body, "accessToken");
        if (nativeLanguage != null)
            await SetNativeLanguageAsync(token, nativeLanguage, ct);
        return (email, token);
    }

    private async Task<string> CreateGuestWithNativeLanguageAsync(string language, CancellationToken ct)
    {
        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var token = RequireNonEmpty(guest, "accessToken");
        await SetNativeLanguageAsync(token, language, ct);
        return token;
    }

    /// <summary>
    /// The guest answers "what language do you already know?" on their first word tap. Signing into
    /// an existing account re-parents their data and DELETES the guest row — so without an explicit
    /// carry-over the answer vanishes and the app asks again minutes later.
    /// </summary>
    [Fact]
    public async Task Login_AccountWithoutNativeLanguage_InheritsGuestNativeLanguage()
    {
        var ct = TestContext.Current.CancellationToken;

        var (email, _) = await RegisterAccountWithEmailAsync(nativeLanguage: null, ct);
        var guestToken = await CreateGuestWithNativeLanguageAsync("uk", ct);

        var accountToken = await LoginMergingGuestAsync(email, guestToken, ct);

        Assert.Equal("uk", await GetNativeLanguageAsync(accountToken, ct));
    }

    /// <summary>
    /// The more important half: a throwaway guest session must NOT overwrite a setting the user
    /// made on their real account. The account's own value wins.
    /// </summary>
    [Fact]
    public async Task Login_AccountWithOwnNativeLanguage_KeepsItOverGuestValue()
    {
        var ct = TestContext.Current.CancellationToken;

        var (email, _) = await RegisterAccountWithEmailAsync(nativeLanguage: "de", ct);
        var guestToken = await CreateGuestWithNativeLanguageAsync("fr", ct);

        var accountToken = await LoginMergingGuestAsync(email, guestToken, ct);

        Assert.Equal("de", await GetNativeLanguageAsync(accountToken, ct));
    }

    // --- Guest-created rows must survive the merge (MergeGuestAsync re-parent coverage) ---

    // Non-"en" languages are absent from the wordfreq dataset, so the frequency filter fails open
    // to SrsEligible — cap arithmetic is then what the test exercises, not word-list luck.
    private const string SrsLang = "de";

    // Validator floor in VocabularyEndpoints. Filling 5 saves is cheap; 50 (the guest tier cap)
    // is not, so the user-chosen cap is what we drive the pending path with.
    private const int MinDailyCap = 5;

    private static string UniqueWord(string prefix) => $"{prefix}{Guid.NewGuid():N}"[..16];

    private HttpRequestMessage Authed(HttpMethod method, string path, string token)
    {
        var req = _fixture.CreateRequest(method, path);
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        return req;
    }

    private async Task<JsonElement> SendJsonAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), $"{req.RequestUri} unavailable");
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    private async Task SetVocabSettingsAsync(string token, int dailyCap, CancellationToken ct)
    {
        var req = Authed(HttpMethod.Put, "/me/vocabulary/settings", token);
        req.Content = JsonContent.Create(new
        {
            dailyNewCap = dailyCap,
            weeklyReviewBudget = 70,
            frequencyFilterEnabled = true,
            clusteringEnabled = true,
            autoRetireEnabled = true,
        });
        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/vocabulary/settings unavailable");
        resp.EnsureSuccessStatusCode();
    }

    private async Task<JsonElement> SaveWordAsync(string token, string word, string language, CancellationToken ct)
    {
        var req = Authed(HttpMethod.Post, "/me/vocabulary/words", token);
        req.Content = JsonContent.Create(new { word, language, nativeLanguage = "en" });
        return await SendJsonAsync(req, ct);
    }

    private static IEnumerable<string> WordsOf(JsonElement listResponse) =>
        listResponse.GetProperty("items").EnumerateArray().Select(i => i.GetProperty("word").GetString()!);

    /// <summary>
    /// The two rows a guest produces first: an over-cap save (PendingVocabularyWord) and a
    /// rare-word tap (WordLookup). Neither was re-parented, so both died with the guest row on
    /// sign-in — and the daily enrichment cap makes the pending bucket MORE reachable, not less.
    /// </summary>
    [Fact]
    public async Task Login_GuestWithPendingWordAndLookup_BothSurviveAndBelongToAccount()
    {
        var ct = TestContext.Current.CancellationToken;

        var (email, _) = await RegisterAccountWithEmailAsync(nativeLanguage: null, ct);
        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");

        await SetVocabSettingsAsync(guestToken, MinDailyCap, ct);
        for (var i = 0; i < MinDailyCap; i++)
            await SaveWordAsync(guestToken, UniqueWord($"zzfill{i}"), SrsLang, ct);

        var pendingWord = UniqueWord("zzpend");
        var pendingSave = await SaveWordAsync(guestToken, pendingWord, SrsLang, ct);
        Assert.SkipWhen(
            pendingSave.GetProperty("outcome").GetString() != "pending",
            "daily cap did not push the save into the pending bucket");

        // Guid-suffixed English word cannot exist in the wordfreq dataset ⇒ LookupOnly.
        var lookupWord = UniqueWord("zzoov");
        var lookupSave = await SaveWordAsync(guestToken, lookupWord, "en", ct);
        Assert.Equal("lookup", lookupSave.GetProperty("outcome").GetString());

        var accountToken = await LoginMergingGuestAsync(email, guestToken, ct);

        var pending = await SendJsonAsync(Authed(HttpMethod.Get, "/me/vocabulary/pending", accountToken), ct);
        Assert.Contains(pendingWord, WordsOf(pending));

        var lookups = await SendJsonAsync(Authed(HttpMethod.Get, "/me/vocabulary/lookups", accountToken), ct);
        Assert.Contains(lookupWord, WordsOf(lookups));

        // UserVocabularySettings is keyed on (UserId, SiteId), so it is COPIED, not re-parented —
        // and only because this fresh account had no row of its own.
        var settings = await SendJsonAsync(Authed(HttpMethod.Get, "/me/vocabulary/settings", accountToken), ct);
        Assert.Equal(MinDailyCap, settings.GetProperty("dailyNewCap").GetInt32());
    }

    /// <summary>
    /// The conflict case on a unique-keyed table. WordLookup is unique on
    /// (UserId, SiteId, Word, Language), so re-parenting a guest row onto an account that already
    /// tapped the same word would violate the index — the merge must drop the guest's row and keep
    /// the account's, exactly as it does for VocabularyWords.
    /// </summary>
    [Fact]
    public async Task Login_GuestAndAccountTappedSameWord_AccountLookupWinsWithoutConflict()
    {
        var ct = TestContext.Current.CancellationToken;

        var (email, accountTokenBefore) = await RegisterAccountWithEmailAsync(nativeLanguage: null, ct);
        var sharedWord = UniqueWord("zzdup");

        await SetVocabSettingsAsync(accountTokenBefore, 15, ct);
        Assert.Equal("lookup", (await SaveWordAsync(accountTokenBefore, sharedWord, "en", ct))
            .GetProperty("outcome").GetString());

        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");
        await SetVocabSettingsAsync(guestToken, 15, ct);
        Assert.Equal("lookup", (await SaveWordAsync(guestToken, sharedWord, "en", ct))
            .GetProperty("outcome").GetString());

        // Would throw 23505 if the merge re-parented blindly.
        var accountToken = await LoginMergingGuestAsync(email, guestToken, ct);

        var lookups = await SendJsonAsync(Authed(HttpMethod.Get, "/me/vocabulary/lookups", accountToken), ct);
        Assert.Single(WordsOf(lookups), w => w == sharedWord);
    }

    /// <summary>Collections are guest-creatable (Create only checks that a user id resolves), so
    /// a shelf built before sign-in must not vanish at sign-in.</summary>
    [Fact]
    public async Task Login_GuestWithCollection_CollectionBelongsToAccount()
    {
        var ct = TestContext.Current.CancellationToken;

        var (email, _) = await RegisterAccountWithEmailAsync(nativeLanguage: null, ct);
        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");

        var name = $"Guest shelf {Guid.NewGuid():N}"[..24];
        var createReq = Authed(HttpMethod.Post, "/me/library/collections", guestToken);
        createReq.Content = JsonContent.Create(new { name, color = "default" });
        var created = await SendJsonAsync(createReq, ct);
        var collectionId = created.GetProperty("id").GetString();

        var accountToken = await LoginMergingGuestAsync(email, guestToken, ct);

        var resp = await _fixture.Client.SendAsync(
            Authed(HttpMethod.Get, "/me/library/collections", accountToken), ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/library/collections unavailable");
        resp.EnsureSuccessStatusCode();

        var list = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Contains(collectionId, list.EnumerateArray().Select(c => c.GetProperty("id").GetString()));
    }

    // --- Paid-inference surface is account-only (server-side, not just the mobile UI flag) ---

    /// <summary>
    /// Every endpoint that spends money on an LLM call. The mobile client has its own
    /// <c>canUseAi = isAccount</c> flag, but that is a UI affordance: a guest session mints a valid
    /// bearer token, so before the entitlement gate each of these answered a guest with a real paid
    /// call and an IP rate limit as its only barrier.
    /// <para>
    /// One entry, and that is the point of the list rather than a reason to delete it: ask, book chat
    /// and RAG indexing were removed 2026-09-10, and a matrix that still named them would assert 404
    /// — "route gone" — while reading like "guest correctly refused". Anything new that spends on
    /// inference belongs here on the day it ships.
    /// </para>
    /// Route params are arbitrary GUIDs on purpose — the filter runs before the handler, so the
    /// answer must not depend on whether the book exists.
    /// </summary>
    private static readonly (string Method, string Path, object? Body)[] PaidInferenceEndpoints =
    [
        ("POST", "/me/tutor/session", new { maxItems = 3 }),
    ];

    private async Task<HttpResponseMessage> CallAsync(
        string method, string path, object? body, string token, CancellationToken ct)
    {
        var req = Authed(new HttpMethod(method), path, token);
        if (body is not null) req.Content = JsonContent.Create(body);
        return await _fixture.Client.SendAsync(req, ct);
    }

    // One identity for the whole sweep rather than a [Theory] case each: /auth/register shares a
    // GLOBAL 10/min "user-login" bucket, so a per-case account would rate-limit itself into skips
    // and the sweep would quietly verify nothing.
    [Fact]
    public async Task PaidInference_GuestToken_IsForbiddenWithAccountRequiredEverywhere()
    {
        var ct = TestContext.Current.CancellationToken;

        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");

        // Collected, not fail-fast: one run should name EVERY route still open to a guest.
        var open = new List<string>();
        foreach (var (method, path, body) in PaidInferenceEndpoints)
        {
            var resp = await CallAsync(method, path, body, guestToken, ct);

            // NO 404 escape hatch, deliberately. `RequireAiAccount` runs BEFORE the handler, so a
            // gated route answers 403 whatever the GUID in the path is; a 404 can only mean the
            // filter did not run. Verified against a real account token on the running stack:
            // /books/{empty}/ask, /me/books/{empty}/ask,
            // GET /me/chat, /books/{empty}/index and /me/books/{empty}/index all answer 404 once
            // the handler is reached. Six of the nine routes here would therefore have passed this
            // sweep with their filter deleted, which is the whole point of the sweep.
            if (resp.StatusCode != HttpStatusCode.Forbidden)
            {
                open.Add($"{method} {path} → {(int)resp.StatusCode}");
                continue;
            }

            // Clients branch on this to say "create a free account" rather than "sign in".
            var problem = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
            if (problem.GetProperty("error").GetString() != "account_required")
                open.Add($"{method} {path} → 403 without account_required");
        }

        Assert.True(open.Count == 0, $"paid inference reachable by a guest: {string.Join("; ", open)}");
    }

    /// <summary>
    /// The other half: a real account is NOT forbidden. Asserting "not 403" rather than "200" is
    /// deliberate — these endpoints need OpenAI and a real book, neither of which a CI box has, so
    /// demanding 200 would make the test lie about what it verified.
    /// </summary>
    [Fact]
    public async Task PaidInference_AccountToken_IsNeverForbidden()
    {
        var ct = TestContext.Current.CancellationToken;

        var (_, accountToken) = await RegisterAccountWithEmailAsync(nativeLanguage: null, ct);

        var blocked = new List<string>();
        foreach (var (method, path, body) in PaidInferenceEndpoints)
        {
            var resp = await CallAsync(method, path, body, accountToken, ct);
            if (resp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
                blocked.Add($"{method} {path} → {(int)resp.StatusCode}");
        }

        Assert.True(blocked.Count == 0, $"account locked out of its own features: {string.Join("; ", blocked)}");
    }

    /// <summary>
    /// The guard against over-correcting. Translation and dictionary are anonymous ON PURPOSE — the
    /// reading loop stands on them, and a guest tapping a word must never meet a paywall. If a
    /// future "lock AI down" change catches these, this test is what says so.
    /// </summary>
    [Fact]
    public async Task ReadingLoop_GuestToken_TranslationAndDictionaryStayOpen()
    {
        var ct = TestContext.Current.CancellationToken;

        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var guestToken = RequireNonEmpty(guest, "accessToken");

        var dictionary = await CallAsync("GET", "/dictionary/en/book", null, guestToken, ct);
        // Asserting "not locked out" rather than 200: both call third parties a CI box may not
        // reach (Free Dictionary, OpenAI). A 502/504 here is the network; a 401/403 would be us.
        Assert.NotEqual(HttpStatusCode.Forbidden, dictionary.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, dictionary.StatusCode);

        var translate = await CallAsync(
            "POST", "/translate",
            new { text = "book", sourceLang = "en", targetLang = "uk" }, guestToken, ct);
        Assert.NotEqual(HttpStatusCode.Forbidden, translate.StatusCode);
        Assert.NotEqual(HttpStatusCode.Unauthorized, translate.StatusCode);
    }

    [Fact]
    public async Task Register_WithCanonicalBearerScheme_MergesGuestInPlace()
    {
        await AssertGuestPromotedInPlaceAsync("Bearer", TestContext.Current.CancellationToken);
    }

    /// <summary>
    /// RFC 7235 says the auth scheme is case-insensitive, and <c>GetUserId</c> always agreed.
    /// <c>GetGuestUserId</c> did not: it stripped the prefix with a literal
    /// <c>.Replace("Bearer ", "")</c>, so a lowercase <c>bearer</c> left the token unparsable, the
    /// JWT read threw, the catch returned null — and the guest was authenticated but silently NOT
    /// merged. Both now read the token through one helper; this test is what keeps them together.
    /// </summary>
    [Fact]
    public async Task Register_WithLowercaseBearerScheme_MergesGuestInPlace()
    {
        await AssertGuestPromotedInPlaceAsync("bearer", TestContext.Current.CancellationToken);
    }
}
