using System.Net;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// AI-049 — the remote HTTP (streamable) transport. Covers the per-connection
/// identity provider (<see cref="HttpContextTokenProvider"/>), the multi-user
/// guarantee (different bearers → different tokens), the catalog composition over
/// it (no bearer → clean auth-required IsError, zero HTTP), and the dual-mode host
/// switch (http builds a WebApplication with /health → 200; stdio still constructs;
/// MCP_TRANSPORT parses).
///
/// CI-safe: no live server, no network. The http host is started on an ephemeral
/// loopback port. Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
/// </summary>
public class McpHttpTransportTests
{
    // ── fakes ────────────────────────────────────────────────────────────────────

    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public int Sends { get; private set; }
        public HttpRequestMessage? LastRequest { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Sends++;
            LastRequest = request;
            return Task.FromResult(response);
        }
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static System.Text.Json.JsonElement Args(string json) =>
        System.Text.Json.JsonDocument.Parse(json).RootElement;

    private static string TextOf(CallToolResult r) => ((TextContentBlock)r.Content[0]).Text;

    // A fake IHttpContextAccessor pinned to ONE request context. Unlike the framework
    // HttpContextAccessor (a process-wide AsyncLocal), separate instances are fully
    // isolated — which is exactly how two concurrent scoped providers behave, each
    // bound to its own request scope.
    private sealed class FakeHttpContextAccessor(HttpContext? context) : IHttpContextAccessor
    {
        public HttpContext? HttpContext { get; set; } = context;
    }

    // A fake accessor whose HttpContext carries the given Authorization header
    // (null = no context at all; "" / value = header on the request).
    private static IHttpContextAccessor AccessorWith(string? authorizationHeader)
    {
        var ctx = new DefaultHttpContext();
        if (authorizationHeader is not null)
            ctx.Request.Headers.Authorization = authorizationHeader;
        return new FakeHttpContextAccessor(ctx);
    }

    // ── HttpContextTokenProvider: header → TokenResult ───────────────────────────

    [Fact]
    public async Task GetTokenAsync_BearerHeader_ReturnsAuthorizedWithRawJwt()
    {
        var provider = new HttpContextTokenProvider(AccessorWith("Bearer jwt-abc.def.ghi"));

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal("jwt-abc.def.ghi", Assert.IsType<TokenResult.Authorized>(result).AccessToken);
    }

    [Theory]
    [InlineData("bearer jwt-lower")]   // lower-case scheme
    [InlineData("BEARER jwt-upper")]   // upper-case scheme
    [InlineData("BeArEr jwt-mixed")]   // mixed-case scheme
    public async Task GetTokenAsync_SchemeIsCaseInsensitive(string header)
    {
        var provider = new HttpContextTokenProvider(AccessorWith(header));

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.StartsWith("jwt-", Assert.IsType<TokenResult.Authorized>(result).AccessToken);
    }

    [Theory]
    [InlineData(null)]              // no header
    [InlineData("")]               // empty header
    [InlineData("   ")]            // whitespace
    [InlineData("Bearer ")]        // scheme only
    [InlineData("Bearer    ")]     // scheme + only whitespace
    [InlineData("Basic abc123")]   // wrong scheme
    [InlineData("jwt-no-scheme")]  // malformed, no scheme
    public async Task GetTokenAsync_MissingOrMalformed_ReturnsFailedWithGuidance(string? header)
    {
        var provider = new HttpContextTokenProvider(AccessorWith(header));

        var result = await provider.GetTokenAsync(CancellationToken.None);

        var failed = Assert.IsType<TokenResult.Failed>(result);
        Assert.Contains("Authorization: Bearer", failed.Message);
    }

    [Fact]
    public async Task GetTokenAsync_NoHttpContext_ReturnsFailed_NoThrow()
    {
        var provider = new HttpContextTokenProvider(new FakeHttpContextAccessor(null));

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.IsType<TokenResult.Failed>(result);
    }

    // ── composition: catalog over HttpContextTokenProvider, no bearer → IsError ───

    [Fact]
    public async Task UserScopedTool_NoBearer_ReturnsAuthRequired_AndIssuesZeroSends()
    {
        var handler = new CapturingHandler(Json("[]"));
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "https://api.example",
            SiteHost = "textstack.test",
            Transport = McpTransport.Http,
        };
        var provider = new HttpContextTokenProvider(AccessorWith(null)); // no bearer
        var catalog = new McpToolCatalog(new TextStackApiClient(http, options, provider));

        var result = await catalog.CallAsync(
            "list_my_highlights",
            Args("""{"editionId":"33333333-3333-3333-3333-333333333333"}"""),
            CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Contains("authentication required", TextOf(result));
        Assert.Equal(0, handler.Sends); // never issued the HTTP call
    }

    // ── multi-user guarantee: different bearers → different tokens ───────────────

    [Fact]
    public async Task PerRequestProvider_DifferentBearers_YieldDifferentTokens()
    {
        // Two independent request contexts (as two scopes would have under HTTP).
        var alice = new HttpContextTokenProvider(AccessorWith("Bearer alice-token"));
        var bob = new HttpContextTokenProvider(AccessorWith("Bearer bob-token"));

        var a = await alice.GetTokenAsync(CancellationToken.None);
        var b = await bob.GetTokenAsync(CancellationToken.None);

        Assert.Equal("alice-token", Assert.IsType<TokenResult.Authorized>(a).AccessToken);
        Assert.Equal("bob-token", Assert.IsType<TokenResult.Authorized>(b).AccessToken);
    }

    [Fact]
    public async Task SameProviderInstance_ReReadsLiveRequest_NoCapturedBearer()
    {
        // Guards against a singleton capturing the first request's bearer: swap the
        // accessor's live context between calls and confirm the provider follows it.
        var accessor = new FakeHttpContextAccessor(new DefaultHttpContext());
        var provider = new HttpContextTokenProvider(accessor);

        accessor.HttpContext!.Request.Headers.Authorization = "Bearer first";
        var first = await provider.GetTokenAsync(CancellationToken.None);

        accessor.HttpContext = new DefaultHttpContext();
        accessor.HttpContext.Request.Headers.Authorization = "Bearer second";
        var second = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal("first", Assert.IsType<TokenResult.Authorized>(first).AccessToken);
        Assert.Equal("second", Assert.IsType<TokenResult.Authorized>(second).AccessToken);
    }

    // ── HERMETIC isolation through the REAL http DI container (AI-049 P1) ─────────
    // The provider-level tests above use hand-built instances. These resolve through
    // the container BuildHttp actually wires, so a singleton-capture regression
    // (e.g. someone flips McpToolCatalog/HttpContextTokenProvider to AddSingleton)
    // fails HERE, not just in a fake.

    private static McpBridgeOptions HttpOptions() => new()
    {
        ApiBaseUrl = "http://api:8080",
        SiteHost = "textstack.app",
        Transport = McpTransport.Http,
    };

    [Fact]
    public void BuildHttp_IdentityServices_AreNotSingletons()
    {
        // The catastrophic-failure guard: if the token provider, catalog, or api
        // client were singletons, the FIRST connection's bearer would be reused for
        // every later connection. Each must be scope-local (distinct per scope) and
        // the token provider must NOT be resolvable from the ROOT (scoped-only).
        using var app = McpHosts.BuildHttp(HttpOptions(), args: []);
        var root = app.Services;

        using var scopeA = root.CreateScope();
        using var scopeB = root.CreateScope();

        var providerA = scopeA.ServiceProvider.GetRequiredService<IMcpTokenProvider>();
        var providerB = scopeB.ServiceProvider.GetRequiredService<IMcpTokenProvider>();
        var catalogA = scopeA.ServiceProvider.GetRequiredService<McpToolCatalog>();
        var catalogB = scopeB.ServiceProvider.GetRequiredService<McpToolCatalog>();
        var clientA = scopeA.ServiceProvider.GetRequiredService<TextStackApiClient>();
        var clientB = scopeB.ServiceProvider.GetRequiredService<TextStackApiClient>();

        Assert.IsType<HttpContextTokenProvider>(providerA);
        // The isolation property: a DISTINCT instance per scope. A singleton
        // registration (the catastrophic regression) would make these Same and the
        // first connection's identity would leak to the second.
        Assert.NotSame(providerA, providerB); // per-request identity, never shared
        Assert.NotSame(catalogA, catalogB);
        Assert.NotSame(clientA, clientB);

        // Same scope → same instance (sanity: scoped, not transient — the catalog and
        // its api client are stable WITHIN one request).
        Assert.Same(providerA, scopeA.ServiceProvider.GetRequiredService<IMcpTokenProvider>());
        Assert.Same(catalogA, scopeA.ServiceProvider.GetRequiredService<McpToolCatalog>());

        // NOTE: scope validation is OFF in this host (WebApplication outside
        // Development), so resolving a scoped service from the ROOT does NOT throw.
        // The code never does that (stateless transport resolves from the per-request
        // scope — verified in BuildHttp_TwoScopes_DifferentBearers_NoCrossTalk), but
        // the runtime safety-net is absent. See bug report (P3).
    }

    [Fact]
    public async Task BuildHttp_TwoScopes_DifferentBearers_NoCrossTalk()
    {
        // End-to-end through the real container: two request scopes, each with its
        // OWN HttpContext bearer set on the (singleton, AsyncLocal-backed) accessor.
        // The token provider resolved in each scope must read ITS scope's bearer —
        // proving no scope captured the other's identity. Done sequentially (one
        // logical context at a time) to mirror how a request flows.
        using var app = McpHosts.BuildHttp(HttpOptions(), args: []);
        var root = app.Services;

        async Task<string> BearerInScopeAsync(string token)
        {
            using var scope = root.CreateScope();
            // Populate the live request for THIS scope, exactly as the middleware
            // would, then resolve the scoped provider and read it.
            var accessor = scope.ServiceProvider.GetRequiredService<IHttpContextAccessor>();
            var ctx = new DefaultHttpContext();
            ctx.Request.Headers.Authorization = $"Bearer {token}";
            accessor.HttpContext = ctx;

            var provider = scope.ServiceProvider.GetRequiredService<IMcpTokenProvider>();
            var result = await provider.GetTokenAsync(CancellationToken.None);
            return Assert.IsType<TokenResult.Authorized>(result).AccessToken;
        }

        var alice = await BearerInScopeAsync("alice-jwt");
        var bob = await BearerInScopeAsync("bob-jwt");

        Assert.Equal("alice-jwt", alice);
        Assert.Equal("bob-jwt", bob); // bob did NOT inherit alice's token
    }

    // ── dual-mode startup: transport switch + http host /health ──────────────────

    [Theory]
    [InlineData("http", McpTransport.Http)]
    [InlineData("HTTP", McpTransport.Http)]
    [InlineData("stdio", McpTransport.Stdio)]
    [InlineData(null, McpTransport.Stdio)]
    [InlineData("", McpTransport.Stdio)]
    [InlineData("garbage", McpTransport.Stdio)]
    public void ResolveTransport_FromEnv_ParsesMode(string? env, McpTransport expected) =>
        Assert.Equal(expected, McpBridgeOptions.ResolveTransport(env, args: null));

    [Fact]
    public void ResolveTransport_HttpFlag_SelectsHttp_EvenWithoutEnv() =>
        Assert.Equal(McpTransport.Http, McpBridgeOptions.ResolveTransport(envValue: null, args: ["--http"]));

    [Fact]
    public void BuildStdio_Constructs_WithoutThrowing()
    {
        // MCP_TRANSPORT unset → stdio path. Static token avoids touching the real
        // device-flow token cache file. Host must construct (DI graph resolves).
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "https://api.example",
            SiteHost = "textstack.test",
            McpToken = "static-ci-token",
            Transport = McpTransport.Stdio,
        };

        using var host = McpHosts.BuildStdio(options, args: []);

        Assert.NotNull(host);
    }

    [Fact]
    public async Task BuildHttp_StartsWebApplication_HealthReturns200()
    {
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "http://api:8080",
            SiteHost = "textstack.app",
            Transport = McpTransport.Http,
        };

        // Bind an ephemeral loopback port so the test never collides with a real one.
        var port = FreeTcpPort();
        var ct = TestContext.Current.CancellationToken;
        var app = McpHosts.BuildHttp(options, args: [$"--urls=http://127.0.0.1:{port}"]);
        await app.StartAsync(ct);
        try
        {
            // Connect via "localhost" because the TEST host environment may apply host
            // filtering (so we use a host the filter accepts). The PRODUCTION MCP
            // container has NO appsettings.json → AllowedHosts=* (open filter), which is
            // correct: it's localhost-only (127.0.0.1:8090) behind nginx, which sets the
            // Host header. So the container probe is unaffected either way.
            using var client = new HttpClient { BaseAddress = new Uri($"http://localhost:{port}") };
            using var resp = await client.GetAsync("/health", ct);
            Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        }
        finally
        {
            await app.StopAsync(ct);
            await app.DisposeAsync();
        }
    }

    private static int FreeTcpPort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
