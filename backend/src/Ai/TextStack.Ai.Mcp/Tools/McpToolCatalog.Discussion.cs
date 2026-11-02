using System.Text.Json;
using Contracts.V2;
using ModelContextProtocol.Protocol;
using TextStack.Ai.Mcp.Http;

namespace TextStack.Ai.Mcp.Tools;

/// <summary>
/// The discussion tools (docs/01-architecture/mcp-discussion-checkpoints.md "Proposed MCP contract"),
/// registered only on the V2 sync API (<see cref="McpBridgeOptions.V2"/>). The writes take
/// <c>operationId</c> from the host (owner decision 13), so a retried call replays. The caps mirror the
/// server's (<c>DiscussionSyncService</c>, which this project cannot reference); the server re-checks.
/// </summary>
// ponytail: the tools send no fileId (the bridge does not know file versions), so an MCP checkpoint
// cannot name a share the app made with one (422 share_mismatch); there is no delete_checkpoint tool
// (REST only); and bookIds are V2 ids, so a legacy UserBook id answers book_not_found until the M3 ETL
// carries them over. All three: #1098.
public sealed partial class McpToolCatalog
{
    private const int MaxChapterTextChars = 200 * 1024;
    private const int MaxSectionItems = 50;
    private const int DefaultCheckpointPage = 20;

    private static readonly JsonElement NoNotes = JsonDocument.Parse("[]").RootElement;

    private static readonly JsonElement ShareChapterSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": 200 },
            "chapterTitle": { "type": "string", "maxLength": 500 },
            "chapterText": { "type": "string", "minLength": 1, "maxLength": 204800 },
            "notes": { "type": "array" },
            "language": { "type": "string", "maxLength": 16 },
            "operationId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId", "chapterKey", "chapterText", "operationId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildShareChapter(TextStackApiClient api) => new()
    {
        Name = "share_chapter",
        Title = "Share a chapter",
        ReadOnly = false,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("share_chapter"),
        InputSchema = ShareChapterSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "chapterKey", "chapterTitle", "chapterText", "notes", "language", "operationId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err)
                || !ArgReader.TryRequiredGuid(obj, "operationId", out var operationId, out err)
                || !ArgReader.TryRequiredString(obj, "chapterKey", 1, 200, out var chapterKey, out err)
                || !ArgReader.TryOptionalString(obj, "chapterTitle", 500, out var chapterTitle, out err)
                || !ArgReader.TryRequiredString(obj, "chapterText", 1, MaxChapterTextChars, out var chapterText, out err)
                || !TryOptionalArray(obj, "notes", out var notes, out err)
                || !ArgReader.TryOptionalString(obj, "language", 16, out var language, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("share_chapter", ct, async () =>
            {
                var shared = await api.ShareChapterAsync(bookId,
                    new ShareChapterRequest(operationId, null, chapterKey, chapterTitle, chapterText, notes ?? NoNotes, language), ct);
                if (Refused("share_chapter", bookId, shared) is { } refused) return refused;
                var share = shared.Value;
                return Text(JsonSerializer.Serialize(new
                {
                    id = share.GetProperty("id"),
                    chapterKey = share.GetProperty("chapterKey"),
                    createdAt = share.GetProperty("createdAt"),
                    saved = true,
                }, UnescapedJson));
            });
        },
    };

    private static readonly JsonElement SaveCheckpointSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "topic": { "type": "string", "minLength": 1, "maxLength": 500 },
            "readerThoughts": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1 } },
            "assistantSuggestions": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1 } },
            "conclusions": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1 } },
            "openQuestions": { "type": "array", "maxItems": 50, "items": { "type": "string", "minLength": 1 } },
            "language": { "type": "string", "minLength": 1, "maxLength": 16 },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": 200 },
            "sharedChapterId": { "type": "string", "format": "uuid" },
            "operationId": { "type": "string", "format": "uuid" }
          },
          "required": ["bookId", "topic", "language", "operationId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildSaveCheckpoint(TextStackApiClient api) => new()
    {
        Name = "save_checkpoint",
        Title = "Save a discussion checkpoint",
        ReadOnly = false,
        Idempotent = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("save_checkpoint"),
        InputSchema = SaveCheckpointSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "topic", "readerThoughts", "assistantSuggestions",
                    "conclusions", "openQuestions", "language", "chapterKey", "sharedChapterId", "operationId")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err)
                || !ArgReader.TryRequiredGuid(obj, "operationId", out var operationId, out err)
                || !ArgReader.TryRequiredString(obj, "topic", 1, 500, out var topic, out err)
                || !ArgReader.TryRequiredString(obj, "language", 1, 16, out var language, out err)
                || !TryOptionalStrings(obj, "readerThoughts", out var readerThoughts, out err)
                || !TryOptionalStrings(obj, "assistantSuggestions", out var assistantSuggestions, out err)
                || !TryOptionalStrings(obj, "conclusions", out var conclusions, out err)
                || !TryOptionalStrings(obj, "openQuestions", out var openQuestions, out err)
                || !ArgReader.TryOptionalString(obj, "chapterKey", 200, out var chapterKey, out err)
                || !ArgReader.TryOptionalGuid(obj, "sharedChapterId", out var sharedChapterId, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("save_checkpoint", ct, async () =>
            {
                var saved = await api.SaveCheckpointAsync(bookId, new CheckpointRequest(
                    operationId, topic, readerThoughts, assistantSuggestions, conclusions, openQuestions,
                    language, chapterKey, null, sharedChapterId), ct);
                if (Refused("save_checkpoint", bookId, saved) is { } refused) return refused;
                return Text(JsonSerializer.Serialize(new { id = saved.Value.GetProperty("id"), createdAt = saved.Value.GetProperty("createdAt"), saved = true }, UnescapedJson));
            });
        },
    };

    private static readonly JsonElement ListCheckpointsSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": 200 },
            "cursor": { "type": "string", "maxLength": 200 },
            "limit": { "type": "integer", "minimum": 1, "maximum": 100 }
          },
          "required": ["bookId"],
          "additionalProperties": false
        }
        """).RootElement;

    private McpToolDescriptor BuildListCheckpoints(TextStackApiClient api) => new()
    {
        Name = "list_checkpoints",
        Title = "List discussion checkpoints",
        ReadOnly = true,
        Description = global::Contracts.Mcp.McpManifestCatalog.Describe("list_checkpoints"),
        InputSchema = ListCheckpointsSchema,
        Handler = (args, ct) =>
        {
            if (!ArgReader.TryObject(args, out var obj, out var err, "bookId", "chapterKey", "cursor", "limit")
                || !ArgReader.TryRequiredGuid(obj, "bookId", out var bookId, out err)
                || !ArgReader.TryOptionalString(obj, "chapterKey", 200, out var chapterKey, out err)
                || !ArgReader.TryOptionalString(obj, "cursor", 200, out var cursor, out err)
                || !ArgReader.TryOptionalInt(obj, "limit", 1, 100, out var limit, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("list_checkpoints", ct, async () =>
            {
                var listed = await api.ListCheckpointsAsync(bookId, chapterKey, cursor, limit ?? DefaultCheckpointPage, ct);
                if (Refused("list_checkpoints", bookId, listed) is { } refused) return refused;
                var page = listed.Value;
                return Text(JsonSerializer.Serialize(new
                {
                    checkpoints = page.GetProperty("items"),
                    cursor = page.GetProperty("cursor"),
                    hasMore = page.GetProperty("hasMore"),
                }, UnescapedJson));
            });
        },
    };

    /// <summary>
    /// <c>book_not_found</c> names the book; any other refusal relays the server's message (a bare 404
    /// is a server with the V2 API off: "upstream answered 404", as the vocabulary half says it).
    /// </summary>
    private static CallToolResult? Refused(string tool, Guid bookId, ApiResult<JsonElement> result) =>
        result.Error is not { } message ? null
        : result.Code == "book_not_found" ? Error($"{tool}: no uploaded book with id '{bookId}' in the user's library")
        : Error($"{tool} refused: {message}");

    private static bool TryOptionalArray(JsonElement obj, string name, out JsonElement? value, out string error)
    {
        value = null;
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
        if (el.ValueKind != JsonValueKind.Array)
        {
            error = $"'{name}' must be an array.";
            return false;
        }
        value = el;
        return true;
    }

    /// <summary>A checkpoint section: absent or null is empty; else at most 50 non-blank strings (the schema's minLength), order kept.</summary>
    private static bool TryOptionalStrings(JsonElement obj, string name, out string[] value, out string error)
    {
        value = [];
        error = "";
        if (!obj.TryGetProperty(name, out var el) || el.ValueKind == JsonValueKind.Null) return true;
        if (el.ValueKind != JsonValueKind.Array || el.GetArrayLength() > MaxSectionItems
            || el.EnumerateArray().Any(i => i.ValueKind != JsonValueKind.String))
        {
            error = $"'{name}' must be an array of at most {MaxSectionItems} strings.";
            return false;
        }
        var items = el.EnumerateArray().Select(i => i.GetString()!).ToArray();
        var blank = Array.FindIndex(items, string.IsNullOrWhiteSpace);
        if (blank >= 0)
        {
            error = $"'{name}[{blank}]' must not be blank.";
            return false;
        }
        value = items;
        return true;
    }
}
