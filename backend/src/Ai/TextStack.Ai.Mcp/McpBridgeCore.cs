using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using TextStack.Ai.Mcp.Http;
using TextStack.Ai.Mcp.Tools;

namespace TextStack.Ai.Mcp;

/// <summary>
/// Transport-agnostic wiring shared by BOTH hosts (stdio + http, AI-049): the
/// typed <see cref="TextStackApiClient"/> HTTP config and the
/// <c>tools/list</c> / <c>tools/call</c> handler delegates.
///
/// The handlers resolve <see cref="McpToolCatalog"/> from <c>request.Services</c>
/// (which is request-scoped under HTTP and the root provider under stdio), so they
/// are lifetime-agnostic and IDENTICAL across hosts. Only the DI lifetime of the
/// catalog / token provider differs per transport, registered by the callers.
/// </summary>
internal static class McpBridgeCore
{
    /// <summary>
    /// Registers the typed <see cref="TextStackApiClient"/> over the public API.
    /// The Host header is set per-request inside the client so
    /// <c>SiteContextMiddleware</c> resolves the site. Bound timeout so a stuck
    /// upstream can't hang a tool call for the default 100s.
    /// </summary>
    public static void AddApiClient(IServiceCollection services, McpBridgeOptions options) =>
        services.AddHttpClient<TextStackApiClient>(http =>
        {
            http.BaseAddress = BaseUri(options.ApiBaseUrl);
            http.Timeout = TimeSpan.FromSeconds(McpTimeoutSeconds());
        });

    /// <summary>
    /// Absolute base URI with a guaranteed trailing slash so a path prefix
    /// (e.g. <c>https://textstack.app/api</c>) is kept when relative request
    /// URIs are resolved — without it, the last segment ("api") is treated as a
    /// file and replaced, dropping the prefix.
    /// </summary>
    public static Uri BaseUri(string apiBaseUrl) =>
        new(apiBaseUrl.EndsWith('/') ? apiBaseUrl : apiBaseUrl + "/", UriKind.Absolute);

    /// <summary>
    /// The shared MCP server handlers. Both hosts register the SAME pair; identity
    /// (and lifetime) is supplied by whatever <see cref="McpToolCatalog"/> the
    /// request scope resolves.
    /// </summary>
    public static McpServerHandlers BuildHandlers() => new()
    {
        // tools/list — projected from the runtime catalog.
        ListToolsHandler = (request, _) =>
        {
            var catalog = request.Services!.GetRequiredService<McpToolCatalog>();
            return ValueTask.FromResult(new ListToolsResult { Tools = catalog.ListTools() });
        },
        // tools/call — dispatch by name; args dictionary → a single JSON object for
        // the catalog handler (which validates against the input schema).
        CallToolHandler = async (request, ct) =>
        {
            var catalog = request.Services!.GetRequiredService<McpToolCatalog>();
            var name = request.Params!.Name;
            var arguments = ToArgumentsObject(request.Params.Arguments);
            return await catalog.CallAsync(name, arguments, ct);
        },
    };

    /// <summary>Server identity advertised in both transports.</summary>
    public static Implementation ServerInfo() => new()
    {
        Name = "textstack",
        Version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "1.0.0",
    };

    /// <summary>Tools-only capability set (no prompts/resources).</summary>
    public static ServerCapabilities Capabilities() => new() { Tools = new ToolsCapability() };

    /// <summary>
    /// Server-level <c>instructions</c> sent at <c>initialize</c> by both transports. The "how to
    /// work" rules live here rather than in the message our Discuss button prefills: that
    /// message is read by a person, so it carries one sentence and the ids, nothing else.
    /// </summary>
    public const string Instructions =
        "TextStack is the user's reading app: the books they uploaded (\"my library\") plus a public catalog. "
        + "When the user mentions a TextStack book, find it first. A message may end with an id line such as "
        + "\"(TextStack: book <bookId>, chapter <chapterSlug>)\": \"book\" is an upload's bookId, \"catalog\" a catalog "
        + "book's slug, \"edition\" its editionId. Without ids, use search_my_library or get_my_reading. "
        + "Before discussing a book, call get_my_insights for conclusions from earlier conversations. "
        + "Read uploads with get_my_book / get_my_chapter, catalog books with get_book / get_chapter. "
        + "A message with a chapter in its id line opens a conversation about that chapter: talk freely, follow the reader "
        + "anywhere. Spoilers are soft: before discussing a chapter they have not reached, say so and ask first (\"that's from "
        + "chapter N — want me to go there?\"). When the conversation winds down or the reader says they are done, offer: "
        + "\"Review this chapter and save it to TextStack?\" Only on yes, call get_chapter_review, follow its method exactly "
        + "and save with save_chapter_review. Save conclusions not about that chapter with save_insight without chapterSlug. "
        + "Without a chapter in the id line it is a book discussion: save its conclusions with save_insight. "
        + "When the reader asks what a word means, or you explain one they clearly did not know, remember it. Offer those "
        + "words once, together, when the topic winds down or with the chapter-review offer (\"Save quiver, vicinity to "
        + "your TextStack vocabulary?\"), skipping any list_my_vocabulary already has. Only on yes, call "
        + "add_vocabulary_words with the sentence from the book. Never save a word without a yes.";

    // Rebuilds the MCP-supplied args dictionary into a single JSON object element so
    // the catalog handler can validate/read it as one schema-shaped value.
    private static JsonElement? ToArgumentsObject(IDictionary<string, JsonElement>? arguments)
    {
        if (arguments is null)
            return null;

        var node = new System.Text.Json.Nodes.JsonObject();
        foreach (var (key, value) in arguments)
            node[key] = System.Text.Json.Nodes.JsonNode.Parse(value.GetRawText());

        return JsonSerializer.SerializeToElement(node);
    }

    // HttpClient timeout in seconds. Env: TEXTSTACK_MCP_TIMEOUT_SECONDS (default 15);
    // a non-positive / unparseable value falls back to the 15s default. internal so
    // the stdio device-flow client (McpHosts) shares the SAME env-overridable value
    // as the typed TextStackApiClient — no drift.
    internal static double McpTimeoutSeconds()
    {
        var raw = Environment.GetEnvironmentVariable("TEXTSTACK_MCP_TIMEOUT_SECONDS");
        if (double.TryParse(raw, out var seconds) && seconds > 0)
            return seconds;

        return 15;
    }
}
