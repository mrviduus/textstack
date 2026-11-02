using Api.Extensions;
using Api.V2;
using Application.Annotations;
using Application.Auth;
using Application.Discussion;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Application.Vocabulary;
using Contracts.V2;

namespace Api.Endpoints;

/// <summary>
/// The V2 sync API, the M2.2–M2.4 rows of v2-sync-protocol.md "Endpoints": library, reading,
/// annotations, vocabulary, shares and checkpoints under <c>/me/v2</c> (a temporary prefix, renamed at M5.4). Mapped only with <c>Features:V2Api</c>
/// on, so with it off the stack is exactly as before (404, and old clients never see a V2 body).
/// Every route sits behind <see cref="V2Gate"/>: V2 readiness (#1053), the legacy account, then the
/// session user's V2 shadow row — M2.2's bridge to the legacy accounts, removed by M2.5, whose rows
/// the M3 ETL upserts. A user or guest session is required (PathGates, ADR-014). Handlers write a use
/// case's <see cref="SyncResult"/> and nothing else.
/// </summary>
public static class V2Endpoints
{
    /// <summary>PDD "File sync upload protocol": a part fits one request under Cloudflare's cap.</summary>
    private const long DefaultMaxPartBytes = 80L * 1024 * 1024;

    public static void MapV2Endpoints(this WebApplication app)
    {
        if (!app.Configuration.GetValue<bool>("Features:V2Api")) return;

        var v2 = app.MapGroup("/me/v2").WithTags("V2 sync").AddEndpointFilter<V2Gate>();
        var status = Results.Ok(new V2StatusDto(app.Configuration.GetValue("V2:MaxPartBytes", DefaultMaxPartBytes)));
        v2.MapGet("/status", () => status);

        v2.MapGet("/library/changes", (HttpContext h, AuthService a, LibrarySyncService s, string? cursor, string? limit, CancellationToken ct) =>
            Send(s.ChangesAsync(User(h, a), cursor, limit, ct)));
        v2.MapGet("/books/by-sha256/{sha256}", (HttpContext h, AuthService a, LibrarySyncService s, string sha256, CancellationToken ct) =>
            Send(s.FindBySha256Async(User(h, a), sha256, ct)));
        v2.MapPut("/books/{bookId:guid}", (HttpContext h, AuthService a, LibrarySyncService s, Guid bookId, ImportBookRequest body, CancellationToken ct) =>
            Send(s.ImportAsync(User(h, a), bookId, body, ct)));
        v2.MapPatch("/books/{bookId:guid}", (HttpContext h, AuthService a, LibrarySyncService s, Guid bookId, PatchBookRequest body, CancellationToken ct) =>
            Send(s.UpdateMetadataAsync(User(h, a), bookId, body, ct)));
        v2.MapPut("/books/{bookId:guid}/files/{fileId:guid}", (HttpContext h, AuthService a, LibrarySyncService s, Guid bookId, Guid fileId, ReplaceFileRequest body, CancellationToken ct) =>
            Send(s.ReplaceFileAsync(User(h, a), bookId, fileId, body, ct)));
        v2.MapDelete("/books/{bookId:guid}", (HttpContext h, AuthService a, LibrarySyncService s, Guid bookId, CancellationToken ct) =>
            Send(s.RemoveAsync(User(h, a), bookId, ct)));
        v2.MapPost("/books/{bookId:guid}/restore", (HttpContext h, AuthService a, LibrarySyncService s, Guid bookId, CancellationToken ct) =>
            Send(s.RestoreAsync(User(h, a), bookId, ct)));

        v2.MapGet("/reading/changes", (HttpContext h, AuthService a, ReadingSyncService s, string? cursor, string? limit, CancellationToken ct) =>
            Send(s.ChangesAsync(User(h, a), cursor, limit, ct)));
        v2.MapGet("/books/{bookId:guid}/reading-state", (HttpContext h, AuthService a, ReadingSyncService s, Guid bookId, CancellationToken ct) =>
            Send(s.GetAsync(User(h, a), bookId, ct)));
        v2.MapPut("/books/{bookId:guid}/reading-state", (HttpContext h, AuthService a, ReadingSyncService s, Guid bookId, ReadingStateRequest body, CancellationToken ct) =>
            Send(s.WriteAsync(User(h, a), bookId, body, ct)));
        v2.MapPost("/books/{bookId:guid}/reading-state/reset", (HttpContext h, AuthService a, ReadingSyncService s, Guid bookId, ResetReadingStateRequest body, CancellationToken ct) =>
            Send(s.ResetAsync(User(h, a), bookId, body, ct)));
        v2.MapPut("/reading/sessions/{clientSessionId:guid}", (HttpContext h, AuthService a, ReadingSyncService s, Guid clientSessionId, ReadingSessionRequest body, CancellationToken ct) =>
            Send(s.SaveSessionAsync(User(h, a), clientSessionId, body, ct)));

        v2.MapGet("/annotations/changes", (HttpContext h, AuthService a, AnnotationSyncService s, string? cursor, string? limit, CancellationToken ct) =>
            Send(s.ChangesAsync(User(h, a), cursor, limit, ct)));
        v2.MapPut("/annotations/{id:guid}", (HttpContext h, AuthService a, AnnotationSyncService s, Guid id, AnnotationRequest body, CancellationToken ct) =>
            Send(s.SaveAsync(User(h, a), id, body, ct)));
        v2.MapDelete("/annotations/{id:guid}", (HttpContext h, AuthService a, AnnotationSyncService s, Guid id, CancellationToken ct) =>
            Send(s.DeleteAsync(User(h, a), id, ct)));

        v2.MapGet("/vocabulary/changes", (HttpContext h, AuthService a, VocabularySyncService s, string? cursor, string? limit, CancellationToken ct) =>
            Send(s.ChangesAsync(User(h, a), cursor, limit, ct)));
        v2.MapGet("/vocabulary/due", (HttpContext h, AuthService a, VocabularySyncService s, string? limit, CancellationToken ct) =>
            Send(s.DueAsync(User(h, a), limit, ct)));
        v2.MapPut("/vocabulary/words", (HttpContext h, AuthService a, VocabularySyncService s, SaveVocabularyWordRequest body, CancellationToken ct) =>
            Send(s.SaveWordAsync(User(h, a), body, ct)));
        v2.MapGet("/vocabulary/words/{id:guid}", (HttpContext h, AuthService a, VocabularySyncService s, Guid id, CancellationToken ct) =>
            Send(s.GetWordAsync(User(h, a), id, ct)));
        v2.MapPatch("/vocabulary/words/{id:guid}", (HttpContext h, AuthService a, VocabularySyncService s, Guid id, PatchVocabularyWordRequest body, CancellationToken ct) =>
            Send(s.UpdateWordAsync(User(h, a), id, body, ct)));
        v2.MapDelete("/vocabulary/words/{id:guid}", (HttpContext h, AuthService a, VocabularySyncService s, Guid id, CancellationToken ct) =>
            Send(s.DeleteWordAsync(User(h, a), id, ct)));
        v2.MapPost("/vocabulary/words/{id:guid}/restore", (HttpContext h, AuthService a, VocabularySyncService s, Guid id, RestoreVocabularyWordRequest body, CancellationToken ct) =>
            Send(s.RestoreWordAsync(User(h, a), id, body, ct)));
        v2.MapPost("/vocabulary/words/{id:guid}/examples", (HttpContext h, AuthService a, VocabularySyncService s, Guid id, VocabularyExampleRequest body, CancellationToken ct) =>
            Send(s.AddExampleAsync(User(h, a), id, body, ct)));
        v2.MapPost("/vocabulary/reviews", (HttpContext h, AuthService a, VocabularySyncService s, VocabularyReviewRequest body, CancellationToken ct) =>
            Send(s.RecordReviewAsync(User(h, a), body, ct)));

        v2.MapPost("/books/{bookId:guid}/shares", (HttpContext h, AuthService a, DiscussionSyncService s, Guid bookId, ShareChapterRequest body, CancellationToken ct) =>
            Send(s.ShareAsync(User(h, a), bookId, body, ct)));
        v2.MapGet("/books/{bookId:guid}/shares", (HttpContext h, AuthService a, DiscussionSyncService s, Guid bookId, CancellationToken ct) =>
            Send(s.ListSharesAsync(User(h, a), bookId, ct)));
        v2.MapDelete("/shares/{id:guid}", (HttpContext h, AuthService a, DiscussionSyncService s, Guid id, CancellationToken ct) =>
            Send(s.DeleteShareAsync(User(h, a), id, ct)));
        v2.MapPost("/books/{bookId:guid}/checkpoints", (HttpContext h, AuthService a, DiscussionSyncService s, Guid bookId, CheckpointRequest body, CancellationToken ct) =>
            Send(s.SaveCheckpointAsync(User(h, a), bookId, body, ct)));
        v2.MapGet("/books/{bookId:guid}/checkpoints", (HttpContext h, AuthService a, DiscussionSyncService s, Guid bookId, string? chapterKey, string? cursor, string? limit, CancellationToken ct) =>
            Send(s.ListCheckpointsAsync(User(h, a), bookId, chapterKey, cursor, limit, ct)));
        v2.MapDelete("/checkpoints/{id:guid}", (HttpContext h, AuthService a, DiscussionSyncService s, Guid id, CancellationToken ct) =>
            Send(s.DeleteCheckpointAsync(User(h, a), id, ct)));
        v2.MapPut("/books/{bookId:guid}/checkpoint-saving", (HttpContext h, AuthService a, DiscussionSyncService s, Guid bookId, CheckpointSavingRequest body, CancellationToken ct) =>
            Send(s.SetCheckpointSavingAsync(User(h, a), bookId, body, ct)));
    }

    // PathGates and V2Gate resolved it already; GetUserId answers from the request's memo.
    private static Guid User(HttpContext http, AuthService auth) => http.GetUserId(auth)!.Value;

    private static async Task<IResult> Send(Task<SyncResult> pending)
    {
        var result = await pending;
        return result.Status == StatusCodes.Status204NoContent ? Results.NoContent() : Results.Json(result.Body, statusCode: result.Status);
    }
}
