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

    private HttpRequestMessage Authed(HttpMethod method, string path, string token)
    {
        var req = _fixture.CreateRequest(method, path);
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        return req;
    }

    private async Task<HttpResponseMessage> CallAsync(
        string method, string path, object? body, string token, CancellationToken ct)
    {
        var req = Authed(new HttpMethod(method), path, token);
        if (body is not null) req.Content = JsonContent.Create(body);
        return await _fixture.Client.SendAsync(req, ct);
    }

    private async Task SaveWordAsync(string token, CancellationToken ct)
    {
        var word = $"gdel{Guid.NewGuid():N}"[..16];
        var resp = await CallAsync("PUT", "/me/v2/vocabulary/words",
            new { id = Guid.NewGuid(), language = "en", word, translation = "x" }, token, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/v2/vocabulary/words unavailable");
        resp.EnsureSuccessStatusCode();
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

    /// <summary>
    /// "Delete guest data" (ADR-014 §3) is <c>DELETE /me/account</c> with the guest's own token —
    /// no IsGuest branch, no password. The row must actually go, not just the session.
    /// </summary>
    [Fact]
    public async Task DeleteAccount_GuestToken_RowGone()
    {
        var ct = TestContext.Current.CancellationToken;

        var guest = await BodyAsync(await PostGuestAsync(ct, mobile: true), ct);
        var token = RequireNonEmpty(guest, "accessToken");
        await SaveWordAsync(token, ct);

        var before = await _fixture.Client.SendAsync(Authed(HttpMethod.Get, "/me/profile", token), ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(before), "/me/profile unavailable");
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);

        var del = await _fixture.Client.SendAsync(Authed(HttpMethod.Delete, "/me/account", token), ct);
        Assert.SkipWhen(
            del.StatusCode == HttpStatusCode.TooManyRequests,
            "account-delete rate limit hit — raise ACCOUNT_DELETE_PERMIT_LIMIT");
        Assert.Equal(HttpStatusCode.NoContent, del.StatusCode);

        // Token is still signature-valid; the row behind it is not.
        var after = await _fixture.Client.SendAsync(Authed(HttpMethod.Get, "/me/profile", token), ct);
        Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
    }
}
