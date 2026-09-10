using System.Net;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-049 regression: the bridge dropped the API PATH PREFIX (e.g. <c>/api</c>) when
/// <c>TEXTSTACK_API_URL</c> carried one. Relative request URLs were built with a
/// LEADING slash (<c>/search</c>, <c>/me/highlights/{id}</c>, ...) and
/// <see cref="HttpClient.BaseAddress"/> had NO trailing slash — so .NET resolved the
/// leading-slash relative URI from the HOST ROOT and dropped <c>/api</c>, hitting the
/// SPA (301 → HTML → JsonException → "upstream unavailable") instead of the API.
///
/// The fix: <see cref="McpBridgeCore.BaseUri"/> guarantees a single trailing slash and
/// <see cref="TextStackApiClient"/>'s relative URIs are leading-slash-stripped. These
/// tests pin PREFIX PRESERVATION on the ABSOLUTE resolved <c>request.RequestUri</c> —
/// they FAIL on the old leading-slash / no-trailing-slash code and PASS now.
///
/// Existing MCP tests use a prefix-LESS BaseAddress (<c>https://api.example/</c>), so
/// the bug never manifested there; this file is the missing prefixed-base coverage.
/// Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
/// </summary>
public class McpApiPrefixTests
{
    private const string SiteHost = "textstack.test";
    private const string Prefix = "http://localhost/api";
    private const string Edition = "33333333-3333-3333-3333-333333333333";

    // Captures the LAST request as the real HttpClient saw it (RequestUri is absolute
    // once sent through a client with a BaseAddress).
    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public HttpRequestMessage? LastRequest { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            return Task.FromResult(response);
        }
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json") };

    private static System.Text.Json.JsonElement Args(string json) =>
        System.Text.Json.JsonDocument.Parse(json).RootElement;

    // Builds the REAL TextStackApiClient exactly as McpBridgeCore.AddApiClient does —
    // through a ServiceCollection().AddHttpClient<T>(...) with BaseUri(prefix) and the
    // capturing primary handler — so the BaseAddress normalization + DI typed-client
    // path are exercised end-to-end (not a hand-rolled HttpClient).
    private static (McpToolCatalog catalog, CapturingHandler handler) BuildPrefixedCatalog(
        HttpResponseMessage response, string? token = "tok-123")
    {
        var handler = new CapturingHandler(response);
        var options = new McpBridgeOptions { ApiBaseUrl = Prefix, SiteHost = SiteHost, McpToken = token };

        var services = new ServiceCollection();
        services.AddSingleton(options);
        services.AddSingleton<IMcpTokenProvider>(new StaticEnvTokenProvider(options));
        services
            .AddHttpClient<TextStackApiClient>(http => http.BaseAddress = McpBridgeCore.BaseUri(options.ApiBaseUrl))
            .ConfigurePrimaryHttpMessageHandler(() => handler);

        var provider = services.BuildServiceProvider();
        var api = provider.GetRequiredService<TextStackApiClient>();
        return (new McpToolCatalog(api), handler);
    }

    // ── BaseUri helper: trailing-slash normalization (no double slash) ────────────

    [Fact]
    public void BaseUri_PrefixWithoutTrailingSlash_AppendsSingleSlash()
    {
        Assert.Equal("http://x/api/", McpBridgeCore.BaseUri("http://x/api").ToString());
    }

    [Fact]
    public void BaseUri_PrefixWithTrailingSlash_StaysSingleSlash()
    {
        // Idempotent — must NOT produce a double trailing slash.
        Assert.Equal("http://x/api/", McpBridgeCore.BaseUri("http://x/api/").ToString());
    }

    [Fact]
    public void BaseUri_NoPrefixHost_StillTrailingSlash()
    {
        Assert.Equal("http://x/", McpBridgeCore.BaseUri("http://x").ToString());
    }

    // ── BaseUri + relative client URI ⇒ absolute URL KEEPS the prefix ─────────────

    [Theory]
    [InlineData("search?q=alice", "http://localhost/api/search?q=alice")]
    [InlineData("me/highlights/abc", "http://localhost/api/me/highlights/abc")]
    public void BaseUri_CombinedWithRelative_PreservesPrefix(string relative, string expected)
    {
        // Mirrors how HttpClient resolves request.RequestUri against BaseAddress: the
        // relative URI has NO leading slash (as the client now builds it), so the
        // prefix segment survives instead of being treated as a replaceable file.
        var resolved = new Uri(McpBridgeCore.BaseUri(Prefix), new Uri(relative, UriKind.Relative));

        Assert.Equal(expected, resolved.ToString());
    }

    // ── end-to-end: public tool (search_books) keeps /api on the wire ─────────────

    [Fact]
    public async Task SearchBooks_PrefixedBaseUrl_KeepsApiPrefix_OnAbsoluteRequestUri()
    {
        var (catalog, handler) = BuildPrefixedCatalog(Json("""{"total":0,"items":[]}"""));

        var result = await catalog.CallAsync("search_books", Args("""{"query":"alice"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var uri = handler.LastRequest!.RequestUri!;
        Assert.True(uri.IsAbsoluteUri); // resolved through the client's BaseAddress
        // The /api prefix MUST survive. Old code produced http://localhost/search?... .
        Assert.Equal("http://localhost/api/search?q=alice", uri.AbsoluteUri);
        Assert.Equal(SiteHost, handler.LastRequest.Headers.Host);
    }

    // ── end-to-end: user-scoped tool (list_my_highlights) keeps /api on the wire ──

    [Fact]
    public async Task ListMyHighlights_PrefixedBaseUrl_KeepsApiPrefix_OnAbsoluteRequestUri()
    {
        var (catalog, handler) = BuildPrefixedCatalog(Json("[]"));

        var result = await catalog.CallAsync(
            "list_my_highlights", Args($$"""{"editionId":"{{Edition}}"}"""), CancellationToken.None);

        Assert.NotEqual(true, result.IsError);
        var uri = handler.LastRequest!.RequestUri!;
        Assert.True(uri.IsAbsoluteUri);
        // Old code → http://localhost/me/highlights/{id} (prefix dropped, 301→HTML).
        Assert.Equal($"http://localhost/api/me/highlights/{Edition}", uri.AbsoluteUri);
        Assert.Equal("Bearer tok-123", handler.LastRequest.Headers.Authorization?.ToString());
    }

    // ── end-to-end: POST user-scoped tool (ask_book) keeps /api on the wire ───────

    // ── device-flow URLs are fixed the same way (leading slash dropped) ───────────

    // Answers /auth/device/code with a valid device code; records the request URI.
    private sealed class DeviceCodeHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _captured = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Uri? FirstRequestUri { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            FirstRequestUri ??= request.RequestUri;
            _captured.TrySetResult();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"device_code":"DC","user_code":"UC","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC","expires_in":600,"interval":600}""",
                    System.Text.Encoding.UTF8, "application/json"),
            });
        }

        public Task WaitForFirstRequestAsync() => _captured.Task;
    }

    [Fact]
    public async Task DeviceFlow_PrefixedBaseUrl_KeepsApiPrefix_OnDeviceCodeUrl()
    {
        var handler = new DeviceCodeHandler();
        // Built exactly as McpHosts wires the device-flow named client: BaseUri(prefix).
        var http = new HttpClient(handler) { BaseAddress = McpBridgeCore.BaseUri(Prefix) };
        var cache = new TokenCache(Path.Combine(Path.GetTempPath(), "ts-mcp-" + Guid.NewGuid().ToString("N") + ".json"));
        var provider = new DeviceFlowTokenProvider(
            http, cache, NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));

        // Cold call → starts a device flow (the /auth/device/code POST), returns Pending.
        var token = await provider.GetTokenAsync(CancellationToken.None);
        Assert.IsType<TokenResult.Pending>(token);

        await handler.WaitForFirstRequestAsync();

        // Old code → http://localhost/auth/device/code (prefix dropped). Fixed: kept.
        Assert.Equal("http://localhost/api/auth/device/code", handler.FirstRequestUri!.AbsoluteUri);
    }
}
