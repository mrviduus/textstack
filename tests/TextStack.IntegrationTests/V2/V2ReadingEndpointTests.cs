using System.Net;
using System.Text;
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
    public async Task PutState_PdfPageOnAPdfRoundTrips_PdfPageOnAnEpubIsInvalidPayload()
    {
        // R7 (#1039): the position the V2 reader writes on a PDF, as the Android host's sync client sends it.
        v2.Require();
        var (pdfBook, pdfFile) = await v2.ImportBytesAsync(v2.Alice, Encoding.ASCII.GetBytes($"%PDF-1.4 {Guid.NewGuid()}"), "pdf");
        var (epubBook, epubFile, _) = await v2.ImportAsync(v2.Alice);
        var page = (int n) => new { version = 1, scheme = "pdf-page", value = new { page = n } };

        var first = await v2.WriteStateAsync(v2.Alice, pdfBook, State(pdfFile, null, locator: page(3), bookFraction: 0.3m));
        var next = await v2.WriteStateAsync(v2.Alice, pdfBook, State(pdfFile, 1, locator: page(7), bookFraction: 0.7m));
        var read = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{pdfBook}/reading-state");
        var misfit = await v2.WriteStateAsync(v2.Alice, epubBook, State(epubFile, null, locator: page(3), bookFraction: 0.3m));

        Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK, 2L), (first.Status, next.Status, next.Body.GetProperty("revision").GetInt64()));
        var locator = read.Body.GetProperty("currentLocator");
        Assert.Equal((HttpStatusCode.OK, pdfFile, "pdf-page", 7), (read.Status, read.Body.GetProperty("fileId").GetGuid(),
            locator.GetProperty("scheme").GetString(), locator.GetProperty("value").GetProperty("page").GetInt32()));
        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload", "currentLocator"), (misfit.Status, misfit.Code, misfit.Body.GetProperty("field").GetString()));
    }

    [Fact]
    public async Task PutState_PageNameOnACbzRoundTrips_PageNameOnAnEpubOrAnAnnotationIsInvalidPayload()
    {
        // #1188: a CBZ page by its entry name, as both hosts send the V2 page's image position.
        v2.Require();
        var (cbzBook, cbzFile) = await v2.ImportBytesAsync(v2.Alice, Encoding.ASCII.GetBytes($"PK cbz {Guid.NewGuid()}"), "cbz");
        var (epubBook, epubFile, _) = await v2.ImportAsync(v2.Alice);
        var page = (string name, int index) => new { version = 1, scheme = "page-name", value = new { page = name, index } };

        var first = await v2.WriteStateAsync(v2.Alice, cbzBook, State(cbzFile, null, locator: page("p01.png", 0), bookFraction: 0.1m));
        var next = await v2.WriteStateAsync(v2.Alice, cbzBook, State(cbzFile, 1, locator: page("Vol 1/p07.png", 6), bookFraction: 0.7m));
        var read = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{cbzBook}/reading-state");
        var misfit = await v2.WriteStateAsync(v2.Alice, epubBook, State(epubFile, null, locator: page("p01.png", 0), bookFraction: 0.1m));
        var annotation = await v2.PutAnnotationAsync(v2.Alice, Guid.NewGuid(), new
        {
            expectedRevision = (long?)null,
            bookId = cbzBook,
            fileId = cbzFile,
            selectedText = "a page",
            locator = page("p01.png", 0),
        });

        Assert.Equal((HttpStatusCode.OK, HttpStatusCode.OK, 2L), (first.Status, next.Status, next.Body.GetProperty("revision").GetInt64()));
        var locator = read.Body.GetProperty("currentLocator");
        Assert.Equal((HttpStatusCode.OK, cbzFile, "page-name", "Vol 1/p07.png", 6), (read.Status, read.Body.GetProperty("fileId").GetGuid(),
            locator.GetProperty("scheme").GetString(), locator.GetProperty("value").GetProperty("page").GetString(), locator.GetProperty("value").GetProperty("index").GetInt32()));
        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload", "currentLocator"), (misfit.Status, misfit.Code, misfit.Body.GetProperty("field").GetString()));
        Assert.Equal((HttpStatusCode.BadRequest, "invalid_payload", "locator"), (annotation.Status, annotation.Code, annotation.Body.GetProperty("field").GetString()));
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
    public async Task PutState_WithCompletedAt_IsSetOnceKeptByLaterWritesAndClearedByAReset()
    {
        // #1266 "Finish book" (PDD "Reading state": set once, cleared only by a reset), as both hosts write it:
        // the place as it stands plus completedAt; the real fraction is kept, not forced to 1.
        v2.Require();
        var (bookId, fileId, _) = await v2.ImportAsync(v2.Alice);
        var finishedAt = DateTimeOffset.FromUnixTimeSeconds(DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 300);
        object Finished(long expectedRevision, int step, DateTimeOffset completedAt) => new
        {
            expectedRevision,
            fileId,
            currentLocator = Position(step),
            bookFraction = step / 10m,
            completedAt,
            clientRecordedAt = DateTimeOffset.UtcNow,
        };
        static DateTimeOffset? CompletedAt(V2Response r) =>
            r.Body.TryGetProperty("completedAt", out var c) && c.ValueKind != System.Text.Json.JsonValueKind.Null ? c.GetDateTimeOffset() : null;
        await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, null, step: 9));

        var finished = await v2.WriteStateAsync(v2.Alice, bookId, Finished(1, 9, finishedAt));
        var moved = await v2.WriteStateAsync(v2.Alice, bookId, State(fileId, 2, step: 3));
        var finishedAgain = await v2.WriteStateAsync(v2.Alice, bookId, Finished(3, 3, finishedAt.AddMinutes(1)));
        var read = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");
        var reset = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"/me/v2/books/{bookId}/reading-state/reset", new { expectedRevision = 4 });
        var afterReset = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{bookId}/reading-state");

        Assert.Equal((HttpStatusCode.OK, 2L, finishedAt, 0.9m), (finished.Status, finished.Body.GetProperty("revision").GetInt64(), CompletedAt(finished), finished.Body.GetProperty("bookFraction").GetDecimal()));
        Assert.Equal((HttpStatusCode.OK, finishedAt), (moved.Status, CompletedAt(moved)));
        Assert.Equal((HttpStatusCode.OK, finishedAt), (finishedAgain.Status, CompletedAt(finishedAgain)));
        Assert.Equal((HttpStatusCode.OK, 4L, finishedAt), (read.Status, read.Body.GetProperty("revision").GetInt64(), CompletedAt(read)));
        Assert.Equal((HttpStatusCode.OK, null), (reset.Status, CompletedAt(reset)));
        Assert.Equal((HttpStatusCode.OK, 5L, null), (afterReset.Status, afterReset.Body.GetProperty("revision").GetInt64(), CompletedAt(afterReset)));
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
