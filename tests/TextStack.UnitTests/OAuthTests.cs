using System.Net;
using System.Security.Cryptography;
using System.Text;
using Api.Services;
using Application.Auth;

namespace TextStack.UnitTests;

/// <summary>
/// The security-relevant pure logic of the MCP OAuth server (ADR-017): PKCE, redirect rules, token
/// shape, and the CIMD fetch guard. The DB-backed parts (code single-use, refresh rotation and
/// reuse, revocation, audience) are covered end to end in <c>OAuthFlowTests</c> (integration).
/// </summary>
public class OAuthTests
{
    private static readonly string[] Hosts = ["claude.ai", "chatgpt.com"];

    private static string ChallengeFor(string verifier) =>
        System.Buffers.Text.Base64Url.EncodeToString(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    // ── PKCE ────────────────────────────────────────────────────────────────────

    [Fact]
    public void VerifyPkce_MatchingVerifier_True()
    {
        var verifier = new string('a', 43) + "-._~";
        Assert.True(OAuth.VerifyPkce(verifier, ChallengeFor(verifier)));
    }

    [Fact]
    public void VerifyPkce_Rfc7636AppendixB_True()
    {
        // The worked example from RFC 7636 Appendix B.
        Assert.True(OAuth.VerifyPkce(
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    }

    [Fact]
    public void VerifyPkce_WrongVerifier_False()
    {
        var verifier = new string('a', 50);
        Assert.False(OAuth.VerifyPkce(new string('b', 50), ChallengeFor(verifier)));
    }

    [Fact]
    public void VerifyPkce_PlainMethodChallengeEqualsVerifier_False()
    {
        // "plain" PKCE (challenge == verifier) must not pass an S256 check.
        var verifier = new string('a', 43);
        Assert.False(OAuth.VerifyPkce(verifier, verifier));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("short")]                                   // < 43
    [InlineData("has space                                     x")] // illegal char
    public void VerifyPkce_MalformedVerifier_False(string? verifier) =>
        Assert.False(OAuth.VerifyPkce(verifier, ChallengeFor(new string('a', 43))));

    [Fact]
    public void VerifyPkce_TooLongVerifier_False()
    {
        var verifier = new string('a', 129);
        Assert.False(OAuth.VerifyPkce(verifier, ChallengeFor(verifier)));
    }

    [Theory]
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", true)]
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-c", false)]  // 42
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw+cM", false)] // '+' is not base64url
    [InlineData(null, false)]
    public void IsValidCodeChallenge_Shape(string? challenge, bool expected) =>
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
    public void IsAllowedRedirect_Allowlist(string? uri, bool expected) =>
        Assert.Equal(expected, OAuth.IsAllowedRedirect(uri, Hosts));

    [Fact]
    public void RedirectMatches_ExactString_True() =>
        Assert.True(OAuth.RedirectMatches("https://claude.ai/api/mcp/auth_callback", ["https://claude.ai/api/mcp/auth_callback"]));

    [Theory]
    [InlineData("https://claude.ai/api/mcp/auth_callback/")]  // trailing slash is a different URI
    [InlineData("https://claude.ai/api/mcp/other")]
    public void RedirectMatches_AnyDifference_False(string requested) =>
        Assert.False(OAuth.RedirectMatches(requested, ["https://claude.ai/api/mcp/auth_callback"]));

    [Fact]
    public void RedirectMatches_LoopbackDifferentPort_True() =>
        Assert.True(OAuth.RedirectMatches("http://localhost:61234/callback", ["http://localhost:3000/callback"]));

    [Theory]
    [InlineData("http://localhost:61234/other")]    // path must still match
    [InlineData("http://127.0.0.1:61234/callback")] // host must still match
    [InlineData("https://localhost:61234/callback")] // scheme must still match
    public void RedirectMatches_LoopbackOtherDifference_False(string requested) =>
        Assert.False(OAuth.RedirectMatches(requested, ["http://localhost:3000/callback"]));

    [Fact]
    public void AppendQuery_ExistingQuery_UsesAmpersandAndEscapes() =>
        Assert.Equal(
            "https://x.test/cb?a=1&code=c%2Bd&state=s%20t",
            OAuth.AppendQuery("https://x.test/cb?a=1", ("code", "c+d"), ("state", "s t"), ("iss", null)));

    // ── scope / resource ────────────────────────────────────────────────────────

    [Theory]
    [InlineData(null, "library")]
    [InlineData("openid read write", "library")]
    [InlineData("library offline_access", "library offline_access")]
    [InlineData("offline_access", "library offline_access")]
    public void GrantedScope_AlwaysLibrary_EchoesOfflineAccess(string? requested, string expected) =>
        Assert.Equal(expected, OAuth.GrantedScope(requested));

    [Theory]
    [InlineData(null, true)]
    [InlineData("https://textstack.app/mcp", true)]
    [InlineData("https://textstack.app/mcp/", true)]
    [InlineData("https://textstack.app/api", false)]
    [InlineData("https://evil.example/mcp", false)]
    public void ResourceMatches_OnlyTheMcpEndpoint(string? requested, bool expected) =>
        Assert.Equal(expected, OAuth.ResourceMatches(requested, "https://textstack.app/mcp"));

    // ── tokens ──────────────────────────────────────────────────────────────────

    [Fact]
    public void NewToken_Prefixed_43CharBase64Url_Unique()
    {
        var a = OAuth.NewToken(OAuth.AccessTokenPrefix);
        var b = OAuth.NewToken(OAuth.AccessTokenPrefix);

        Assert.StartsWith("tso_", a);
        Assert.Equal(4 + 43, a.Length);
        Assert.Matches("^tso_[A-Za-z0-9_-]{43}$", a);
        Assert.NotEqual(a, b);
        Assert.NotEqual(DeviceCodes.HashToken(a), DeviceCodes.HashToken(b));
    }

    [Theory]
    [InlineData("tso_abc", true)]
    [InlineData("tsk_abc", false)]
    [InlineData("tsr_abc", false)]  // a refresh token is never a bearer
    [InlineData("eyJhbGciOi.x.y", false)]
    [InlineData(null, false)]
    public void LooksLikeAccessToken_PrefixOnly(string? token, bool expected) =>
        Assert.Equal(expected, OAuth.LooksLikeAccessToken(token));

    private static readonly DateTimeOffset Now = new(2026, 9, 29, 12, 0, 0, TimeSpan.Zero);

    private static Domain.Entities.OAuthGrant Grant(
        string resource = "https://textstack.app/mcp", DateTimeOffset? expires = null, DateTimeOffset? revoked = null) => new()
        {
            AccessTokenHash = "h",
            Resource = resource,
            AccessTokenExpiresAt = expires ?? Now.AddMinutes(30),
            RevokedAt = revoked,
        };

    private static bool Live(Domain.Entities.OAuthGrant g, string hash = "h") =>
        OAuth.LiveAccessToken(hash, "https://textstack.app/mcp", Now).Compile()(g);

    [Fact]
    public void LiveAccessToken_FreshGrantForMcp_True() => Assert.True(Live(Grant()));

    [Fact]
    public void LiveAccessToken_OtherAudience_False() =>
        Assert.False(Live(Grant(resource: "https://textstack.app/other")));

    [Fact]
    public void LiveAccessToken_Expired_False() => Assert.False(Live(Grant(expires: Now)));

    [Fact]
    public void LiveAccessToken_Revoked_False() => Assert.False(Live(Grant(revoked: Now.AddMinutes(-1))));

    [Fact]
    public void LiveAccessToken_OtherHash_False() => Assert.False(Live(Grant(), hash: "x"));

    [Fact]
    public void Lifetimes_MatchOwnerDecision()
    {
        Assert.Equal(TimeSpan.FromHours(1), OAuth.AccessTokenLifetime);
        Assert.Equal(TimeSpan.FromDays(90), OAuth.RefreshTokenLifetime);
    }

    // ── CIMD SSRF guard ─────────────────────────────────────────────────────────

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.1.2.3")]
    [InlineData("172.20.0.5")]
    [InlineData("192.168.1.1")]
    [InlineData("169.254.169.254")] // cloud metadata
    [InlineData("100.64.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("224.0.0.1")]
    [InlineData("::1")]
    [InlineData("fe80::1")]
    [InlineData("fd00::1")]
    [InlineData("::ffff:127.0.0.1")] // v4-mapped loopback
    [InlineData("::ffff:10.0.0.1")]
    public void IsPublicAddress_PrivateOrSpecial_False(string ip) =>
        Assert.False(ClientMetadataFetcher.IsPublicAddress(IPAddress.Parse(ip)));

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("160.79.104.10")]
    [InlineData("2606:4700:4700::1111")]
    public void IsPublicAddress_Public_True(string ip) =>
        Assert.True(ClientMetadataFetcher.IsPublicAddress(IPAddress.Parse(ip)));

    [Theory]
    [InlineData("http://example.com/client.json")]      // not https
    [InlineData("https://example.com")]                  // no path
    [InlineData("https://example.com/")]
    [InlineData("https://example.com:8443/client.json")] // non-default port
    [InlineData("https://127.0.0.1/client.json")]        // literal private IP
    [InlineData("https://[::1]/client.json")]
    [InlineData("https://169.254.169.254/latest/meta-data")]
    [InlineData("https://u:p@example.com/client.json")]
    public void ValidateUrl_Unsafe_Refused(string url) =>
        Assert.NotNull(ClientMetadataFetcher.ValidateUrl(url));

    [Fact]
    public void ValidateUrl_TooLong_Refused() =>
        Assert.NotNull(ClientMetadataFetcher.ValidateUrl("https://example.com/" + new string('a', 600)));

    [Fact]
    public void ValidateUrl_PlainHttpsPath_Accepted() =>
        Assert.Null(ClientMetadataFetcher.ValidateUrl("https://claude.ai/oauth/mcp-oauth-client-metadata"));

    private const string Url = "https://client.example/metadata.json";

    [Fact]
    public void Parse_ValidDocument_ReturnsNameAndRedirects()
    {
        var (doc, error) = ClientMetadataFetcher.Parse(Url, Encoding.UTF8.GetBytes(
            $$"""{"client_id":"{{Url}}","client_name":"Claude","redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"token_endpoint_auth_method":"none"}"""));

        Assert.Null(error);
        Assert.Equal("Claude", doc!.ClientName);
        Assert.Equal(["https://claude.ai/api/mcp/auth_callback"], doc.RedirectUris);
    }

    [Theory]
    [InlineData("""{"client_id":"https://other.example/x","redirect_uris":["https://claude.ai/cb"]}""")] // id != URL
    [InlineData("""{"client_id":"https://client.example/metadata.json"}""")]                          // no redirects
    [InlineData("""{"client_id":"https://client.example/metadata.json","redirect_uris":[]}""")]
    [InlineData("""{"client_id":"https://client.example/metadata.json","redirect_uris":["https://claude.ai/cb"],"token_endpoint_auth_method":"client_secret_basic"}""")]
    [InlineData("""[1,2]""")]
    public void Parse_BadDocument_Error(string json)
    {
        var (doc, error) = ClientMetadataFetcher.Parse(Url, Encoding.UTF8.GetBytes(json));
        Assert.Null(doc);
        Assert.NotNull(error);
    }

    [Fact]
    public void Parse_ChatGptDocument_DeclaresPrivateKeyJwtButSupportsNone_Accepted()
    {
        // Shape of https://chatgpt.com/oauth/client.json (2026-09-30). Refusing it blocked every
        // ChatGPT connection: "none" is in its supported list, and it is all we advertise.
        const string chatgpt = "https://chatgpt.com/oauth/client.json";
        var (doc, error) = ClientMetadataFetcher.Parse(chatgpt, Encoding.UTF8.GetBytes(
            $$"""{"client_id":"{{chatgpt}}","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["none","private_key_jwt"],"client_name":"ChatGPT","jwks_uri":"https://chatgpt.com/oauth/jwks.json"}"""));

        Assert.Null(error);
        Assert.Equal("ChatGPT", doc!.ClientName);
        Assert.Equal(["https://chatgpt.com/connector_platform_oauth_redirect"], doc.RedirectUris);
    }

    [Fact]
    public void Parse_ConfidentialOnlyDocument_Refused()
    {
        var (doc, error) = ClientMetadataFetcher.Parse(Url, Encoding.UTF8.GetBytes(
            $$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"],"token_endpoint_auth_method":"private_key_jwt","token_endpoint_auth_methods_supported":["private_key_jwt"]}"""));
        Assert.Null(doc);
        Assert.NotNull(error);
    }

    [Fact]
    public void Parse_NoName_FallsBackToHost()
    {
        var (doc, _) = ClientMetadataFetcher.Parse(Url, Encoding.UTF8.GetBytes(
            $$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"]}"""));
        Assert.Equal("client.example", doc!.ClientName);
    }

    [Fact]
    public async Task FetchAsync_OversizedBody_Refused()
    {
        var body = $$"""{"client_id":"{{Url}}","redirect_uris":["https://claude.ai/cb"],"pad":"{{new string('x', 20_000)}}"}""";
        var fetcher = new ClientMetadataFetcher(new HttpClient(new StubHandler(HttpStatusCode.OK, body, sendLength: false)));

        var (doc, error) = await fetcher.FetchAsync(Url, TestContext.Current.CancellationToken);

        Assert.Null(doc);
        Assert.Contains("too large", error);
    }

    [Fact]
    public async Task FetchAsync_Redirect_Refused()
    {
        var fetcher = new ClientMetadataFetcher(new HttpClient(new StubHandler(HttpStatusCode.Found, "")));

        var (doc, error) = await fetcher.FetchAsync(Url, TestContext.Current.CancellationToken);

        Assert.Null(doc);
        Assert.Contains("302", error);
    }

    [Fact]
    public async Task FetchAsync_ValidDocument_Parsed()
    {
        var body = $$"""{"client_id":"{{Url}}","client_name":"ChatGPT","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"]}""";
        var fetcher = new ClientMetadataFetcher(new HttpClient(new StubHandler(HttpStatusCode.OK, body)));

        var (doc, error) = await fetcher.FetchAsync(Url, TestContext.Current.CancellationToken);

        Assert.Null(error);
        Assert.Equal("ChatGPT", doc!.ClientName);
    }

    [Fact]
    public void CreateHandler_NoRedirectsNoProxy()
    {
        using var handler = ClientMetadataFetcher.CreateHandler();
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseProxy);
        Assert.NotNull(handler.ConnectCallback);
    }

    private sealed class StubHandler(HttpStatusCode status, string body, bool sendLength = true) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            HttpContent content = sendLength
                ? new StringContent(body, Encoding.UTF8, "application/json")
                : new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(body))); // no Content-Length hint
            if (!sendLength) content.Headers.ContentLength = null;
            return Task.FromResult(new HttpResponseMessage(status) { Content = content });
        }
    }
}
