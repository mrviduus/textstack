using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;

namespace Application.Tools;

/// <summary>
/// Enrichment agent tool (AI-Agent-1): searches Open Library's keyless catalog for a title (+ optional
/// author) and returns the top few candidate works — their author(s), first-publish year, subjects and
/// the work key the agent passes to <see cref="OpenLibraryWorkTool"/> for a description. Following the
/// tool-error-as-data shape, "no match" / HTTP error / timeout are returned as data
/// (<c>found:false</c>), never thrown, so the agent degrades to its own knowledge instead of dying.
/// External text is untrusted: every free-text field is run through <see cref="ExternalTextSanitizer"/>
/// before it can reach the model as an observation.
/// </summary>
public sealed class OpenLibrarySearchTool : ITool
{
    private const int MaxResults = 3;
    private const int MaxSubjects = 8;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private static readonly JsonElement Schema = ToolJson.Schema("""
        {
          "type": "object",
          "properties": {
            "title": { "type": "string", "minLength": 1, "maxLength": 300, "description": "Book title to search for." },
            "author": { "type": "string", "maxLength": 200, "description": "Author name to narrow the search (optional)." }
          },
          "required": ["title"],
          "additionalProperties": false
        }
        """);

    public string Name => "search_open_library";

    public string Description =>
        "Search the Open Library catalog by title (and optional author) to verify a book's author, " +
        "first-publication year and subjects. Use when you are unsure about the year, genre or author, " +
        "or to cross-check your own guess. Returns up to a few candidate works.";

    public JsonElement ArgsSchema => Schema;

    public async Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct)
    {
        var title = ToolJson.GetString(args, "title")!.Trim(); // shape guaranteed by schema validation
        var author = ToolJson.GetString(args, "author")?.Trim();

        var client = ctx.Services.GetRequiredService<IHttpClientFactory>().CreateClient();
        client.Timeout = Timeout;
        // Open Library asks for a descriptive User-Agent (polite-use policy).
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TextStack/1.0 (+https://textstack.app)");

        var url = "https://openlibrary.org/search.json?fields=title,author_name,first_publish_year,subject,number_of_pages_median,key"
            + $"&limit={MaxResults}&title={Uri.EscapeDataString(title)}";
        if (!string.IsNullOrWhiteSpace(author))
            url += $"&author={Uri.EscapeDataString(author)}";

        try
        {
            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
                return NoResult(title, $"Open Library returned {(int)response.StatusCode}.");

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            return ParseSearch(doc.RootElement, title);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            // External outage / timeout is data, not a crash — the agent falls back to its own knowledge.
            return NoResult(title, "Open Library unreachable.");
        }
    }

    /// <summary>Compacts the Open Library <c>search.json</c> payload to the agent-relevant fields. Pure — unit-tested.</summary>
    public static JsonElement ParseSearch(JsonElement payload, string title)
    {
        if (payload.ValueKind != JsonValueKind.Object
            || !payload.TryGetProperty("docs", out var docs)
            || docs.ValueKind != JsonValueKind.Array
            || docs.GetArrayLength() == 0)
            return NoResult(title, $"No Open Library match for '{title}'.");

        var results = new List<object>();
        foreach (var d in docs.EnumerateArray().Take(MaxResults))
        {
            var authors = StringArray(d, "author_name", limit: 3);
            var subjects = StringArray(d, "subject", limit: MaxSubjects);
            int? year = d.TryGetProperty("first_publish_year", out var y) && y.ValueKind == JsonValueKind.Number
                ? y.GetInt32()
                : null;
            int? pages = d.TryGetProperty("number_of_pages_median", out var p) && p.ValueKind == JsonValueKind.Number
                ? p.GetInt32()
                : null;
            var key = d.TryGetProperty("key", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() : null;

            results.Add(new
            {
                title = ExternalTextSanitizer.Clean(
                    d.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null),
                authors,
                firstPublishYear = year,
                subjects,
                medianPages = pages,
                // OL search keys look like "/works/OL45804W"; the work tool accepts the bare or full form.
                olWorkKey = key,
            });
        }

        return ToolJson.Result(new { found = true, results });
    }

    private static List<string> StringArray(JsonElement doc, string name, int limit)
    {
        var list = new List<string>();
        if (doc.TryGetProperty(name, out var arr) && arr.ValueKind == JsonValueKind.Array)
        {
            foreach (var v in arr.EnumerateArray().Take(limit))
            {
                if (v.ValueKind == JsonValueKind.String && ExternalTextSanitizer.Clean(v.GetString()) is { Length: > 0 } s)
                    list.Add(s);
            }
        }
        return list;
    }

    private static JsonElement NoResult(string title, string message) =>
        ToolJson.Result(new { found = false, title, message });
}
