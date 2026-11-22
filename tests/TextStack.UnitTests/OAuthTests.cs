using System.Net;
using System.Security.Cryptography;
using System.Text;
using Api.Services;
using Application.Identity;

namespace TextStack.UnitTests;

/// <summary>
/// The security-relevant pure logic of the MCP OAuth server (ADR-017): PKCE, redirect rules, token
/// shape, and the CIMD fetch guard. The DB-backed parts (code single-use, refresh rotation and
/// reuse, revocation, audience) are covered end to end in <c>OAuthFlowTests</c> (integration).
/// </summary>
public class OAuthTests
{
    private static readonly string[] Hosts = ["claude.ai", "chatgpt.com"];
    private const string Url = "https://client.example/metadata.json";

    private static string ChallengeFor(string verifier) =>
        System.Buffers.Text.Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    // ── PKCE ────────────────────────────────────────────────────────────────────

    public static TheoryData<string?, string, bool> PkceExchanges => new()
    {
        // The verifier behind the challenge, with every unreserved punctuation char.
        { new string('a', 43) + "-._~", ChallengeFor(new string('a', 43) + "-._~"), true },
        // The worked example from RFC 7636 Appendix B.
        { "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", true },
        // Someone else's verifier.
        { new string('b', 50), ChallengeFor(new string('a', 50)), false },
        // "plain" PKCE (challenge == verifier) must not pass an S256 check.
        { new string('a', 43), new string('a', 43), false },
        // Malformed verifiers: absent, under 43, illegal char, over 128 (even with its own challenge).
        { null, ChallengeFor(new string('a', 43)), false },
        { "short", ChallengeFor(new string('a', 43)), false },
        { "has space                                     x", ChallengeFor(new string('a', 43)), false },
        { new string('a', 129), ChallengeFor(new string('a', 129)), false },
    };

    [Theory]
    [MemberData(nameof(PkceExchanges))]
    public void VerifyPkce_CodeExchange_OnlyTheS256VerifierBehindTheChallengePasses(string? verifier, string challenge, bool expected) =>
        Assert.Equal(expected, OAuth.VerifyPkce(verifier, challenge));

    [Theory]
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", true)]
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c", false)]  // 42
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM", false)] // '+' is not base64url
    [InlineData(null, false)]
    public void IsValidCodeChallenge_AuthorizeRequest_OnlyA43CharBase64UrlHash(string? challenge, bool expected) =>
        Assert.Equal(expected, OAuth.IsValidCodeChallenge(challenge));

    // ── redirects ───────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("https://claude.ai/api/mcp/auth_callback", true)]
    [InlineData("https://chatgpt.com/connector_platform_oauth_redirect", true)]
    [InlineData("https://CLAUDE.AI/api/mcp/auth_callback", true)]
    [InlineData("http://claude.ai/api/mcp/auth_callback", false)]        // not https
    [InlineData("https://evil.claude.ai/cb", false)]                    // no subdomains
    [InlineData("https://claude.ai.evil.com/cb", false)]
    [InlineData("https://claude.ai:8443/cb", false)]                    // non-default port
    [InlineData("https://claude.ai/cb#frag", false)]
    [InlineData("https://user@claude.ai/cb", false)]
    [InlineData("http://localhost:33418/callback", true)]               // Claude Code
    [InlineData("http://127.0.0.1:5000/callback", true)]
    [InlineData("http://[::1]:5000/callback", true)]
    [InlineData("custom-scheme://cb", false)]
    [InlineData("not a url", false)]
    [InlineData(null, false)]
    public void IsAllowedRedirect_ClientRegistersRedirect_OnlyAllowlistedHttpsHostOrLoopback(string? uri, bool expected) =>
        Assert.Equal(expected, OAuth.IsAllowedRedirect(uri, Hosts));

    [Theory]
    [InlineData("https://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback", true)]
    [InlineData("https://claude.ai/api/mcp/auth_callback/", "https://claude.ai/api/mcp/auth_callback", false)] // trailing slash is a different URI
    [InlineData("https://claude.ai/api/mcp/other", "https://claude.ai/api/mcp/auth_callback", false)]
    [InlineData("http://localhost:61234/callback", "http://localhost:3000/callback", true)]   // native client picks a free port
    [InlineData("http://localhost:61234/other", "http://localhost:3000/callback", false)]     // path must still match
    [InlineData("http://127.0.0.1:61234/callback", "http://localhost:3000/callback", false)]  // host must still match
    [InlineData("https://localhost:61234/callback", "http://localhost:3000/callback", false)] // scheme must still match
    public void RedirectMatches_AuthorizeRequest_ExactRegisteredUriOrLoopbackOnAnyPort(string requested, string registered, bool expected) =>
        Assert.Equal(expected, OAuth.RedirectMatches(requested, [registered]));

    [Fact]
    public void AppendQuery_CodeSentBackToClient_EscapedAfterExistingQueryNullsSkipped() =>
        Assert.Equal(
            "https://x.test/cb?a=1&code=c%2Bd&state=s%20t",
            OAuth.AppendQuery("https://x.test/cb?a=1", ("code", "c+d"), ("state", "s t"), ("iss", null)));

    // ── scope / resource / tokens ───────────────────────────────────────────────

    [Fact]
    public void GrantedScope_TokenRequest_AlwaysLibraryOfflineAccessEchoed()
    {
        // One permission: anything else asked for is dropped, offline_access is echoed.
        Assert.Equal("library", OAuth.GrantedScope(null));
        Assert.Equal("library", OAuth.GrantedScope("openid read write"));
        Assert.Equal("library offline_access", OAuth.GrantedScope("library offline_access"));
        Assert.Equal("library offline_access", OAuth.GrantedScope("offline_access"));
    }

    // RFC 8707: absent = the only resource; a trailing slash is tolerated; nothing else is.
    [Theory]
    [InlineData(null, true)]
    [InlineData("https://textstack.app/mcp", true)]
    [InlineData("https://textstack.app/mcp/", true)]
    [InlineData("https://textstack.app/api", false)]
    [InlineData("https://evil.example/mcp", false)]
    public void ResourceMatches_TokenRequestNamesResource_OnlyTheMcpEndpoint(string? requested, bool expected) =>
        Assert.Equal(expected, OAuth.ResourceMatches(requested, "https://textstack.app/mcp"));

    [Fact]
    public void NewToken_AccessTokenIssued_UniquePrefixedLivingAnHour()
    {
        var a = OAuth.NewToken(OAuth.AccessTokenPrefix);
        var b = OAuth.NewToken(OAuth.AccessTokenPrefix);

        Assert.Equal(4 + 43, a.Length);
        Assert.Matches("^tso_[A-Za-z0-9_-]{43}$", a);
        Assert.NotEqual(a, b);
        Assert.NotEqual(DeviceCodes.HashToken(a), DeviceCodes.HashToken(b));

        Assert.True(OAuth.LooksLikeAccessToken(a));

        // Owner decision.
        Assert.Equal(TimeSpan.FromHours(1), OAuth.AccessTokenLifetime);
        Assert.Equal(TimeSpan.FromDays(90), OAuth.RefreshTokenLifetime);
    }

    // The middleware recognises a bearer by prefix alone, before any DB work.
    [Theory]
    [InlineData("tso_abc", true)]
    [InlineData("tsk_abc", false)]
    [InlineData("tsr_abc", false)]  // a refresh token is never a bearer
    [InlineData("eyJhbGciOi.x.y", false)]
    [InlineData(null, false)]
    public void LooksLikeAccessToken_BearerPresented_OnlyTheAccessTokenPrefix(string? token, bool expected) =>
        Assert.Equal(expected, OAuth.LooksLikeAccessToken(token));

    // ── CIMD SSRF guard ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("127.0.0.1", false)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.20.0.5", false)]
    [InlineData("192.168.1.1", false)]
    [InlineData("169.254.169.254", false)] // cloud metadata
    [InlineData("100.64.0.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData("224.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("::ffff:127.0.0.1", false)] // v4-mapped loopback
    [InlineData("::ffff:10.0.0.1", false)]
    [InlineData("1.1.1.1", true)]
    [InlineData("160.79.104.10", true)]
    [InlineData("2606:4700:4700::1111", true)]
    public void IsPublicAddress_MetadataHostResolves_PrivateOrSpecialRefused(string ip, bool expected) =>
        Assert.Equal(expected, ClientMetadataFetcher.IsPublicAddress(IPAddress.Parse(ip)));

    public static TheoryData<string, string?> MetadataUrls => new()
    {
        { "https://claude.ai/oauth/mcp-oauth-client-metadata", null },
        { "http://example.com/client.json", "must be https" },
        { "https://example.com", "must have a path" },
        { "https://example.com/", "must have a path" },
        { "https://example.com:8443/client.json", "default port" },
        { "https://127.0.0.1/client.json", "not public" },
        { "https://[::1]/client.json", "not public" },
        { "https://169.254.169.254/latest/meta-data", "not public" },
        { "https://u:p@example.com/client.json", "userinfo" },
        { "https://example.com/client.json#frag", "a fragment" },
        { "not a url", "not a URL" },
        { "https://example.com/" + new string('a', 600), "too long" },
    };

    [Theory]
    [MemberData(nameof(MetadataUrls))]
    public void ValidateUrl_StrangerChosenClientId_UnsafeUrlRefusedWithReason(string url, string? reason)
    {
        var error = ClientMetadataFetcher.ValidateUrl(url);
        if (reason is null) Assert.Null(error);
        else Assert.Contains(reason, error);
    }

    [Theory]
    [InlineData($$"""{"client_id":"{{Url}}","client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none"}""",
        Url, "Claude", "https://claude.ai/api/mcp/auth_callback", null)]
    // Shape of https://chatgpt.com/oauth/client.json (2026-09-30). Refusing it blocked every
    // ChatGPT connection: "none" is in its supported list, and it is all we advertise.
    [InlineData("""{"client_id":"https://chatgpt.com/oauth/client.json","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"client_name":"ChatGPT","jwks_uri":"https://chatgpt.com/oauth/jwks.json"}""",
        "https://chatgpt.com/oauth/client.json", "ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect", null)]
    [InlineData($$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"]}""",
        Url, "client.example", "https://claude.ai/cb", null)] // no name: the host stands in
    [InlineData("""{"client_id":"https://other.example/x","redirect_uris":["https://claude.ai/cb"]}""",
        Url, null, null, "does not match its URL")]
    [InlineData($$"""{"client_id":"{{Url}}"}""", Url, null, null, "no redirect_uris")]
    [InlineData($$"""{"client_id":"{{Url}}","redirect_uris":[]}""", Url, null, null, "no redirect_uris")]
    [InlineData($$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"],"token_endpoint_auth_method":"client_secret_basic"}""",
        Url, null, null, "only public clients")]
    [InlineData($$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["private_key_jwt"]}""",
        Url, null, null, "only public clients")] // confidential only
    [InlineData("""[1,2]""", Url, null, null, "not an object")]
    public void Parse_ClientMetadataDocument_PublicClientAcceptedElseRefusedWithReason(
        string json, string clientId, string? name, string? redirect, string? reason)
    {
        var (doc, error) = ClientMetadataFetcher.Parse(clientId, Encoding.UTF8.GetBytes(json));

        if (reason is null)
        {
            Assert.Null(error);
            Assert.Equal(name, doc!.ClientName);
            Assert.Equal([redirect!], doc.RedirectUris);
        }
        else
        {
            Assert.Null(doc);
            Assert.Contains(reason, error);
        }
    }

    [Fact]
    public async Task FetchAsync_StrangerHostedMetadata_NoRedirectNoProxyCappedBody()
    {
        var ct = TestContext.Current.CancellationToken;
        var valid = $$"""{"client_id":"{{Url}}","client_name":"ChatGPT","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}""";
        var oversized = $$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"],"pad":"{{new string('x', 20_000)}}"}""";
        StubHandler stub = null!;
        Task<(ClientMetadataFetcher.Document? Doc, string? Error)> Fetch(HttpStatusCode status, string body, bool sendLength = true) =>
            new ClientMetadataFetcher(new HttpClient(stub = new StubHandler(status, body, sendLength))).FetchAsync(Url, ct);

        using (var handler = ClientMetadataFetcher.CreateHandler())
        {
            Assert.False(handler.AllowAutoRedirect);
            Assert.False(handler.UseProxy);
            Assert.NotNull(handler.ConnectCallback); // the per-connect public-address check
        }

        var (doc, error) = await Fetch(HttpStatusCode.OK, valid);
        Assert.Null(error);
        Assert.Equal("ChatGPT", doc!.ClientName);

        // A 302 pointing at the metadata endpoint is refused, not followed.
        (doc, error) = await Fetch(HttpStatusCode.Found, "");
        Assert.Null(doc);
        Assert.Contains("302", error);
        Assert.Equal(1, stub.Requests);

        // Too large whether the server announces it or streams it without a length.
        (doc, error) = await Fetch(HttpStatusCode.OK, oversized);
        Assert.Null(doc);
        Assert.Contains("too large", error);
        (doc, error) = await Fetch(HttpStatusCode.OK, oversized, sendLength: false);
        Assert.Null(doc);
        Assert.Contains("too large", error);

        // A broken body is the client's problem, reported back, never thrown.
        (doc, error) = await Fetch(HttpStatusCode.OK, "not json");
        Assert.Null(doc);
        Assert.Contains("could not be fetched", error);
    }

    private sealed class StubHandler(HttpStatusCode status, string body, bool sendLength = true) : HttpMessageHandler
    {
        public int Requests { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests++;
            HttpContent content = sendLength
                ? new StringContent(body, Encoding.UTF8, "application/json")
                : new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(body))); // no Content-Length hint
            if (!sendLength) content.Headers.ContentLength = null;
            var response = new HttpResponseMessage(status) { Content = content };
            if (status == HttpStatusCode.Found) response.Headers.Location = new Uri("http://169.254.169.254/latest/meta-data");
            return Task.FromResult(response);
        }
    }
}
