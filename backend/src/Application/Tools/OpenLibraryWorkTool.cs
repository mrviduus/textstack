using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Core;

namespace Application.Tools;

/// <summary>
/// Enrichment agent tool (AI-Agent-1): fetches a single Open Library <i>work</i> by its key (from
/// <see cref="OpenLibrarySearchTool"/>) for its description + subjects — the source of a sourced book
/// blurb. Same resilience contract as the search tool: missing description / error / timeout come back
/// as data (<c>found:false</c>). Open Library descriptions are either a plain string or a
/// <c>{type, value}</c> object; both are handled and sanitized before reaching the model.
/// </summary>
public sealed class OpenLibraryWorkTool : ITool
{
    private const int MaxSubjects = 8;
    private const int MaxDescriptionChars = 1500;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private static readonly JsonElement Schema = ToolJson.Schema("""
        {
          "type": "object",
          "properties": {
            "olWorkKey": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100,
              "description": "Open Library work key from search_open_library, e.g. '/works/OL45804W' or 'OL45804W'."
            }
          },
          "required": ["olWorkKey"],
          "additionalProperties": false
        }
        """);

    public string Name => "get_open_library_work";

    public string Description =>
        "Fetch an Open Library work's description and subjects by its work key (from search_open_library). " +
        "Use after searching, when you need a sourced description or richer subject list for the genre.";

    public JsonElement ArgsSchema => Schema;

    public async Task<JsonElement> InvokeAsync(JsonElement args, ToolContext ctx, CancellationToken ct)
    {
        var rawKey = ToolJson.GetString(args, "olWorkKey")!.Trim(); // shape guaranteed by schema validation
        var key = NormalizeKey(rawKey);
        if (key is null)
            return NoResult(rawKey, "Malformed Open Library work key.");

        var client = ctx.Services.GetRequiredService<IHttpClientFactory>().CreateClient(OpenLibrarySearchTool.HttpClientName);
        client.Timeout = Timeout;
        client.DefaultRequestHeaders.UserAgent.ParseAdd("TextStack/1.0 (+https://textstack.app)");

        var url = $"https://openlibrary.org/works/{Uri.EscapeDataString(key)}.json";
        try
        {
            using var response = await client.GetAsync(url, ct);
            if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
                return NoResult(rawKey, $"No Open Library work '{key}'.");
            if (!response.IsSuccessStatusCode)
                return NoResult(rawKey, $"Open Library returned {(int)response.StatusCode}.");

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            return ParseWork(doc.RootElement, rawKey);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return NoResult(rawKey, "Open Library unreachable.");
        }
    }

    /// <summary>Compacts an Open Library work payload to description + subjects. Pure — unit-tested.</summary>
    public static JsonElement ParseWork(JsonElement payload, string key)
    {
        if (payload.ValueKind != JsonValueKind.Object)
            return NoResult(key, "Empty work payload.");

        var description = ReadDescription(payload);
        var subjects = new List<string>();
        if (payload.TryGetProperty("subjects", out var subs) && subs.ValueKind == JsonValueKind.Array)
        {
            foreach (var v in subs.EnumerateArray().Take(MaxSubjects))
            {
                if (v.ValueKind == JsonValueKind.String && ExternalTextSanitizer.Clean(v.GetString()) is { Length: > 0 } s)
                    subjects.Add(s);
            }
        }

        var title = payload.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String
            ? ExternalTextSanitizer.Clean(t.GetString())
            : null;

        return ToolJson.Result(new { found = true, key, title, description, subjects });
    }

    /// <summary>Open Library description is either a string or a {type,value} object. Sanitize + truncate.</summary>
    private static string? ReadDescription(JsonElement work)
    {
        if (!work.TryGetProperty("description", out var d))
            return null;
        var raw = d.ValueKind switch
        {
            JsonValueKind.String => d.GetString(),
            JsonValueKind.Object when d.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String
                => v.GetString(),
            _ => null,
        };
        var cleaned = ExternalTextSanitizer.Clean(raw);
        if (string.IsNullOrEmpty(cleaned)) return null;
        return cleaned.Length > MaxDescriptionChars ? cleaned[..MaxDescriptionChars] : cleaned;
    }

    /// <summary>Accepts "OL45804W" or "/works/OL45804W"; rejects anything else (defensive, untrusted input).</summary>
    public static string? NormalizeKey(string raw)
    {
        var k = raw.Trim();
        if (k.StartsWith("/works/", StringComparison.OrdinalIgnoreCase))
            k = k["/works/".Length..];
        k = k.Trim('/');
        if (k.Length is 0 or > 50) return null;
        foreach (var c in k)
            if (!char.IsLetterOrDigit(c)) return null;
        return k;
    }

    private static JsonElement NoResult(string key, string message) =>
        ToolJson.Result(new { found = false, key, message });
}
