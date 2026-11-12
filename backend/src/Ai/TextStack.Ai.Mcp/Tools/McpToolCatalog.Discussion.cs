using System.Text;
using System.Text.Json;
using Contracts.V2;
using TextStack.Ai.Mcp.Http;
using static Contracts.V2.SyncLimits;

namespace TextStack.Ai.Mcp.Tools;

/// <summary>
/// The discussion tools (docs/internal/v2/mcp-discussion-checkpoints.md "Proposed MCP contract"),
/// registered only on the V2 sync API (<see cref="McpBridgeOptions.V2"/>). The writes take
/// <c>operationId</c> from the host (owner decision 13), so a retried call replays. The schemas read
/// the server's caps (<see cref="SyncLimits"/>); the server re-checks.
/// </summary>
public sealed partial class McpToolCatalog
{
    private const int DefaultCheckpointPage = 20;

    private static readonly JsonElement NoNotes = JsonDocument.Parse("[]").RootElement;

    private static readonly JsonElement ShareChapterSchema = JsonDocument.Parse(
        $$"""
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": {{MaxChapterKey}} },
            "chapterTitle": { "type": "string", "maxLength": {{MaxChapterTitle}} },
            "chapterText": { "type": "string", "minLength": 1, "maxLength": {{MaxChapterTextBytes}} },
            "notes": { "type": "array" },
            "language": { "type": "string", "maxLength": {{MaxLanguage}} },
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
                || !ArgReader.TryRequiredString(obj, "chapterKey", 1, MaxChapterKey, out var chapterKey, out err)
                || !ArgReader.TryOptionalString(obj, "chapterTitle", MaxChapterTitle, out var chapterTitle, out err)
                || !ArgReader.TryRequiredString(obj, "chapterText", 1, MaxChapterTextBytes, out var chapterText, out err)
                || !ArgReader.TryOptionalArray(obj, "notes", out var notes, out err)
                || !ArgReader.TryOptionalString(obj, "language", MaxLanguage, out var language, out err))
                return Task.FromResult(Error(err));
            // The server's cap is UTF-8 bytes; the schema's maxLength can only say characters.
            if (Encoding.UTF8.GetByteCount(chapterText) > MaxChapterTextBytes)
                return Task.FromResult(Error($"'chapterText' must be at most {MaxChapterTextBytes / 1024} KB as UTF-8."));

            return InvokeAsync("share_chapter", ct, async () =>
            {
                // ponytail: no fileId — the bridge does not know file versions, so an MCP checkpoint cannot name
                // a share the app made with one (422 share_mismatch); #1098.
                var shared = await api.ShareChapterAsync(bookId,
                    new ShareChapterRequest(operationId, null, chapterKey, chapterTitle, chapterText, notes ?? NoNotes, language), ct);
                if (Refused("share_chapter", shared, bookId) is { } refused) return refused;
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
        $$"""
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "topic": { "type": "string", "minLength": 1, "maxLength": {{MaxTopic}} },
            "readerThoughts": { "type": "array", "maxItems": {{MaxSectionItems}}, "items": { "type": "string", "minLength": 1 } },
            "assistantSuggestions": { "type": "array", "maxItems": {{MaxSectionItems}}, "items": { "type": "string", "minLength": 1 } },
            "conclusions": { "type": "array", "maxItems": {{MaxSectionItems}}, "items": { "type": "string", "minLength": 1 } },
            "openQuestions": { "type": "array", "maxItems": {{MaxSectionItems}}, "items": { "type": "string", "minLength": 1 } },
            "language": { "type": "string", "minLength": 1, "maxLength": {{MaxLanguage}} },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": {{MaxChapterKey}} },
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
                || !ArgReader.TryRequiredString(obj, "topic", 1, MaxTopic, out var topic, out err)
                || !ArgReader.TryRequiredString(obj, "language", 1, MaxLanguage, out var language, out err)
                || !ArgReader.TryOptionalStringArray(obj, "readerThoughts", MaxSectionItems, out var readerThoughts, out err)
                || !ArgReader.TryOptionalStringArray(obj, "assistantSuggestions", MaxSectionItems, out var assistantSuggestions, out err)
                || !ArgReader.TryOptionalStringArray(obj, "conclusions", MaxSectionItems, out var conclusions, out err)
                || !ArgReader.TryOptionalStringArray(obj, "openQuestions", MaxSectionItems, out var openQuestions, out err)
                || !ArgReader.TryOptionalString(obj, "chapterKey", MaxChapterKey, out var chapterKey, out err)
                || !ArgReader.TryOptionalGuid(obj, "sharedChapterId", out var sharedChapterId, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("save_checkpoint", ct, async () =>
            {
                var saved = await api.SaveCheckpointAsync(bookId, new CheckpointRequest(
                    operationId, topic, readerThoughts, assistantSuggestions, conclusions, openQuestions,
                    language, chapterKey, null, sharedChapterId), ct);
                if (Refused("save_checkpoint", saved, bookId) is { } refused) return refused;
                return Text(JsonSerializer.Serialize(new { id = saved.Value.GetProperty("id"), createdAt = saved.Value.GetProperty("createdAt"), saved = true }, UnescapedJson));
            });
        },
    };

    private static readonly JsonElement ListCheckpointsSchema = JsonDocument.Parse(
        $$"""
        {
          "type": "object",
          "properties": {
            "bookId": { "type": "string", "format": "uuid" },
            "chapterKey": { "type": "string", "minLength": 1, "maxLength": {{MaxChapterKey}} },
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
                || !ArgReader.TryOptionalString(obj, "chapterKey", MaxChapterKey, out var chapterKey, out err)
                || !ArgReader.TryOptionalString(obj, "cursor", 200, out var cursor, out err)
                || !ArgReader.TryOptionalInt(obj, "limit", 1, 100, out var limit, out err))
                return Task.FromResult(Error(err));

            return InvokeAsync("list_checkpoints", ct, async () =>
            {
                var listed = await api.ListCheckpointsAsync(bookId, chapterKey, cursor, limit ?? DefaultCheckpointPage, ct);
                // The page as the server answers it: items, cursor, hasMore.
                return Refused("list_checkpoints", listed, bookId) ?? Text(JsonSerializer.Serialize(listed.Value, UnescapedJson));
            });
        },
    };
}
