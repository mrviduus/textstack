using Api.Middleware;
using Api.V2;
using Application.Annotations;
using Application.Library;
using Application.Reading;
using Application.Sync;
using Contracts.V2;

namespace Api.Endpoints;

/// <summary>
/// The V2 sync API, M2.2's rows of v2-sync-protocol.md "Endpoints": library, reading and annotations
/// under <c>/me/v2</c> (a temporary prefix, renamed at M5.4). Mapped only with <c>Features:V2Api</c>
/// on, so with it off the stack is exactly as before (404, and old clients never see a V2 body).
/// Every route sits behind <see cref="V2Gate"/>: V2 readiness (#1053), then the session user's V2
/// shadow row — M2.2's bridge to the legacy accounts, removed by M2.5, whose rows the M3 ETL upserts.
/// A user or guest session is required (PathGates, ADR-014). Handlers map a use case's
/// <see cref="SyncResult"/> to HTTP and nothing else.
/// </summary>
public static class V2Endpoints
{
    /// <summary>PDD "File sync upload protocol": a part fits one request under Cloudflare's cap.</summary>
    private const long DefaultMaxPartBytes = 80L * 1024 * 1024;

    // ponytail: a body that is not JSON of the request's shape is the framework's bare 400, not an
    // invalid_payload body; a binding-failure handler for /me/v2 if a client ever needs the field.
    public static void MapV2Endpoints(this WebApplication app)
    {
        if (!app.Configuration.GetValue<bool>("Features:V2Api")) return;

        var v2 = app.MapGroup("/me/v2").WithTags("V2 sync").AddEndpointFilter<V2Gate>();
        var maxPartBytes = app.Configuration.GetValue("V2:MaxPartBytes", DefaultMaxPartBytes);
        v2.MapGet("/status", () => Results.Ok(new V2StatusDto(maxPartBytes)));

        v2.MapGet("/library/changes", (HttpContext h, string? cursor, string? limit) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.ChangesAsync(user, cursor, limit, ct)));
        v2.MapGet("/books/by-sha256/{sha256}", (HttpContext h, string sha256) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.FindBySha256Async(user, sha256, ct)));
        v2.MapPut("/books/{bookId:guid}", (HttpContext h, Guid bookId, ImportBookRequest body) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.ImportAsync(user, bookId, body, ct)));
        v2.MapPatch("/books/{bookId:guid}", (HttpContext h, Guid bookId, PatchBookRequest body) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.UpdateMetadataAsync(user, bookId, body, ct)));
        v2.MapPut("/books/{bookId:guid}/files/{fileId:guid}", (HttpContext h, Guid bookId, Guid fileId, ReplaceFileRequest body) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.ReplaceFileAsync(user, bookId, fileId, body, ct)));
        v2.MapDelete("/books/{bookId:guid}", (HttpContext h, Guid bookId) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.RemoveAsync(user, bookId, ct)));
        v2.MapPost("/books/{bookId:guid}/restore", (HttpContext h, Guid bookId) =>
            Run<LibrarySyncService>(h, (s, user, ct) => s.RestoreAsync(user, bookId, ct)));

        v2.MapGet("/reading/changes", (HttpContext h, string? cursor, string? limit) =>
            Run<ReadingSyncService>(h, (s, user, ct) => s.ChangesAsync(user, cursor, limit, ct)));
        v2.MapGet("/books/{bookId:guid}/reading-state", (HttpContext h, Guid bookId) =>
            Run<ReadingSyncService>(h, (s, user, ct) => s.GetAsync(user, bookId, ct)));
        v2.MapPut("/books/{bookId:guid}/reading-state", (HttpContext h, Guid bookId, ReadingStateRequest body) =>
            Run<ReadingSyncService>(h, (s, user, ct) => s.WriteAsync(user, bookId, body, ct)));
        v2.MapPost("/books/{bookId:guid}/reading-state/reset", (HttpContext h, Guid bookId, ResetReadingStateRequest body) =>
            Run<ReadingSyncService>(h, (s, user, ct) => s.ResetAsync(user, bookId, body, ct)));
        v2.MapPut("/reading/sessions/{clientSessionId:guid}", (HttpContext h, Guid clientSessionId, ReadingSessionRequest body) =>
            Run<ReadingSyncService>(h, (s, user, ct) => s.SaveSessionAsync(user, clientSessionId, body, ct)));

        v2.MapGet("/annotations/changes", (HttpContext h, string? cursor, string? limit) =>
            Run<AnnotationSyncService>(h, (s, user, ct) => s.ChangesAsync(user, cursor, limit, ct)));
        v2.MapPut("/annotations/{id:guid}", (HttpContext h, Guid id, AnnotationRequest body) =>
            Run<AnnotationSyncService>(h, (s, user, ct) => s.SaveAsync(user, id, body, ct)));
        v2.MapDelete("/annotations/{id:guid}", (HttpContext h, Guid id) =>
            Run<AnnotationSyncService>(h, (s, user, ct) => s.DeleteAsync(user, id, ct)));
    }

    /// <summary>
    /// The use case is resolved here, not bound as a handler parameter: binding runs before
    /// <see cref="V2Gate"/>, and without <c>ConnectionStrings:V2</c> resolving a V2 repository throws,
    /// which would turn the gate's 503 into a 500.
    /// </summary>
    private static Task<IResult> Run<TService>(HttpContext http, Func<TService, Guid, CancellationToken, Task<SyncResult>> call)
        where TService : notnull =>
        Send(call(http.RequestServices.GetRequiredService<TService>(), PathGates.UserOf(http), http.RequestAborted));

    private static async Task<IResult> Send(Task<SyncResult> pending)
    {
        var result = await pending;
        return result.Status switch
        {
            SyncStatus.NoContent => Results.NoContent(),
            _ => Results.Json(result.Body, statusCode: result.Status switch
            {
                SyncStatus.Ok => StatusCodes.Status200OK,
                SyncStatus.Created => StatusCodes.Status201Created,
                SyncStatus.BadRequest => StatusCodes.Status400BadRequest,
                SyncStatus.NotFound => StatusCodes.Status404NotFound,
                _ => StatusCodes.Status409Conflict,
            }),
        };
    }
}
