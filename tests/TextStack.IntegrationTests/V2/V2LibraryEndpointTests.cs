using System.Net;
using static TextStack.IntegrationTests.V2.V2ApiFixture;

namespace TextStack.IntegrationTests.V2;

/// <summary>v2-sync-protocol.md "Endpoints", the library rows, against the running stack (V2 mode, <see cref="V2ApiFixture"/>).</summary>
public class V2LibraryEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    [Fact]
    public async Task Status_UserAndGuest_AnswerMaxPartBytes()
    {
        v2.Require();

        var user = await v2.SendAsync(v2.Alice, HttpMethod.Get, "/me/v2/status");
        var guest = await v2.SendAsync(await v2.NewGuestAsync(), HttpMethod.Get, "/me/v2/status");

        Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK), (user.Status, guest.Status));
        Assert.True(user.Body.GetProperty("maxPartBytes").GetInt64() > 0);
    }

    [Fact]
    public async Task Import_ThenReplay_ThenTheSameBytesUnderANewId_Is201Then200ThenDuplicateFile()
    {
        v2.Require();
        var (bookId, fileId, sha256) = (Guid.NewGuid(), Guid.NewGuid(), NewSha256());
        var book = new { title = "Replayed", file = File(fileId, sha256) };

        var created = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}", book);
        var replay = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}", book);
        var duplicate = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{Guid.NewGuid()}", new { title = "Again", file = File(Guid.NewGuid(), sha256) });

        Assert.Equal((HttpStatusCode.Created, fileId), (created.Status, created.Body.GetProperty("currentFile").GetProperty("id").GetGuid()));
        Assert.False(created.Body.TryGetProperty("origin", out _));
        Assert.Equal((HttpStatusCode.OK, bookId), (replay.Status, replay.Body.GetProperty("id").GetGuid()));
        Assert.Equal((HttpStatusCode.Conflict, "duplicate_file", bookId), (duplicate.Status, duplicate.Code, duplicate.Body.GetProperty("current").GetProperty("id").GetGuid()));
    }

    [Fact]
    public async Task Import_UppercaseSha256_IsInvalidPayloadNamingTheField()
    {
        v2.Require();

        var response = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{Guid.NewGuid()}",
            new { title = "Shouting", file = File(Guid.NewGuid(), NewSha256().ToUpperInvariant()) });

        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload", "file.sha256"), (response.Status, response.Code, response.Body.GetProperty("field").GetString()));
    }

    [Fact]
    public async Task Import_TitleWithANulAndBySha256WithATrailingNewline_AreInvalidPayloadNotServerErrors()
    {
        v2.Require();

        var nul = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{Guid.NewGuid()}", new { title = "A\u0000B", file = File(Guid.NewGuid()) });
        var newline = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/by-sha256/{NewSha256()}%0A");

        Assert.Equal((HttpStatusCode.BadRequest, "title"), (nul.Status, nul.Body.GetProperty("field").GetString()));
        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload"), (newline.Status, newline.Code));
    }

    [Fact]
    public async Task BySha256_OwnBytesAndAnotherUsers_Are200And404()
    {
        v2.Require();
        var (bookId, _, sha256) = await v2.ImportAsync(v2.Alice);

        var own = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/by-sha256/{sha256}");
        var bobs = await v2.SendAsync(v2.Bob, HttpMethod.Get, $"/me/v2/books/by-sha256/{sha256}");

        Assert.Equal((HttpStatusCode.OK, bookId), (own.Status, own.Body.GetProperty("id").GetGuid()));
        Assert.Equal(HttpStatusCode.NotFound, bobs.Status);
    }

    [Fact]
    public async Task Patch_MatchingThenStaleRevision_Is200ThenStaleRevisionWithTheWinner()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var first = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"/me/v2/books/{bookId}", new { expectedRevision = 1, title = "Renamed", author = "Someone" });
        var stale = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"/me/v2/books/{bookId}", new { expectedRevision = 1, title = "Other device" });
        var cleared = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"/me/v2/books/{bookId}", new { expectedRevision = 2, author = (string?)null });

        Assert.Equal((HttpStatusCode.OK, 2L, "Renamed"), (first.Status, first.Body.GetProperty("revision").GetInt64(), first.Body.GetProperty("title").GetString()));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision", 2L), (stale.Status, stale.Code, stale.Body.GetProperty("revision").GetInt64()));
        Assert.Equal(("Renamed", System.Text.Json.JsonValueKind.Null), (cleared.Body.GetProperty("title").GetString(), cleared.Body.GetProperty("author").ValueKind));
    }

    [Fact]
    public async Task Patch_BookOfAnotherUser_IsBookNotFound()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var response = await v2.SendAsync(v2.Bob, HttpMethod.Patch, $"/me/v2/books/{bookId}", new { expectedRevision = 1, title = "bob's" });

        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (response.Status, response.Code));
    }

    [Fact]
    public async Task ReplaceFile_WrongThenRightReplacesFileId_IsFileReplacedThenCurrentAndSupersededThenReplay()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var newFile = Guid.NewGuid();
        var replacement = (Guid? replaces) => new { replacesFileId = replaces, sha256 = NewSha256(), byteSize = 2048, originalName = "v2.epub", format = "epub" };

        var wrong = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{newFile}", replacement(Guid.NewGuid()));
        var right = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{newFile}", replacement(fileId));
        var replay = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{newFile}", replacement(fileId));

        Assert.Equal((HttpStatusCode.Conflict, "file_replaced", fileId), (wrong.Status, wrong.Code, wrong.Body.GetProperty("currentFile").GetProperty("id").GetGuid()));
        Assert.Equal((HttpStatusCode.OK, newFile, fileId), (right.Status,
            right.Body.GetProperty("current").GetProperty("id").GetGuid(), right.Body.GetProperty("superseded").GetProperty("id").GetGuid()));
        Assert.Equal((HttpStatusCode.OK, newFile), (replay.Status, replay.Body.GetProperty("current").GetProperty("id").GetGuid()));
    }

    [Fact]
    public async Task RemoveAndRestore_Twice_Are204AndARemovedBookRefusesAReplacement()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);

        Assert.Equal(HttpStatusCode.NoContent, (await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/books/{bookId}")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/books/{bookId}")).Status);
        var replace = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{Guid.NewGuid()}",
            new { replacesFileId = fileId, sha256 = NewSha256(), byteSize = 1, originalName = "v2.epub", format = "epub" });
        Assert.Equal((HttpStatusCode.Conflict, "book_removed"), (replace.Status, replace.Code));
        Assert.Equal(HttpStatusCode.NoContent, (await v2.SendAsync(v2.Alice, HttpMethod.Post, $"/me/v2/books/{bookId}/restore")).Status);
        Assert.Equal(HttpStatusCode.NoContent, (await v2.SendAsync(v2.Alice, HttpMethod.Post, $"/me/v2/books/{bookId}/restore")).Status);
    }

    [Fact]
    public async Task RemoveAndImport_BookIdOfAnotherUser_AreNotFoundAndIdConflict()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var remove = await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"/me/v2/books/{bookId}");
        var import = await v2.SendAsync(v2.Bob, HttpMethod.Put, $"/me/v2/books/{bookId}", new { title = "bob's", file = File(Guid.NewGuid()) });

        Assert.Equal((HttpStatusCode.NotFound, HttpStatusCode.Conflict, "id_conflict"), (remove.Status, import.Status, import.Code));
    }
}
