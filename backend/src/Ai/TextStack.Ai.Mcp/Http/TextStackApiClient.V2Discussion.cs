using System.Text.Json;
using Contracts.V2;

namespace TextStack.Ai.Mcp.Http;

/// <summary>
/// The discussion tools' upstream, V2 only (<see cref="McpBridgeOptions.V2"/>): shares and checkpoints
/// under <c>/me/v2</c>. Answers come back as the server's JSON, a refusal as its message and status.
/// </summary>
public sealed partial class TextStackApiClient
{
    public Task<ApiResult<JsonElement>> ShareChapterAsync(Guid bookId, ShareChapterRequest share, CancellationToken ct) =>
        SendAsync(HttpMethod.Post, $"/me/v2/books/{bookId}/shares", share, ct);

    public Task<ApiResult<JsonElement>> SaveCheckpointAsync(Guid bookId, CheckpointRequest checkpoint, CancellationToken ct) =>
        SendAsync(HttpMethod.Post, $"/me/v2/books/{bookId}/checkpoints", checkpoint, ct);

    public Task<ApiResult<JsonElement>> ListCheckpointsAsync(Guid bookId, string? chapterKey, string? cursor, int limit, CancellationToken ct)
    {
        var url = $"/me/v2/books/{bookId}/checkpoints?limit={limit}"
            + (chapterKey is null ? "" : $"&chapterKey={Uri.EscapeDataString(chapterKey)}")
            + (cursor is null ? "" : $"&cursor={Uri.EscapeDataString(cursor)}");
        return SendAsync<object>(HttpMethod.Get, url, null, ct);
    }
}
