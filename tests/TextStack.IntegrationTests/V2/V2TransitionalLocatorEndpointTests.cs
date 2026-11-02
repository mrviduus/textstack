using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TextStack.IntegrationTests.V2;

/// <summary>
/// M2.7a (#1112): the legacy reader's <c>textstack-*</c> locators on V2 writes, against the running stack
/// with the worker extracting chapters (as <see cref="V2ContentEndpointTests"/>). Saved and restored as the
/// old reader writes them; only on a chapter the file has; the revision rule unchanged across schemes.
/// </summary>
public class V2TransitionalLocatorEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    /// <summary>A position as the legacy reader's serializeTextPosition writes it, its own <c>v</c> included.</summary>
    private static object TextPosition(string chapterSlug, decimal chapterFraction = 0.25m) => new
    {
        version = 1,
        scheme = "textstack-position-v1",
        value = new
        {
            v = 1,
            chapterSlug,
            anchor = new { prefix = "called Two ", exact = "has enough words in it", suffix = " to be read", startOffset = 31, endOffset = 53 },
            charOffset = 31,
            chapterFraction,
        },
    };

    private static object State(Guid fileId, long? expectedRevision, object locator, decimal bookFraction) =>
        new { expectedRevision, fileId, currentLocator = locator, bookFraction, clientRecordedAt = DateTimeOffset.UtcNow };

    private static object Anchor(string chapterKey) => new
    {
        version = 1,
        scheme = "textstack-anchor-v1",
        value = new { chapterKey, prefix = "Two has ", exact = "enough words", suffix = " in it", startOffset = 35, endOffset = 47 },
    };

    private static object Highlight(Guid bookId, Guid fileId, string chapterKey) =>
        new { expectedRevision = (long?)null, bookId, fileId, selectedText = "enough words", locator = Anchor(chapterKey) };

    private Task<V2Response> PutAnnotationAsync(V2Session who, Guid id, object body) => v2.SendAsync(who, HttpMethod.Put, $"/me/v2/annotations/{id}", body);

    // jsonb keeps neither key order nor spacing: what comes back is the same JSON value, not the same bytes.
    private static void AssertSameJson(object sent, JsonElement stored) =>
        Assert.True(JsonNode.DeepEquals(JsonSerializer.SerializeToNode(sent), JsonNode.Parse(stored.GetRawText())), stored.GetRawText());

    [Fact]
    public async Task PutState_LegacyPositionOnAnExtractedChapter_IsRestoredAsSentAndAnUnknownChapterIsChapterNotFound()
    {
        v2.Require();
        var (book, file, keys) = await v2.ImportWithChaptersAsync(v2.Alice, "One", "Two");
        var position = TextPosition(keys[1]);

        var saved = await v2.WriteStateAsync(v2.Alice, book, State(file, null, position, 0.6m));
        var restored = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{book}/reading-state");
        var unknown = await v2.WriteStateAsync(v2.Alice, book, State(file, 1, TextPosition("no-such-chapter"), 0.7m));

        Assert.Equal((HttpStatusCode.OK, 1L), (saved.Status, saved.Body.GetProperty("revision").GetInt64()));
        AssertSameJson(position, restored.Body.GetProperty("currentLocator"));
        Assert.Equal((HttpStatusCode.Conflict, "chapter_not_found"), (unknown.Status, unknown.Code));
        Assert.Equal(1L, (await v2.SendAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{book}/reading-state")).Body.GetProperty("revision").GetInt64());
    }

    [Fact]
    public async Task PutAnnotation_LegacyAnchorOnAnExtractedChapter_Is201AndTheFeedCarriesItAsSent()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync(); // an empty feed
        var (book, file, keys) = await v2.ImportWithChaptersAsync(guest, "One", "Two");
        var id = Guid.NewGuid();

        var created = await PutAnnotationAsync(guest, id, Highlight(book, file, keys[1]));
        var feed = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/annotations/changes");
        var unknown = await PutAnnotationAsync(guest, Guid.NewGuid(), Highlight(book, file, "no-such-chapter"));

        Assert.Equal(HttpStatusCode.Created, created.Status);
        var item = feed.Body.GetProperty("items").EnumerateArray().Single(a => a.GetProperty("id").GetGuid() == id);
        AssertSameJson(Anchor(keys[1]), item.GetProperty("locator"));
        Assert.Equal((HttpStatusCode.Conflict, "chapter_not_found"), (unknown.Status, unknown.Code));
    }

    [Fact]
    public async Task Writes_LegacyLocatorsOnAFileWithNoChapters_AreChapterNotFound()
    {
        v2.Require();
        var (book, file, _) = await v2.ImportAsync(v2.Alice); // imported, never uploaded: nothing extracted

        var state = await v2.WriteStateAsync(v2.Alice, book, State(file, null, TextPosition("1-one"), 0.1m));
        var annotation = await PutAnnotationAsync(v2.Alice, Guid.NewGuid(), Highlight(book, file, "1-one"));

        Assert.Equal(("chapter_not_found", "chapter_not_found"), (state.Code, annotation.Code));
    }

    [Fact]
    public async Task PutState_AnotherUsersChapterKeyOrBook_IsChapterNotFoundOrBookNotFound()
    {
        v2.Require();
        var (alicesBook, alicesFile, alicesKeys) = await v2.ImportWithChaptersAsync(v2.Alice, "Alpha");
        var (_, _, bobsKeys) = await v2.ImportWithChaptersAsync(v2.Bob, "Bravo");

        var bobsKeyOnAlicesFile = await v2.WriteStateAsync(v2.Alice, alicesBook, State(alicesFile, null, TextPosition(bobsKeys[0]), 0.1m));
        var bobOnAlicesBook = await v2.WriteStateAsync(v2.Bob, alicesBook, State(alicesFile, null, TextPosition(alicesKeys[0]), 0.1m));

        Assert.Equal((HttpStatusCode.Conflict, "chapter_not_found"), (bobsKeyOnAlicesFile.Status, bobsKeyOnAlicesFile.Code));
        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (bobOnAlicesBook.Status, bobOnAlicesBook.Code));
    }

    // PDD "Reading state": schemes are never compared; the revision rule decides, the frontier goes by fraction.
    [Fact]
    public async Task PutState_OldAndNewReaderOnOneBook_RevisionDecidesAndTheFrontierIsByFraction()
    {
        v2.Require();
        var (book, file, keys) = await v2.ImportWithChaptersAsync(v2.Alice, "One", "Two");
        var oldReader = TextPosition(keys[1]);
        var newReader = V2ApiFixture.Position(1); // epub-cfi

        var old1 = await v2.WriteStateAsync(v2.Alice, book, State(file, null, oldReader, 0.6m));
        var new2 = await v2.WriteStateAsync(v2.Alice, book, State(file, 1, newReader, 0.3m));
        var staleOld = await v2.WriteStateAsync(v2.Alice, book, State(file, 1, oldReader, 0.65m));
        var old3 = await v2.WriteStateAsync(v2.Alice, book, State(file, 2, oldReader, 0.2m));

        Assert.Equal(HttpStatusCode.OK, old1.Status);
        Assert.Equal((HttpStatusCode.OK, 2L, "epub-cfi"), (new2.Status, new2.Body.GetProperty("revision").GetInt64(), Scheme(new2, "currentLocator")));
        Assert.Equal(("textstack-position-v1", 0.6m), (Scheme(new2, "frontierLocator"), new2.Body.GetProperty("frontierFraction").GetDecimal()));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision"), (staleOld.Status, staleOld.Code));
        Assert.Equal((HttpStatusCode.OK, 3L, "textstack-position-v1"), (old3.Status, old3.Body.GetProperty("revision").GetInt64(), Scheme(old3, "currentLocator")));
    }

    private static string? Scheme(V2Response response, string locator) =>
        response.Body.GetProperty(locator).GetProperty("scheme").GetString();
}
