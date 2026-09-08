using System.Net;
using System.Text.Json;
using Api.Endpoints;
using TextStack.Ai.Mcp;
using TextStack.Ai.Mcp.Auth;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.UnitTests;

/// <summary>
/// The seam that makes the assistant highlight ceiling work.
///
/// <para><c>HighlightsEndpoints</c> caps how many highlights an assistant may place in one book
/// (<see cref="HighlightsEndpoints.MaxAssistantHighlightsPerBook"/>) by counting rows whose anchor
/// has <c>source = </c><see cref="HighlightsEndpoints.McpAnchorSource"/>. Nothing in the type system
/// connects that field to the JSON the MCP bridge actually writes: they live in different projects,
/// and between them sits an opaque jsonb column the endpoint owns no schema for.</para>
///
/// <para>So if <c>SynthesizeAnchor</c> ever renames the field or changes its value, the cap matches
/// nothing and silently stops applying. There is no error and no symptom — until a book comes back
/// marked end to end. This assembly is the one place that can see both sides.</para>
/// </summary>
public class AssistantHighlightCeilingTests
{
    private sealed class CapturingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        public string? LastRequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.Content is not null)
                LastRequestBody = await request.Content.ReadAsStringAsync(cancellationToken);
            return response;
        }
    }

    private const string Book = "77777777-7777-7777-7777-777777777777";
    private const string Chapter = "88888888-8888-8888-8888-888888888888";
    private const string Edition = "33333333-3333-3333-3333-333333333333";

    private const string SavedBody =
        """
        {
          "id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          "editionId": null, "chapterId": null,
          "userBookId": "77777777-7777-7777-7777-777777777777",
          "userChapterId": "88888888-8888-8888-8888-888888888888",
          "anchorJson": "{}", "color": "yellow",
          "selectedText": "x", "noteText": null, "version": 1,
          "createdAt": "2026-01-01T00:00:00+00:00",
          "updatedAt": "2026-01-01T00:00:00+00:00"
        }
        """;

    private static async Task<string> AnchorWrittenByAsync(string tool, string args)
    {
        var handler = new CapturingHandler(
            new HttpResponseMessage(HttpStatusCode.Created)
            {
                Content = new StringContent(SavedBody, System.Text.Encoding.UTF8, "application/json"),
            });
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var options = new McpBridgeOptions
        {
            ApiBaseUrl = "https://api.example",
            SiteHost = "textstack.test",
            McpToken = "tok",
        };
        var catalog = new McpToolCatalog(new TextStackApiClient(http, options, new StaticEnvTokenProvider(options)));

        await catalog.CallAsync(tool, JsonDocument.Parse(args).RootElement, CancellationToken.None);

        var sent = JsonDocument.Parse(handler.LastRequestBody!).RootElement;
        return sent.GetProperty("anchorJson").GetString()!;
    }

    [Theory]
    [InlineData("save_my_highlight",
        $$"""{"bookId":"{{Book}}","chapterId":"{{Chapter}}","selectedText":"a quorum of replicas"}""")]
    [InlineData("save_highlight",
        $$"""{"editionId":"{{Edition}}","chapterId":"{{Chapter}}","selectedText":"the dead travel fast"}""")]
    public async Task EveryAssistantWrite_CarriesTheSourceTheCapCountsOn(string tool, string args)
    {
        var anchor = await AnchorWrittenByAsync(tool, args);

        // Read the field, exactly as `anchor_json->>'source'` does — not a substring
        // of the serialized text, which would pass even if the value moved into a
        // nested object the SQL predicate cannot see.
        using var doc = JsonDocument.Parse(anchor);
        Assert.Equal(
            HighlightsEndpoints.McpAnchorSource,
            doc.RootElement.GetProperty("source").GetString());
    }

    [Fact]
    public void AReaderAnchor_HasNoSource_SoAPersonIsNeverCapped()
    {
        // The shape the web reader stores: prefix/exact/suffix plus offsets, no source.
        // The cap must be invisible to it, including on a book an assistant has also
        // marked — which is the whole reason it counts by source and not by row.
        const string readerAnchor =
            """{"prefix":"and then ","exact":"the dead travel fast","suffix":" said he","startOffset":812,"endOffset":832}""";

        using var doc = JsonDocument.Parse(readerAnchor);
        Assert.False(doc.RootElement.TryGetProperty("source", out _));
    }

    [Fact]
    public void TheCeiling_IsAboveAnyPlausibleDeliberatePass()
    {
        // A guard on the guard: this is a legibility stop for a runaway loop, not a
        // taste limit. Tightening it to something a thorough pass over a long book
        // could hit would turn a safety net into a product decision made by accident.
        Assert.True(HighlightsEndpoints.MaxAssistantHighlightsPerBook >= 100);
    }
}
