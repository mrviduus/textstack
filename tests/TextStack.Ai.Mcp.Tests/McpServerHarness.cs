using System.Net;
using Microsoft.AspNetCore.Builder;
using ModelContextProtocol.Client;
using TextStack.Ai.Mcp;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// Boots the REAL MCP <c>BuildHttp</c> host (the same <c>WebApplication</c> +
/// <c>MapMcp("/mcp")</c> the production container runs) on a loopback port, pointed
/// at a <see cref="StubBackend"/>. Tests then drive it with the REAL
/// <c>ModelContextProtocol.Client.McpClient</c> over an <c>HttpClientTransport</c>
/// (streamable HTTP) — exercising the full wire protocol: initialize → tools/list →
/// tools/call, with the SDK's JSON-RPC framing, not a fake handler.
///
/// Loopback (not WAF in-memory) is the chosen harness: it mirrors the existing
/// <c>BuildHttp_StartsWebApplication_HealthReturns200</c> unit test and sidesteps any
/// TestServer streamable-HTTP quirks while staying fully hermetic (127.0.0.1 only,
/// no Docker, no live API, no external network).
///
/// The bridge's bearer comes from <c>HttpContextTokenProvider</c> in http mode, so
/// authorized tool calls forward the client's <c>Authorization: Bearer</c> header all
/// the way to the stub — exactly how the production remote transport behaves.
/// </summary>
public sealed class McpServerHarness : IAsyncDisposable
{
    public const string TestJwt = "test-jwt.header.payload";

    private readonly WebApplication _mcp;
    private readonly StubBackend _stub;

    public StubBackend Stub => _stub;
    public string McpEndpoint { get; }

    private McpServerHarness(WebApplication mcp, StubBackend stub, string mcpEndpoint)
    {
        _mcp = mcp;
        _stub = stub;
        McpEndpoint = mcpEndpoint;
    }

    public static async Task<McpServerHarness> StartAsync(CancellationToken ct)
    {
        var stub = await StubBackend.StartAsync(ct);
        return await StartInternalAsync(stub, stub.BaseUrl, ct);
    }

    /// <summary>
    /// Harness whose bridge points at an UNREACHABLE upstream (a closed loopback
    /// port). Used to prove transport failures surface as a clean tool <c>IsError</c>
    /// over the wire, not a JSON-RPC protocol fault. Still hermetic (no network).
    /// </summary>
    public static async Task<McpServerHarness> StartWithUnreachableUpstreamAsync(CancellationToken ct)
    {
        // A still-running stub so Dispose is uniform, but the bridge is pointed at a
        // DIFFERENT, never-listening loopback port → connection refused.
        var stub = await StubBackend.StartAsync(ct);
        var deadUrl = $"http://127.0.0.1:{FreeTcpPort()}"; // nothing listening here
        return await StartInternalAsync(stub, deadUrl, ct);
    }

    private static async Task<McpServerHarness> StartInternalAsync(StubBackend stub, string apiBaseUrl, CancellationToken ct)
    {
        var mcpPort = FreeTcpPort();
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = apiBaseUrl,
            SiteHost = "textstack.app",
            Transport = McpTransport.Http,
        };
        // BuildHttp wires HttpContextTokenProvider (per-request bearer from the
        // Authorization header) — http mode never uses a static token here.
        var mcp = McpHosts.BuildHttp(options, args: [$"--urls=http://127.0.0.1:{mcpPort}"]);
        await mcp.StartAsync(ct);

        return new McpServerHarness(mcp, stub, $"http://127.0.0.1:{mcpPort}/mcp");
    }

    /// <summary>
    /// A real <see cref="McpClient"/> over streamable HTTP. <paramref name="bearer"/>
    /// (when set) is sent as <c>Authorization: Bearer</c> on every request — the
    /// header the bridge's <c>HttpContextTokenProvider</c> reads to authorize the
    /// user-scoped tools. CreateAsync runs the initialize handshake.
    /// </summary>
    public async Task<McpClient> ConnectAsync(string? bearer, CancellationToken ct)
    {
        var transportOptions = new HttpClientTransportOptions
        {
            Endpoint = new Uri(McpEndpoint),
            TransportMode = HttpTransportMode.StreamableHttp,
        };
        if (bearer is not null)
            transportOptions.AdditionalHeaders = new Dictionary<string, string> { ["Authorization"] = $"Bearer {bearer}" };

        var transport = new HttpClientTransport(transportOptions);
        return await McpClient.CreateAsync(transport, cancellationToken: ct);
    }

    /// <summary>
    /// Connects the way ChatGPT does: no header at all, the key in the path
    /// (<c>/mcp/k/&lt;key&gt;</c>, see <c>ConnectUrl</c>).
    /// </summary>
    public async Task<McpClient> ConnectViaUrlAsync(string key, CancellationToken ct)
    {
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri($"{McpEndpoint}/k/{key}"),
            TransportMode = HttpTransportMode.StreamableHttp,
        });
        return await McpClient.CreateAsync(transport, cancellationToken: ct);
    }

    private static int FreeTcpPort()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    public async ValueTask DisposeAsync()
    {
        await _mcp.StopAsync();
        await _mcp.DisposeAsync();
        await _stub.DisposeAsync();
    }
}
