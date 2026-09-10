using System.Net;
using System.Text;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-050b — the async <see cref="IMcpTokenProvider"/> contract and how the
/// catalog renders each <see cref="TokenResult"/> for a user-scoped tool:
///   • StaticEnvTokenProvider: token → Authorized, blank/null → Failed;
///   • Authorized → Bearer attached, request proceeds;
///   • Pending → actionable IsError carrying the verification URL + code (no HTTP);
///   • Failed → IsError carrying the reason (no HTTP).
///
/// Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
/// </summary>
public class McpTokenProviderTests
{
    private const string SiteHost = "textstack.test";
    private const string Edition = "33333333-3333-3333-3333-333333333333";

    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            LastRequest = request;
            return Task.FromResult(response);
        }
    }

    private sealed class FakeProvider(TokenResult result) : IMcpTokenProvider
    {
        public Task<TokenResult> GetTokenAsync(CancellationToken ct) => Task.FromResult(result);
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static (McpToolCatalog catalog, CapturingHandler handler) BuildCatalog(
        IMcpTokenProvider provider, HttpResponseMessage response)
    {
        var handler = new CapturingHandler(response);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = SiteHost };
        var api = new TextStackApiClient(http, options, provider);
        return (new McpToolCatalog(api), handler);
    }

    private static System.Text.Json.JsonElement Args(string json) =>
        System.Text.Json.JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult result) => ((TextContentBlock)result.Content[0]).Text;

    // ── StaticEnvTokenProvider async contract ────────────────────────────────────

    [Fact]
    public async Task StaticEnvTokenProvider_WithToken_ReturnsAuthorized()
    {
        var provider = new StaticEnvTokenProvider(
            new McpBridgeOptions { ApiBaseUrl = "x", SiteHost = "y", McpToken = "tok-123" });

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal("tok-123", Assert.IsType<TokenResult.Authorized>(result).AccessToken);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task StaticEnvTokenProvider_NoToken_ReturnsFailed(string? token)
    {
        var provider = new StaticEnvTokenProvider(
            new McpBridgeOptions { ApiBaseUrl = "x", SiteHost = "y", McpToken = token });

        var result = await provider.GetTokenAsync(CancellationToken.None);

        var failed = Assert.IsType<TokenResult.Failed>(result);
        Assert.Contains("TEXTSTACK_MCP_TOKEN", failed.Message);
    }

    // ── Authorized → Bearer attached, request proceeds ───────────────────────────

    [Fact]
    public async Task UserScopedTool_AuthorizedProvider_AttachesBearer_AndProceeds()
    {
        var (catalog, handler) = BuildCatalog(
            new FakeProvider(new TokenResult.Authorized("abc")), Json("[]"));

        var result = await catalog.CallAsync(
            "list_my_highlights", Args($$"""{"editionId":"{{Edition}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        Assert.Equal("Bearer abc", handler.LastRequest!.Headers.Authorization?.ToString());
    }

    // ── Pending → actionable IsError, no HTTP ────────────────────────────────────

    [Fact]
    public async Task UserScopedTool_PendingProvider_RendersVerificationUrlAndCode_NoHttp()
    {
        var (catalog, handler) = BuildCatalog(
            new FakeProvider(new TokenResult.Pending("https://textstack.app/device", "WDJB-MQXR")),
            Json("[]"));

        var result = await catalog.CallAsync(
            "list_my_vocabulary", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
        var text = TextOf(result);
        Assert.Contains("authentication required", text);
        Assert.Contains("https://textstack.app/device", text);
        Assert.Contains("WDJB-MQXR", text);
        Assert.Null(handler.LastRequest); // never issued the HTTP call
    }

    // ── Failed → IsError carrying the reason, no HTTP ────────────────────────────

    [Fact]
    public async Task UserScopedTool_FailedProvider_RendersReason_NoHttp()
    {
        var (catalog, handler) = BuildCatalog(
            new FakeProvider(new TokenResult.Failed("no TEXTSTACK_MCP_TOKEN configured")),
            Json("[]"));

        var result = await catalog.CallAsync(
            "list_my_highlights",
            Args($$"""{"editionId":"{{Edition}}"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        var text = TextOf(result);
        Assert.Contains("authentication required", text);
        Assert.Contains("no TEXTSTACK_MCP_TOKEN configured", text);
        Assert.Null(handler.LastRequest);
    }
}
