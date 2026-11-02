using System.Net;
using System.Text.Json;
using static TextStack.IntegrationTests.V2.V2ApiFixture;

namespace TextStack.IntegrationTests.V2;

/// <summary>
/// The share and checkpoint rows of v2-sync-protocol.md "Endpoints" (M2.4) and the acceptance list of
/// mcp-discussion-checkpoints.md "Test expectations", against the running stack. Account deletion
/// clearing owned checkpoints is M1.5's <c>UserRepositoryTests.DeleteAsync_Account_EveryV2TableOfThatUserIsEmpty</c>.
/// </summary>
public class V2DiscussionEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    private const string Chapter = "ch02.xhtml";

    private static object Share(Guid? fileId = null, string chapterKey = Chapter, Guid? operationId = null) => new
    {
        operationId = operationId ?? Guid.NewGuid(),
        fileId,
        chapterKey,
        chapterTitle = "Chapter II",
        chapterText = "It was the night.",
        notes = new object[] { new { text = "night", rect = new { x = 0.5, y = 1 } } },
        language = "en",
    };

    private static object Checkpoint(
        Guid? operationId = null, string thought = "It reads like a confession.", Guid? fileId = null, Guid? sharedChapterId = null) => new
        {
            operationId = operationId ?? Guid.NewGuid(),
            topic = "The letter",
            readerThoughts = new[] { thought },
            assistantSuggestions = Array.Empty<string>(),
            conclusions = Array.Empty<string>(),
            openQuestions = new[] { "Who wrote it?" },
            language = "en",
            chapterKey = Chapter,
            fileId,
            sharedChapterId,
        };

    private Task<V2Response> ShareAsync(V2Session who, Guid bookId, object body) => v2.SendAsync(who, HttpMethod.Post, $"/me/v2/books/{bookId}/shares", body);

    private Task<V2Response> SaveAsync(V2Session who, Guid bookId, object body) => v2.SendAsync(who, HttpMethod.Post, $"/me/v2/books/{bookId}/checkpoints", body);

    private Task<V2Response> ListAsync(V2Session who, Guid bookId, string query = "") => v2.SendAsync(who, HttpMethod.Get, $"/me/v2/books/{bookId}/checkpoints{query}");

    private static Guid Id(V2Response r) => r.Body.GetProperty("id").GetGuid();

    private static List<JsonElement> Items(V2Response page) => page.Body.GetProperty("items").EnumerateArray().ToList();

    [Fact]
    public async Task Post_TwoSavesInOneChapter_KeepsBothOldestFirst()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var first = await SaveAsync(v2.Alice, bookId, Checkpoint(thought: "First"));
        var second = await SaveAsync(v2.Alice, bookId, Checkpoint(thought: "Second"));
        var listed = await ListAsync(v2.Alice, bookId, $"?chapterKey={Chapter}");

        Assert.Equal((HttpStatusCode.Created, HttpStatusCode.Created), (first.Status, second.Status));
        Assert.Equal([Id(first), Id(second)], Items(listed).Select(i => i.GetProperty("id").GetGuid()));
        Assert.Equal("First", Items(listed)[0].GetProperty("readerThoughts")[0].GetString());
    }

    [Fact]
    public async Task Post_RetryWithTheSamePayloadThenAChangedOne_Is200OnceStoredThenOperationConflict()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var operationId = Guid.NewGuid();

        var saved = await SaveAsync(v2.Alice, bookId, Checkpoint(operationId));
        var retried = await SaveAsync(v2.Alice, bookId, Checkpoint(operationId));
        var changed = await SaveAsync(v2.Alice, bookId, Checkpoint(operationId, "Another thought."));

        Assert.Equal((HttpStatusCode.OK, Id(saved)), (retried.Status, Id(retried)));
        Assert.Equal((HttpStatusCode.Conflict, "operation_conflict", Id(saved)),
            (changed.Status, changed.Code, changed.Body.GetProperty("current").GetProperty("id").GetGuid()));
        Assert.Single(Items(await ListAsync(v2.Alice, bookId)));
    }

    [Fact]
    public async Task Share_RetryThenChanged_Is201Then200ThenOperationConflict()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var operationId = Guid.NewGuid();

        var shared = await ShareAsync(v2.Alice, bookId, Share(fileId, operationId: operationId));
        var retried = await ShareAsync(v2.Alice, bookId, Share(fileId, operationId: operationId));
        var changed = await ShareAsync(v2.Alice, bookId, Share(fileId, "ch03.xhtml", operationId));

        Assert.Equal((HttpStatusCode.Created, 0.5), (shared.Status, shared.Body.GetProperty("notes")[0].GetProperty("rect").GetProperty("x").GetDouble()));
        Assert.Equal((HttpStatusCode.OK, Id(shared)), (retried.Status, Id(retried)));
        Assert.Equal((HttpStatusCode.Conflict, "operation_conflict"), (changed.Status, changed.Code));
    }

    [Fact]
    public async Task Pages_AcrossABoundary_AreStableAndTheLastHasNoCursor()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var saved = new List<Guid>();
        for (var i = 0; i < 3; i++) saved.Add(Id(await SaveAsync(v2.Alice, bookId, Checkpoint(thought: $"Thought {i}"))));

        var first = await ListAsync(v2.Alice, bookId, "?limit=2");
        var last = await ListAsync(v2.Alice, bookId, $"?limit=2&cursor={first.Body.GetProperty("cursor").GetString()}");

        Assert.True(first.Body.GetProperty("hasMore").GetBoolean());
        Assert.Equal(saved, Items(first).Concat(Items(last)).Select(i => i.GetProperty("id").GetGuid()));
        Assert.Equal((false, JsonValueKind.Null), (last.Body.GetProperty("hasMore").GetBoolean(), last.Body.GetProperty("cursor").ValueKind));
    }

    [Fact]
    public async Task OtherUser_ReadsWritesAndDeletes_Are404AndSeeNoRowOfTheOwner()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var share = Id(await ShareAsync(v2.Alice, bookId, Share(fileId)));
        var checkpoint = Id(await SaveAsync(v2.Alice, bookId, Checkpoint()));

        var responses = new[]
        {
            await ListAsync(v2.Bob, bookId),
            await v2.SendAsync(v2.Bob, HttpMethod.Get, $"/me/v2/books/{bookId}/shares"),
            await SaveAsync(v2.Bob, bookId, Checkpoint()),
            await ShareAsync(v2.Bob, bookId, Share()),
            await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"/me/v2/checkpoints/{checkpoint}"),
            await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"/me/v2/shares/{share}"),
            await v2.SendAsync(v2.Bob, HttpMethod.Put, $"/me/v2/books/{bookId}/checkpoint-saving", new { enabled = true }),
        };

        Assert.All(responses, r => Assert.Equal(HttpStatusCode.NotFound, r.Status));
        Assert.All(responses, r => Assert.DoesNotContain(checkpoint.ToString(), r.Body.ToString()));
        Assert.Single(Items(await ListAsync(v2.Alice, bookId)));
        Assert.Single((await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/shares")).Body.EnumerateArray());
    }

    [Fact]
    public async Task RemovedBook_KeepsItsCheckpointsAndStillTakesNewOnes()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var before = Id(await SaveAsync(v2.Alice, bookId, Checkpoint()));

        Assert.Equal(HttpStatusCode.NoContent, (await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/books/{bookId}")).Status);
        var after = await SaveAsync(v2.Alice, bookId, Checkpoint());

        Assert.Equal(HttpStatusCode.Created, after.Status);
        Assert.Equal([before, Id(after)], Items(await ListAsync(v2.Alice, bookId)).Select(i => i.GetProperty("id").GetGuid()));
    }

    [Fact]
    public async Task Post_Checkpoint_LeavesTheReadingStateAsItWas()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, expectedRevision: null));
        var before = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        await SaveAsync(v2.Alice, bookId, Checkpoint(fileId: fileId));
        var after = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        Assert.Equal(HttpStatusCode.OK, before.Status);
        Assert.Equal(before.Body.ToString(), after.Body.ToString());
    }

    [Fact]
    public async Task Post_CheckpointOnItsOwnShare_Is201AndDeletingTheShareUnlinksItButKeepsIt()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var share = Id(await ShareAsync(v2.Alice, bookId, Share(fileId)));

        var saved = await SaveAsync(v2.Alice, bookId, Checkpoint(fileId: fileId, sharedChapterId: share));
        var deleted = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/shares/{share}");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/shares/{share}");

        Assert.Equal((HttpStatusCode.Created, share), (saved.Status, saved.Body.GetProperty("sharedChapterId").GetGuid()));
        Assert.Equal((HttpStatusCode.NoContent, HttpStatusCode.NotFound), (deleted.Status, again.Status));
        var kept = Assert.Single(Items(await ListAsync(v2.Alice, bookId)));
        Assert.Equal((Id(saved), JsonValueKind.Null), (kept.GetProperty("id").GetGuid(), kept.GetProperty("sharedChapterId").ValueKind));
    }

    [Fact]
    public async Task Post_CheckpointNamingAShareOfAnotherChapterFileOrUser_IsShareMismatch()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var otherChapter = Id(await ShareAsync(v2.Alice, bookId, Share(fileId, "ch03.xhtml")));
        var thisChapter = Id(await ShareAsync(v2.Alice, bookId, Share(fileId)));
        var newFile = Guid.NewGuid();
        Assert.Equal(HttpStatusCode.OK, (await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{newFile}", Replacement(fileId))).Status);
        var (bobsBook, _, _) = await v2.ImportAsync(v2.Bob);
        var bobs = Id(await ShareAsync(v2.Bob, bobsBook, Share()));

        var responses = new[]
        {
            await SaveAsync(v2.Alice, bookId, Checkpoint(fileId: fileId, sharedChapterId: otherChapter)),
            await SaveAsync(v2.Alice, bookId, Checkpoint(fileId: newFile, sharedChapterId: thisChapter)),
            await SaveAsync(v2.Alice, bookId, Checkpoint(sharedChapterId: bobs)),
        };

        Assert.All(responses, r => Assert.Equal(((HttpStatusCode)422, "share_mismatch"), (r.Status, r.Code)));
        Assert.Empty(Items(await ListAsync(v2.Alice, bookId)));
    }

    [Fact]
    public async Task Writes_NamingAFileThatIsNotTheBooksOrABookThatIsNotTheUsers_AreUnknownFileAndBookNotFound()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var share = await ShareAsync(v2.Alice, bookId, Share(Guid.NewGuid()));
        var checkpoint = await SaveAsync(v2.Alice, bookId, Checkpoint(fileId: Guid.NewGuid()));
        var noBook = await SaveAsync(v2.Alice, Guid.NewGuid(), Checkpoint());

        Assert.Equal((HttpStatusCode.Conflict, "unknown_file"), (share.Status, share.Code));
        Assert.Equal((HttpStatusCode.Conflict, "unknown_file"), (checkpoint.Status, checkpoint.Code));
        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (noBook.Status, noBook.Code));
    }

    [Fact]
    public async Task Post_AllSectionsEmptyAndATextOverItsCap_AreInvalidPayloadNot500()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var empty = await SaveAsync(v2.Alice, bookId, new { operationId = Guid.NewGuid(), topic = "t", readerThoughts = Array.Empty<string>(), assistantSuggestions = Array.Empty<string>(), conclusions = Array.Empty<string>(), openQuestions = Array.Empty<string>(), language = "en" });
        var huge = await ShareAsync(v2.Alice, bookId, new { operationId = Guid.NewGuid(), chapterKey = Chapter, chapterText = new string('x', 300 * 1024), notes = Array.Empty<object>() });

        Assert.Equal((HttpStatusCode.BadRequest, "readerThoughts"), (empty.Status, empty.Body.GetProperty("field").GetString()));
        Assert.Equal((HttpStatusCode.BadRequest, "chapterText"), (huge.Status, huge.Body.GetProperty("field").GetString()));
    }

    // 51 200 four-byte emoji are exactly 200 KB of UTF-8 (and 102 400 UTF-16 units): the cap is bytes.
    [Fact]
    public async Task Share_ChapterTextAtItsByteCapAndOneByteOver_Is201Then400()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var atCap = string.Concat(Enumerable.Repeat("😀", 51_200));
        object Body(string text) => new { operationId = Guid.NewGuid(), chapterKey = Chapter, chapterText = text, notes = Array.Empty<object>() };

        var fits = await ShareAsync(v2.Alice, bookId, Body(atCap));
        var over = await ShareAsync(v2.Alice, bookId, Body(atCap + "x"));

        Assert.Equal(HttpStatusCode.Created, fits.Status);
        Assert.Equal((HttpStatusCode.BadRequest, "chapterText"), (over.Status, over.Body.GetProperty("field").GetString()));
    }

    [Fact]
    public async Task Post_CheckpointOnOneBookNamingTheUsersShareOfAnother_IsShareMismatchNot500()
    {
        v2.Require();
        var (first, _, _) = await v2.ImportAsync(v2.Alice);
        var (second, _, _) = await v2.ImportAsync(v2.Alice);
        var share = Id(await ShareAsync(v2.Alice, first, Share()));

        var saved = await SaveAsync(v2.Alice, second, Checkpoint(sharedChapterId: share));

        Assert.Equal(((HttpStatusCode)422, "share_mismatch"), (saved.Status, saved.Code));
    }

    [Fact]
    public async Task List_ChapterKeyFilterWithANul_IsInvalidPayloadNot500()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var listed = await ListAsync(v2.Alice, bookId, "?chapterKey=ch%00");

        Assert.Equal((HttpStatusCode.BadRequest, "chapterKey"), (listed.Status, listed.Body.GetProperty("field").GetString()));
    }

    [Fact]
    public async Task Delete_Checkpoint_Is204ThenGoneAndASecondDeleteIs404()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var id = Id(await SaveAsync(v2.Alice, bookId, Checkpoint()));

        var deleted = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/checkpoints/{id}");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/checkpoints/{id}");

        Assert.Equal((HttpStatusCode.NoContent, HttpStatusCode.NotFound, "not_found"), (deleted.Status, again.Status, again.Code));
        Assert.Empty(Items(await ListAsync(v2.Alice, bookId)));
    }

    [Fact]
    public async Task Put_CheckpointSaving_FlipsTheBookAndTheLibraryFeedDeliversIt()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var (bookId, _, _) = await v2.ImportAsync(guest);

        var on = await v2.SendAsync(guest, HttpMethod.Put, $"/me/v2/books/{bookId}/checkpoint-saving", new { enabled = true });
        var feed = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/library/changes");

        Assert.Equal((HttpStatusCode.OK, true), (on.Status, on.Body.GetProperty("checkpointSavingEnabled").GetBoolean()));
        var delivered = Assert.Single(Items(feed));
        Assert.Equal((bookId, true, on.Body.GetProperty("updatedAt").GetDateTimeOffset()),
            (delivered.GetProperty("id").GetGuid(), delivered.GetProperty("checkpointSavingEnabled").GetBoolean(), delivered.GetProperty("updatedAt").GetDateTimeOffset()));
    }
}
