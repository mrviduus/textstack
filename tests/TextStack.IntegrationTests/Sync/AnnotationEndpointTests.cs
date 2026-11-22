using System.Net;

namespace TextStack.IntegrationTests.Sync;

/// <summary>The annotation rows of v2-sync-protocol.md "Endpoints" (M1.3 delta 1's codes), against the running stack.</summary>
public class AnnotationEndpointTests(SyncApiFixture v2) : IClassFixture<SyncApiFixture>
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

    [Fact]
    public async Task Put_CreateUpdateStaleAndOwnRetry_Are201_200_StaleRevision_200()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var id = Guid.NewGuid();

        var created = await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, null));
        var updated = await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "edited"));
        var stale = await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "another device"));
        var ownRetry = await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, 1, "edited")); // the update's response was lost

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
        await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, null));

        var deleted = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/annotations/{id}");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/annotations/{id}");
        var edit = await v2.PutAnnotationAsync(v2.Alice, id, Highlight(bookId, fileId, 2, "too late"));

        Assert.Equal((HttpStatusCode.OK, System.Text.Json.JsonValueKind.String), (deleted.Status, deleted.Body.GetProperty("deletedAt").ValueKind));
        Assert.Equal(HttpStatusCode.OK, again.Status);
        Assert.Equal((HttpStatusCode.Conflict, "deleted"), (edit.Status, edit.Code));
    }

    /// <summary>
    /// The V2 reader's bookmark (#1314, ADR-031 "Amended 2026-11-15"): an annotation of colour <c>bookmark</c> whose
    /// <c>selectedText</c> is the first words at its place. No schema of its own: stored, fed and tombstoned as any annotation.
    /// </summary>
    private static object Bookmark(Guid bookId, Guid? fileId, string? selectedText = "It was a bright cold day in April") => new
    {
        expectedRevision = (long?)null,
        bookId,
        fileId,
        selectedText,
        noteText = (string?)null,
        locator = new { version = 1, scheme = "epub-cfi", value = "epubcfi(/6/4!/4/2,/1:0,/1:33)", quote = "It was a bright cold day in April" },
        color = "bookmark",
    };

    [Fact]
    public async Task Bookmark_PutFeedDeleteFeed_StoredAsSentThenATombstone()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync(); // its own feed: exactly the rows written here
        var (bookId, fileId, _) = await v2.ImportAsync(guest);
        var (bookmark, highlight) = (Guid.NewGuid(), Guid.NewGuid());
        await v2.PutAnnotationAsync(guest, highlight, Highlight(bookId, fileId, null));

        var created = await v2.PutAnnotationAsync(guest, bookmark, Bookmark(bookId, fileId));
        var ownRetry = await v2.PutAnnotationAsync(guest, bookmark, Bookmark(bookId, fileId)); // the create's response was lost
        var live = (await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/annotations/changes")).Body.GetProperty("items").EnumerateArray()
            .Single(a => a.GetProperty("id").GetGuid() == bookmark);
        var deleted = await v2.SendAsync(guest, HttpMethod.Delete, $"/me/v2/annotations/{bookmark}");
        var rows = (await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/annotations/changes")).Body.GetProperty("items").EnumerateArray()
            .ToDictionary(a => a.GetProperty("id").GetGuid());

        Assert.Equal((HttpStatusCode.Created, 1L), (created.Status, created.Body.GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.OK, 1L), (ownRetry.Status, ownRetry.Body.GetProperty("revision").GetInt64()));
        // The stored row itself, as the feed gives it to another device.
        Assert.Equal(("bookmark", "It was a bright cold day in April", bookId, fileId, System.Text.Json.JsonValueKind.Null, System.Text.Json.JsonValueKind.Null),
            (live.GetProperty("color").GetString(), live.GetProperty("selectedText").GetString(), live.GetProperty("bookId").GetGuid(),
                live.GetProperty("fileId").GetGuid(), live.GetProperty("noteText").ValueKind, live.GetProperty("deletedAt").ValueKind));
        var locator = live.GetProperty("locator");
        Assert.Equal(("epub-cfi", "epubcfi(/6/4!/4/2,/1:0,/1:33)", "It was a bright cold day in April"),
            (locator.GetProperty("scheme").GetString(), locator.GetProperty("value").GetString(), locator.GetProperty("quote").GetString()));
        // Removed: a tombstone on the feed, still a bookmark; the highlight beside it untouched.
        Assert.Equal((HttpStatusCode.OK, 2L), (deleted.Status, deleted.Body.GetProperty("revision").GetInt64()));
        Assert.Equal(("bookmark", System.Text.Json.JsonValueKind.String), (rows[bookmark].GetProperty("color").GetString(), rows[bookmark].GetProperty("deletedAt").ValueKind));
        Assert.Equal(("yellow", System.Text.Json.JsonValueKind.Null), (rows[highlight].GetProperty("color").GetString(), rows[highlight].GetProperty("deletedAt").ValueKind));
        Assert.Equal(2, rows.Count);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("   ")]
    public async Task Bookmark_WithoutItsText_IsInvalidPayload_NothingStored(string? selectedText)
    {
        // ADR-031: an annotation always carries text; a location-only bookmark is refused, which is why the reader sends the words at the place.
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var (bookId, fileId, _) = await v2.ImportAsync(guest);

        var refused = await v2.PutAnnotationAsync(guest, Guid.NewGuid(), Bookmark(bookId, fileId, selectedText));
        var feed = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/annotations/changes");

        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload"), (refused.Status, refused.Code));
        Assert.Equal(0, feed.Body.GetProperty("items").GetArrayLength());
    }

    [Fact]
    public async Task Put_FileThatIsNoVersionAndABookThatIsNotThere_AreUnknownFileAndBookNotFound()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var unknownFile = await v2.PutAnnotationAsync(v2.Alice, Guid.NewGuid(), Highlight(bookId, Guid.NewGuid(), null));
        var noBook = await v2.PutAnnotationAsync(v2.Alice, Guid.NewGuid(), Highlight(Guid.NewGuid(), Guid.NewGuid(), null));

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
        await v2.PutAnnotationAsync(v2.Alice, id, Highlight(alicesBook, alicesFile, null));

        var put = await v2.PutAnnotationAsync(v2.Bob, id, Highlight(bobsBook, bobsFile, null));
        var delete = await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"/me/v2/annotations/{id}");

        Assert.Equal((HttpStatusCode.Conflict, "id_conflict"), (put.Status, put.Code));
        Assert.Equal((HttpStatusCode.NotFound, "not_found"), (delete.Status, delete.Code));
    }
}
