using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Web;

namespace TextStack.IntegrationTests;

/// <summary>
/// The MCP OAuth server end to end against a live API (ADR-017): register → authorize → consent →
/// token → use → refresh → revoke, plus the refusals that make it safe. The side effects are asserted
/// from the far end — a revoked grant must stop the NEXT request, a rotated refresh token must be
/// dead on reuse — because that is the only place they are true.
/// </summary>
public class OAuthFlowTests : IClassFixture<LiveApiFixture>, IDisposable
{
    private const string Redirect = "https://claude.ai/api/mcp/auth_callback";
    private const string Resource = "https://textstack.app/mcp";

    private readonly LiveApiFixture _fixture;

    // Own client: /oauth/authorize answers 302 to https://textstack.app/..., which the fixture's
    // client would FOLLOW — to production. Never follow redirects here.
    private readonly HttpClient _http;

    public OAuthFlowTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
        _http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        {
            BaseAddress = fixture.Client.BaseAddress,
            Timeout = TimeSpan.FromSeconds(30),
        };
    }

    public void Dispose() => _http.Dispose();

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // ── happy path ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task FullFlow_RegisterAuthorizeApproveTokenRefreshRevoke_EveryStepHolds()
    {
        var owner = await SignUpAsync();
        Assert.SkipWhen(owner is null, "registration unavailable");

        var clientId = await RegisterAsync();
        var verifier = NewVerifier();

        // authorize → consent page
        var reqId = await AuthorizeAsync(clientId, verifier, state: "st-1");

        var consent = await SendJsonAsync(Get($"/oauth/requests/{reqId}"));
        Assert.Equal("Integration Claude", consent.GetProperty("clientName").GetString());
        Assert.Equal("claude.ai", consent.GetProperty("redirectHost").GetString());
        Assert.Equal("pending", consent.GetProperty("status").GetString());
        Assert.Equal("library offline_access", consent.GetProperty("scope").GetString());

        // approve → redirect carries code, state and iss (RFC 9207)
        var redirect = await ApproveAsync(reqId, owner!);
        Assert.StartsWith(Redirect + "?", redirect);
        var q = HttpUtility.ParseQueryString(new Uri(redirect).Query);
        Assert.Equal("st-1", q["state"]);
        Assert.Equal("https://textstack.app", q["iss"]);
        var code = q["code"]!;

        // token, form-urlencoded
        var tokenResp = await PostFormAsync("/oauth/token", new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = Redirect,
            ["client_id"] = clientId,
            ["code_verifier"] = verifier,
            ["resource"] = Resource,
        });
        Assert.Equal(HttpStatusCode.OK, tokenResp.StatusCode);
        Assert.Equal("no-store", tokenResp.Headers.CacheControl?.ToString());
        var tokens = await tokenResp.Content.ReadFromJsonAsync<JsonElement>(Ct);
        var access = tokens.GetProperty("access_token").GetString()!;
        var refresh = tokens.GetProperty("refresh_token").GetString()!;
        Assert.StartsWith("tso_", access);
        Assert.StartsWith("tsr_", refresh);
        Assert.Equal("Bearer", tokens.GetProperty("token_type").GetString());
        Assert.Equal(3600, tokens.GetProperty("expires_in").GetInt32());

        // the code is single-use
        var replay = await PostFormAsync("/oauth/token", new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = Redirect,
            ["client_id"] = clientId,
            ["code_verifier"] = verifier,
        });
        await AssertOAuthErrorAsync(replay, "invalid_grant");

        // the access token authenticates an ordinary endpoint, and the grant is listed + stamped
        var grants = await ListGrantsAsync(access);
        var grant = Assert.Single(grants.EnumerateArray());
        Assert.Equal("Integration Claude", grant.GetProperty("clientName").GetString());
        Assert.Equal("claude.ai", grant.GetProperty("redirectHost").GetString());
        Assert.NotEqual(JsonValueKind.Null, grant.GetProperty("lastUsedAt").ValueKind);
        var grantId = grant.GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.NoContent, await TokenStatusAsync(access));

        // refresh rotates both tokens
        var refreshed = await RefreshAsync(refresh, clientId);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        var rotated = await refreshed.Content.ReadFromJsonAsync<JsonElement>(Ct);
        var access2 = rotated.GetProperty("access_token").GetString()!;
        var refresh2 = rotated.GetProperty("refresh_token").GetString()!;
        Assert.NotEqual(access, access2);
        Assert.NotEqual(refresh, refresh2);

        // the old refresh token is dead on reuse, and so is the old access token
        await AssertOAuthErrorAsync(await RefreshAsync(refresh, clientId), "invalid_grant");
        Assert.Equal(HttpStatusCode.Unauthorized, await TokenStatusAsync(access));
        Assert.Equal(HttpStatusCode.NoContent, await TokenStatusAsync(access2));

        // revoke from "Connected apps" — the very next request is refused
        var revoke = Get($"/me/oauth/grants/{grantId}", owner);
        revoke.Method = HttpMethod.Delete;
        Assert.Equal(HttpStatusCode.NoContent, (await _http.SendAsync(revoke, Ct)).StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, await TokenStatusAsync(access2));
        await AssertOAuthErrorAsync(await RefreshAsync(refresh2, clientId), "invalid_grant");
        Assert.Equal(0, (await ListGrantsAsync(owner!)).GetArrayLength());
    }

    [Fact]
    public async Task Revoke_Rfc7009WithRefreshToken_KillsTheAccessTokenToo()
    {
        var owner = await SignUpAsync();
        Assert.SkipWhen(owner is null, "registration unavailable");
        var (access, refresh, _) = await FullGrantAsync(owner!);

        var resp = await PostFormAsync("/oauth/revoke", new() { ["token"] = refresh });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        Assert.Equal(HttpStatusCode.Unauthorized, await TokenStatusAsync(access));
        // Unknown tokens are 200 as well (RFC 7009 §2.2) — no oracle.
        Assert.Equal(HttpStatusCode.OK, (await PostFormAsync("/oauth/revoke", new() { ["token"] = "tsr_nope" })).StatusCode);
    }

    // ── refusals ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task Approve_Guest_Returns403AccountRequired()
    {
        var guestResp = await _http.SendAsync(Mobile(Get("/auth/guest"), HttpMethod.Post), Ct);
        Assert.SkipWhen(guestResp.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.NotFound, "guest session unavailable");
        var guest = (await guestResp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("accessToken").GetString()!;

        var reqId = await AuthorizeAsync(await RegisterAsync(), NewVerifier(), state: "g");

        var approve = Get("/oauth/authorize/approve", guest);
        approve.Method = HttpMethod.Post;
        approve.Content = JsonContent.Create(new { requestId = reqId });
        var resp = await _http.SendAsync(approve, Ct);

        Assert.Equal(HttpStatusCode.Forbidden, resp.StatusCode);
        Assert.Equal("account_required", (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("error").GetString());
    }

    [Fact]
    public async Task Approve_NoSignIn_Returns401()
    {
        var reqId = await AuthorizeAsync(await RegisterAsync(), NewVerifier(), state: "a");

        var approve = Get("/oauth/authorize/approve");
        approve.Method = HttpMethod.Post;
        approve.Content = JsonContent.Create(new { requestId = reqId });

        Assert.Equal(HttpStatusCode.Unauthorized, (await _http.SendAsync(approve, Ct)).StatusCode);
    }

    [Fact]
    public async Task Authorize_UnregisteredRedirect_400AndNeverRedirects()
    {
        var clientId = await RegisterAsync();
        var resp = await _http.SendAsync(Get(AuthorizeUrl(clientId, NewVerifier(), "x", redirect: "https://chatgpt.com/elsewhere")), Ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Null(resp.Headers.Location);
    }

    [Fact]
    public async Task Authorize_NoPkce_RedirectsBackWithInvalidRequest()
    {
        var clientId = await RegisterAsync();
        var url = $"/oauth/authorize?response_type=code&client_id={clientId}&redirect_uri={Uri.EscapeDataString(Redirect)}&state=s";

        var resp = await _http.SendAsync(Get(url), Ct);

        Assert.Equal(HttpStatusCode.Redirect, resp.StatusCode);
        var q = HttpUtility.ParseQueryString(resp.Headers.Location!.Query);
        Assert.Equal("invalid_request", q["error"]);
        Assert.Equal("s", q["state"]);
    }

    [Fact]
    public async Task Authorize_WrongResource_RedirectsBackWithInvalidTarget()
    {
        var clientId = await RegisterAsync();
        var resp = await _http.SendAsync(Get(AuthorizeUrl(clientId, NewVerifier(), "r", resource: "https://evil.example/mcp")), Ct);

        Assert.Equal(HttpStatusCode.Redirect, resp.StatusCode);
        Assert.Equal("invalid_target", HttpUtility.ParseQueryString(resp.Headers.Location!.Query)["error"]);
    }

    [Fact]
    public async Task Token_WrongVerifier_InvalidGrant_AndTheCodeIsBurned()
    {
        var owner = await SignUpAsync();
        Assert.SkipWhen(owner is null, "registration unavailable");
        var clientId = await RegisterAsync();
        var verifier = NewVerifier();
        var code = HttpUtility.ParseQueryString(new Uri(
            await ApproveAsync(await AuthorizeAsync(clientId, verifier, "v"), owner!)).Query)["code"]!;

        await AssertOAuthErrorAsync(await RedeemAsync(clientId, code, NewVerifier()), "invalid_grant");
        // A failed attempt spends the code — the right verifier cannot rescue it afterwards.
        await AssertOAuthErrorAsync(await RedeemAsync(clientId, code, verifier), "invalid_grant");
    }

    [Fact]
    public async Task Deny_RedirectsBackWithAccessDenied()
    {
        var reqId = await AuthorizeAsync(await RegisterAsync(), NewVerifier(), state: "d");

        var deny = Get("/oauth/authorize/deny");
        deny.Method = HttpMethod.Post;
        deny.Content = JsonContent.Create(new { requestId = reqId });
        var body = await SendJsonAsync(deny);

        var q = HttpUtility.ParseQueryString(new Uri(body.GetProperty("redirect").GetString()!).Query);
        Assert.Equal("access_denied", q["error"]);
        Assert.Equal("d", q["state"]);
        Assert.Equal("denied", (await SendJsonAsync(Get($"/oauth/requests/{reqId}"))).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Register_RedirectNotOnAllowlist_Rejected()
    {
        var req = Get("/oauth/register");
        req.Method = HttpMethod.Post;
        req.Content = JsonContent.Create(new { client_name = "Phish", redirect_uris = new[] { "https://evil.example/cb" } });

        var resp = await _http.SendAsync(req, Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/oauth/register unavailable");
        await AssertOAuthErrorAsync(resp, "invalid_redirect_uri");
    }

    [Fact]
    public async Task Metadata_AdvertisesCimdDcrS256AndIss()
    {
        var resp = await _http.SendAsync(Get("/.well-known/oauth-authorization-server"), Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "AS metadata unavailable");
        var m = await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);

        Assert.Equal("https://textstack.app", m.GetProperty("issuer").GetString());
        Assert.Equal("https://textstack.app/oauth/token", m.GetProperty("token_endpoint").GetString());
        Assert.Equal("https://textstack.app/oauth/register", m.GetProperty("registration_endpoint").GetString());
        Assert.Equal(["S256"], m.GetProperty("code_challenge_methods_supported").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("none", m.GetProperty("token_endpoint_auth_methods_supported").EnumerateArray().Select(e => e.GetString()));
        Assert.True(m.GetProperty("client_id_metadata_document_supported").GetBoolean());
        Assert.True(m.GetProperty("authorization_response_iss_parameter_supported").GetBoolean());
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private HttpRequestMessage Get(string path, string? bearer = null)
    {
        var req = _fixture.CreateRequest(HttpMethod.Get, path);
        if (bearer is not null) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearer}");
        return req;
    }

    private static HttpRequestMessage Mobile(HttpRequestMessage req, HttpMethod method)
    {
        req.Method = method;
        req.Headers.Add("X-Client", "mobile");
        return req;
    }

    private async Task<JsonElement> SendJsonAsync(HttpRequestMessage req)
    {
        var resp = await _http.SendAsync(req, Ct);
        Assert.True(resp.IsSuccessStatusCode, $"{req.Method} {req.RequestUri} → {(int)resp.StatusCode} {await resp.Content.ReadAsStringAsync(Ct)}");
        return await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private Task<HttpResponseMessage> PostFormAsync(string path, Dictionary<string, string> form)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, path);
        req.Content = new FormUrlEncodedContent(form);
        return _http.SendAsync(req, Ct);
    }

    private static async Task AssertOAuthErrorAsync(HttpResponseMessage resp, string error)
    {
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        Assert.Equal(error, (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("error").GetString());
    }

    private static string NewVerifier() => System.Buffers.Text.Base64Url.EncodeToString(RandomNumberGenerator.GetBytes(48));

    private static string Challenge(string verifier) =>
        System.Buffers.Text.Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    private async Task<string> RegisterAsync()
    {
        var req = Get("/oauth/register");
        req.Method = HttpMethod.Post;
        req.Content = JsonContent.Create(new { client_name = "Integration Claude", redirect_uris = new[] { Redirect } });
        var resp = await _http.SendAsync(req, Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/oauth/register unavailable");
        Assert.Equal(HttpStatusCode.Created, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("none", body.GetProperty("token_endpoint_auth_method").GetString());
        return body.GetProperty("client_id").GetString()!;
    }

    private static string AuthorizeUrl(string clientId, string verifier, string state,
        string redirect = Redirect, string resource = Resource) =>
        $"/oauth/authorize?response_type=code&client_id={Uri.EscapeDataString(clientId)}"
        + $"&redirect_uri={Uri.EscapeDataString(redirect)}&code_challenge={Challenge(verifier)}"
        + $"&code_challenge_method=S256&state={state}&scope={Uri.EscapeDataString("library offline_access")}"
        + $"&resource={Uri.EscapeDataString(resource)}";

    private async Task<Guid> AuthorizeAsync(string clientId, string verifier, string state)
    {
        var resp = await _http.SendAsync(Get(AuthorizeUrl(clientId, verifier, state)), Ct);
        Assert.Equal(HttpStatusCode.Redirect, resp.StatusCode);
        var location = resp.Headers.Location!;
        Assert.Equal("https://textstack.app/en/oauth/consent", location.GetLeftPart(UriPartial.Path));
        return Guid.Parse(HttpUtility.ParseQueryString(location.Query)["req"]!);
    }

    private async Task<string> ApproveAsync(Guid reqId, string bearer)
    {
        var req = Get("/oauth/authorize/approve", bearer);
        req.Method = HttpMethod.Post;
        req.Content = JsonContent.Create(new { requestId = reqId });
        return (await SendJsonAsync(req)).GetProperty("redirect").GetString()!;
    }

    private Task<HttpResponseMessage> RedeemAsync(string clientId, string code, string verifier) =>
        PostFormAsync("/oauth/token", new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = Redirect,
            ["client_id"] = clientId,
            ["code_verifier"] = verifier,
        });

    private Task<HttpResponseMessage> RefreshAsync(string refresh, string clientId) =>
        PostFormAsync("/oauth/token", new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refresh,
            ["client_id"] = clientId,
            ["resource"] = Resource,
        });

    private async Task<(string Access, string Refresh, string ClientId)> FullGrantAsync(string owner)
    {
        var clientId = await RegisterAsync();
        var verifier = NewVerifier();
        var code = HttpUtility.ParseQueryString(new Uri(
            await ApproveAsync(await AuthorizeAsync(clientId, verifier, "f"), owner)).Query)["code"]!;
        var tokens = await (await RedeemAsync(clientId, code, verifier)).Content.ReadFromJsonAsync<JsonElement>(Ct);
        return (tokens.GetProperty("access_token").GetString()!, tokens.GetProperty("refresh_token").GetString()!, clientId);
    }

    private async Task<HttpStatusCode> TokenStatusAsync(string bearer) =>
        (await _http.SendAsync(Get("/oauth/token-status", bearer), Ct)).StatusCode;

    private async Task<JsonElement> ListGrantsAsync(string bearer) =>
        (await SendJsonAsync(Get("/me/oauth/grants", bearer))).GetProperty("items");

    /// <summary>A fresh account per test. <c>X-Client: mobile</c> so the token comes back in the body.</summary>
    private async Task<string?> SignUpAsync()
    {
        var req = Mobile(Get("/auth/register"), HttpMethod.Post);
        req.Content = JsonContent.Create(new
        {
            email = $"oauth-{Guid.NewGuid():N}@textstack.test",
            password = "correct-horse-battery",
            name = "OAuth Probe",
        });
        var resp = await _http.SendAsync(req, Ct);
        if (IntegrationSkip.Unavailable(resp) || !resp.IsSuccessStatusCode) return null;
        return (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("accessToken").GetString();
    }
}
