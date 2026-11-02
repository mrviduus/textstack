using System.Net;

namespace TextStack.IntegrationTests.V2;

/// <summary>The annotation rows of v2-sync-protocol.md "Endpoints" (M1.3 delta 1's codes), against the running stack.</summary>
public class V2AnnotationEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    private static object Highlight(Guid bookId, Guid? fileId, long? expectedRevision, string note = "a note") => new
    {
        expectedRevision,
        bookId,
        fileId,
        selectedText = "It was a bright cold day",
        noteText = note,
        locator = new { version = 1, scheme = "epub-cfi", value = "epubcfi(/6/4!/4/2/1:0)", quote = "bright", prefix = "It was a ", suffix = " cold day" },
    };

    private Task<V2Response> PutAsync(V2Session who, Guid id, object body) => v2.SendAsync(who, HttpMethod.Put, $"/me/v2/annotations/{id}", body);

    [Fact]
    public async Task Put_CreateUpdateStaleAndOwnRetry_Are201_200_StaleRevision_200()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var id = Guid.NewGuid();

        var created = await PutAsync(v2.Alice, id, Highlight(bookId, fileId, null));
        var updated = await PutAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "edited"));
        var stale = await PutAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "another device"));
        var ownRetry = await PutAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "edited")); // the update's response was lost

        Assert.Equal((HttpStatusCode.Created, 1L, "yellow"), (created.Status, created.Body.GetProperty("revision").GetInt64(), created.Body.GetProperty("color").GetString()));
        Assert.Equal((HttpStatusCode.OK, 2L), (updated.Status, updated.Body.GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision", 2L), (stale.Status, stale.Code, stale.Body.GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.OK, 2L), (ownRetry.Status, ownRetry.Body.GetProperty("revision").GetInt64()));
    }

    [Fact]
    public async Task DeleteTwiceThenPut_Is200Tombstone200ThenDeleted()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var id = Guid.NewGuid();
        await PutAsync(v2.Alice, id, Highlight(bookId, fileId, null));

        var deleted = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/annotations/{id}");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/annotations/{id}");
        var edit = await PutAsync(v2.Alice, id, Highlight(bookId, fileId, 2, "too late"));

        Assert.Equal((HttpStatusCode.OK, System.Text.Json.JsonValueKind.String), (deleted.Status, deleted.Body.GetProperty("deletedAt").ValueKind));
        Assert.Equal(HttpStatusCode.OK, again.Status);
        Assert.Equal((HttpStatusCode.Conflict, "deleted"), (edit.Status, edit.Code));
    }

    [Fact]
    public async Task Put_FileThatIsNoVersionAndABookThatIsNotThere_AreUnknownFileAndBookNotFound()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var unknownFile = await PutAsync(v2.Alice, Guid.NewGuid(), Highlight(bookId, Guid.NewGuid(), null));
        var noBook = await PutAsync(v2.Alice, Guid.NewGuid(), Highlight(Guid.NewGuid(), Guid.NewGuid(), null));

        Assert.Equal((HttpStatusCode.Conflict, "unknown_file"), (unknownFile.Status, unknownFile.Code));
        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (noBook.Status, noBook.Code));
    }

    [Fact]
    public async Task PutAndDelete_AnotherUsersAnnotationId_AreIdConflictAndNotFound()
    {
        v2.Require();
        var (alicesBook, alicesFile, _) = await v2.ImportAsync(v2.Alice);
        var (bobsBook, bobsFile, _) = await v2.ImportAsync(v2.Bob);
        var id = Guid.NewGuid();
        await PutAsync(v2.Alice, id, Highlight(alicesBook, alicesFile, null));

        var put = await PutAsync(v2.Bob, id, Highlight(bobsBook, bobsFile, null));
        var delete = await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"/me/v2/annotations/{id}");

        Assert.Equal((HttpStatusCode.Conflict, "id_conflict"), (put.Status, put.Code));
        Assert.Equal((HttpStatusCode.NotFound, "not_found"), (delete.Status, delete.Code));
    }
}
