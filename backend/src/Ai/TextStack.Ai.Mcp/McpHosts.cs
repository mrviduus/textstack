using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Server;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.Ai.Mcp;

/// <summary>
/// Builds the two transport hosts (AI-049). Extracted from <c>Program.cs</c> so
/// the wiring is unit-testable (construct without throwing; mode switch) and so the
/// shared bits (<see cref="McpBridgeCore"/>) are registered identically.
///
/// stdio = byte-identical to the pre-049 server (singletons, logs→stderr,
/// device-flow / static token). http = multi-user streamable HTTP (scoped per-
/// request identity via <see cref="HttpContextTokenProvider"/>, normal logging,
/// <c>/mcp</c> + a <c>/health</c> probe).
/// </summary>
public static class McpHosts
{
    // ── stdio (default — UNCHANGED from the original Program.cs) ─────────────────

    /// <summary>
    /// Local single-identity host. stdout carries ONLY JSON-RPC, so ALL logging
    /// goes to stderr. Singleton DI; token from the static env var OR the device
    /// flow. This path must stay byte-identical to the pre-049 behaviour.
    /// </summary>
    public static IHost BuildStdio(McpBridgeOptions options, string[] args)
    {
        var builder = Host.CreateApplicationBuilder(args);

        // stdout is reserved for JSON-RPC — route every log record to stderr.
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);

        builder.Services.AddSingleton(options);
        AddTokenProviderStdio(builder.Services, options);
        McpBridgeCore.AddApiClient(builder.Services, options);
        builder.Services.AddSingleton<McpToolCatalog>();

        builder.Services
            .AddMcpServer(o =>
            {
                o.ServerInfo = McpBridgeCore.ServerInfo();
                o.Capabilities = McpBridgeCore.Capabilities();
                o.Handlers = McpBridgeCore.BuildHandlers();
            })
            .WithStdioServerTransport();

        return builder.Build();
    }

    // Stdio token provider: static env var → StaticEnvTokenProvider (CI / escape
    // hatch); else the device flow (cached token → refresh → device authorization).
    private static void AddTokenProviderStdio(IServiceCollection services, McpBridgeOptions options)
    {
        if (!string.IsNullOrWhiteSpace(options.McpToken))
        {
            services.AddSingleton<IMcpTokenProvider, StaticEnvTokenProvider>();
            return;
        }

        services.AddSingleton(new TokenCache(TokenCache.ResolvePath(options.TokenCachePath)));

        const string deviceFlowClient = "device-flow";
        services.AddHttpClient(deviceFlowClient, http =>
        {
            http.BaseAddress = McpBridgeCore.BaseUri(options.ApiBaseUrl);
            http.DefaultRequestHeaders.Host = options.SiteHost;
            // Env-overridable (TEXTSTACK_MCP_TIMEOUT_SECONDS, default 15) — same helper
            // the typed TextStackApiClient uses, so the auth client never drifts.
            http.Timeout = TimeSpan.FromSeconds(McpBridgeCore.McpTimeoutSeconds());
        });

        services.AddSingleton<IMcpTokenProvider>(sp => new DeviceFlowTokenProvider(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(deviceFlowClient),
            sp.GetRequiredService<TokenCache>(),
            sp.GetRequiredService<ILogger<DeviceFlowTokenProvider>>()));
    }

    // ── http (AI-049 — remote, multi-user streamable transport) ─────────────────

    /// <summary>
    /// Remote streamable HTTP host. NORMAL logging (no JSON-RPC on stdout here).
    /// Each connection carries its OWN bearer, so identity is per-request: the
    /// token provider + catalog are SCOPED and read the live request via
    /// <see cref="IHttpContextAccessor"/>. Stateless transport. Exposes
    /// <c>/mcp</c> (the MCP endpoint) and <c>/health</c> (Docker probe).
    /// </summary>
    public static WebApplication BuildHttp(McpBridgeOptions options, string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // Defense-in-depth for the public multi-user endpoint: turn the DI safety net
        // ON regardless of environment (this host doesn't run in Development, so both
        // would default OFF). A future regression that registers an identity service
        // (HttpContextTokenProvider / McpToolCatalog) as a SINGLETON capturing a scoped
        // dep would then fail at build instead of silently leaking one user's bearer.
        builder.Host.UseDefaultServiceProvider((_, o) =>
        {
            o.ValidateScopes = true;
            o.ValidateOnBuild = true;
        });

        // The personal connect URL (/mcp/k/<key>, see ConnectUrl) carries a secret in the path, and
        // these two categories log the raw request path at Information — the hosting one before any
        // middleware runs. Warning keeps errors and drops the per-request lines.
        builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
        builder.Logging.AddFilter("Microsoft.AspNetCore.Routing", LogLevel.Warning);

        builder.Services.AddSingleton(options);
        builder.Services.AddHttpContextAccessor();

        // Per-request bearer → scoped provider + scoped catalog (NEVER singletons,
        // or one connection's identity would leak to another).
        builder.Services.AddScoped<IMcpTokenProvider, HttpContextTokenProvider>();
        McpBridgeCore.AddApiClient(builder.Services, options); // typed client is request-scoped already
        builder.Services.AddScoped<McpToolCatalog>();

        builder.Services
            .AddMcpServer(o =>
            {
                o.ServerInfo = McpBridgeCore.ServerInfo();
                o.Capabilities = McpBridgeCore.Capabilities();
                o.Handlers = McpBridgeCore.BuildHandlers();
            })
            .WithHttpTransport(t => t.Stateless = true);

        var app = builder.Build();

        // /mcp/k/<key> → Authorization: Bearer <key> on /mcp. Must run BEFORE routing picks an
        // endpoint, hence the explicit UseRouting below (minimal hosting otherwise routes first).
        app.Use(async (ctx, next) =>
        {
            if (!ConnectUrl.TryRewrite(ctx.Request))
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            await next();
        });

        // Login required for ALL of /mcp (ADR-017): no bearer → 401 + challenge, which is what starts
        // the OAuth sign-in in Claude/ChatGPT. Runs after the connect-URL rewrite, so /mcp/k/<key>
        // arrives here already carrying its bearer.
        app.Use(async (ctx, next) =>
        {
            if (ctx.Request.Path.StartsWithSegments("/mcp"))
            {
                var bearer = OAuthChallenge.Bearer(ctx.Request);
                if (bearer is null)
                {
                    OAuthChallenge.Write(ctx.Response, options.PublicBaseUrl);
                    return;
                }
                if (bearer.StartsWith("tso_", StringComparison.Ordinal) && await IsRejectedAsync(ctx))
                {
                    OAuthChallenge.Write(ctx.Response, options.PublicBaseUrl, "invalid_token");
                    return;
                }
            }
            await next();
        });
        app.UseRouting();

        // Docker healthcheck — plain 200, no auth, no MCP framing.
        app.MapGet("/health", () => Results.Ok("ok"));

        // Protected Resource Metadata (RFC 9728): path-suffixed form (what the challenge names) and
        // the root form clients try as a fallback. Same document.
        var prm = OAuthChallenge.Metadata(options.PublicBaseUrl);
        app.MapGet(OAuthChallenge.ResourceMetadataPath + "/mcp", () => Results.Json(prm));
        app.MapGet(OAuthChallenge.ResourceMetadataPath, () => Results.Json(prm));

        app.MapMcp("/mcp");

        return app;
    }

    // Asks the API whether this request's OAuth token is still good. Fails OPEN on a transport fault:
    // an unreachable API already turns every tool call into a clean error, and a 401 here would send
    // the client into a sign-in loop over an outage.
    private static async Task<bool> IsRejectedAsync(HttpContext ctx)
    {
        try
        {
            return await ctx.RequestServices.GetRequiredService<TextStackApiClient>()
                .IsTokenRejectedAsync(ctx.RequestAborted);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ctx.RequestAborted.IsCancellationRequested)
        {
            return false;
        }
    }
}
