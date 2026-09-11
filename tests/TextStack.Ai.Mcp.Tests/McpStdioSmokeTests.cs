using ModelContextProtocol.Client;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// AI-053 stdio smoke — spawns the BUILT MCP server DLL as a subprocess over the
/// REAL <see cref="StdioClientTransport"/> (the default transport, byte-identical to
/// the pre-049 server) and drives initialize + tools/list through the wire. This is
/// the one path the in-process HTTP suite can't cover: actual process launch, stdin/
/// stdout JSON-RPC framing, env-var config.
///
/// Hermetic: TEXTSTACK_API_URL points at an unreachable loopback port (no network),
/// and tools/list never calls upstream, so no backend is needed. TEXTSTACK_MCP_TOKEN
/// is set so the stdio host takes the static-token branch (no device flow / no token
/// cache file touched).
///
/// SKIPPABLE: if the server DLL isn't built (e.g. a partial CI checkout), the test
/// skips rather than failing — it must not break CI when the artifact is absent.
/// </summary>
public class McpStdioSmokeTests
{
    [Fact]
    public async Task Stdio_SubprocessServer_InitializeAndListToolsReturnsWholeSurface()
    {
        var ct = TestContext.Current.CancellationToken;

        var dll = LocateServerDll();
        if (dll is null)
        {
            Assert.Skip("TextStack.Ai.Mcp.dll not found next to the test build output — skipping stdio smoke.");
            return;
        }

        var transport = new StdioClientTransport(new StdioClientTransportOptions
        {
            Name = "textstack-mcp-stdio-smoke",
            Command = "dotnet",
            Arguments = [dll],
            EnvironmentVariables = new Dictionary<string, string?>
            {
                // Static-token branch → no device flow, no token cache file.
                ["TEXTSTACK_MCP_TOKEN"] = "stdio-smoke-token",
                // Unreachable upstream — tools/list never calls it, but pin it so a
                // stray call can't escape to the real public API.
                ["TEXTSTACK_API_URL"] = "http://127.0.0.1:1",
                // Force stdio (the default, but explicit for clarity).
                ["MCP_TRANSPORT"] = "stdio",
            },
        });

        await using var client = await McpClient.CreateAsync(transport, cancellationToken: ct);

        Assert.Equal("textstack", client.ServerInfo.Name);

        var tools = await client.ListToolsAsync(cancellationToken: ct);
        Assert.Equal(16, tools.Count);
    }

    // The MCP project is a ProjectReference, so its DLL is built into the test
    // output's referenced-assemblies — but we want the server's OWN published-style
    // entry DLL (it has runtimeconfig). Resolve it from the server project's bin dir
    // matching THIS test's build config, falling back across configs.
    private static string? LocateServerDll()
    {
        // tests/TextStack.Ai.Mcp.Tests/bin/<cfg>/net10.0/  → repo-relative server bin.
        var testDir = AppContext.BaseDirectory;
        var tfm = new DirectoryInfo(testDir).Name;                 // net10.0
        var cfg = new DirectoryInfo(testDir).Parent!.Name;         // Debug | Release

        // Walk up to the repo root (the dir that contains "backend").
        var dir = new DirectoryInfo(testDir);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "backend")))
            dir = dir.Parent;
        if (dir is null)
            return null;

        var serverBin = Path.Combine(
            dir.FullName, "backend", "src", "Ai", "TextStack.Ai.Mcp", "bin");

        // Prefer the matching config; otherwise take whichever config is built.
        foreach (var candidateCfg in new[] { cfg, "Release", "Debug" })
        {
            var path = Path.Combine(serverBin, candidateCfg, tfm, "TextStack.Ai.Mcp.dll");
            if (File.Exists(path))
                return path;
        }

        return null;
    }
}
