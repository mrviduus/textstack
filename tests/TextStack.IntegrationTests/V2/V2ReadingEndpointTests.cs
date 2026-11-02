using System.Net;
using static TextStack.IntegrationTests.V2.V2ApiFixture;

namespace TextStack.IntegrationTests.V2;

/// <summary>v2-sync-protocol.md "The revision rule" and the reading rows of "Endpoints", against the running stack.</summary>
public class V2ReadingEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    [Fact]
    public async Task PutState_FirstWriteThenAnotherFirstWrite_Is200ThenStaleRevision()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);

        var first = await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null));
        var second = await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null, step: 2));
        var read = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        Assert.Equal((HttpStatusCode.OK, 1L), (first.Status, first.Body.GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision", 1L), (second.Status, second.Code, second.Body.GetProperty("current").GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.OK, fileId), (read.Status, read.Body.GetProperty("fileId").GetGuid()));
    }

    [Fact]
    public async Task PutState_AfterAResetElsewhere_IsReset()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null, step: 8));

        var reset = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"/me/v2/books/{bookId}/reading-state/reset", new { expectedRevision = 1 });
        var replayedReset = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"/me/v2/books/{bookId}/reading-state/reset", new { expectedRevision = 1 });
        var stale = await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, 1, step: 9));

        Assert.Equal((HttpStatusCode.OK, 2L), (reset.Status, reset.Body.GetProperty("resetRevision").GetInt64()));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision"), (replayedReset.Status, replayedReset.Code));
        Assert.Equal((HttpStatusCode.Conflict, "reset", fileId), (stale.Status, stale.Code, stale.Body.GetProperty("fileId").GetGuid()));
    }

    [Fact]
    public async Task PutState_OnTheReplacedFile_IsFileReplacedWithTheNewFile()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null));
        var newFile = Guid.NewGuid();
        await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/books/{bookId}/files/{newFile}",
            Replacement(fileId));

        var stale = await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, 1, step: 2));
        var gone = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        Assert.Equal((HttpStatusCode.Conflict, "file_replaced", newFile), (stale.Status, stale.Code, stale.Body.GetProperty("currentFile").GetProperty("id").GetGuid()));
        Assert.Equal((HttpStatusCode.NotFound, "not_found"), (gone.Status, gone.Code));
    }

    [Fact]
    public async Task PutState_FileThatIsNoVersionOfTheBook_IsUnknownFile()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);

        var response = await v2.WriteStateAsync(v2.Alice, bookId, State(Guid.NewGuid(), null));

        Assert.Equal((HttpStatusCode.Conflict, "unknown_file"), (response.Status, response.Code));
    }

    [Fact]
    public async Task PutState_RemovedBook_IsAccepted()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"/me/v2/books/{bookId}");

        Assert.Equal(HttpStatusCode.OK, (await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null))).Status);
    }

    [Fact]
    public async Task PutAndGetState_BookOfAnotherUser_AreBookNotFound()
    {
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null));

        var put = await v2.WriteStateAsync(v2.Bob, bookId, State(fileId, 1));
        var get = await v2.SendAsync(v2.Bob, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        Assert.Equal(("book_not_found", "book_not_found"), (put.Code, get.Code));
    }

    [Fact]
    public async Task PutSession_TwiceThenOnAnotherUsersBook_Is201ThenTheFirstWriteThenBookNotFound()
    {
        v2.Require();
        var (bookId, _, _) = await v2.ImportAsync(v2.Alice);
        var sessionId = Guid.NewGuid();
        var session = (int words) => new
        {
            bookId,
            startedAt = DateTimeOffset.UtcNow.AddMinutes(-5),
            endedAt = DateTimeOffset.UtcNow,
            durationSeconds = 300,
            wordsRead = words,
            startPercent = 0.1m,
            endPercent = 0.2m,
        };

        var first = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/reading/sessions/{sessionId}", session(120));
        var replay = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"/me/v2/reading/sessions/{sessionId}", session(999));
        var bobs = await v2.SendAsync(v2.Bob, HttpMethod.Put, $"/me/v2/reading/sessions/{Guid.NewGuid()}", session(1));

        Assert.Equal(HttpStatusCode.Created, first.Status);
        Assert.Equal((HttpStatusCode.OK, 120), (replay.Status, replay.Body.GetProperty("wordsRead").GetInt32()));
        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (bobs.Status, bobs.Code));
    }
}
