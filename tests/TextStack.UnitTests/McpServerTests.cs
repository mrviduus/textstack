using System.Net;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// The MCP tool catalog's dispatch, testable without network or a stdio subprocess: an unknown tool,
/// a tool error that sends nothing.
/// </summary>
public class McpServerTests
{
    /// <summary>Records every request; any request is a failure of these tests.</summary>
    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private static (McpToolCatalog catalog, RecordingHandler handler) BuildCatalog()
    {
        var handler = new RecordingHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions { ApiBaseUrl = "https://api.example", SiteHost = "textstack.test", McpToken = "t" };
        return (new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options))), handler);
    }

    private static JsonElement Args(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public async Task Call_UnknownTool_ReturnsToolError_SendsNothing()
    {
        var (catalog, handler) = BuildCatalog();

        var result = await catalog.CallAsync("does_not_exist", Args("{}"), CancellationToken.None);

        Assert.True(result.IsError);
        Assert.Empty(handler.Requests);
    }
}
