using System.Net;
using System.Net.Http.Json;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace TextStack.IntegrationTests.V2;

/// <summary>
/// v2-sync-protocol.md "Endpoints", the M2.6 rows (file bytes, cover, transitional chapters), against
/// the running stack (V2 mode, <see cref="V2ApiFixture"/>). The chapters test needs the worker running
/// with the api's storage root and V2 database. The quota is pinned by the Persistence and unit tests:
/// a tier limit cannot be set per test here.
/// </summary>
public class V2ContentEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static byte[] RandomBytes(int length) => Encoding.UTF8.GetBytes(Guid.NewGuid().ToString("N")).Concat(new byte[length]).Take(length).ToArray();

    private static string Files(Guid book, Guid file) => $"/me/v2/books/{book}/files/{file}";

    private async Task<HttpStatusCode> PartAsync(V2Session who, Guid book, Guid file, int index, byte[] bytes, bool chunked = false)
    {
        using var response = await v2.SendRawAsync(who, HttpMethod.Put, $"{Files(book, file)}/parts/{index}", new ByteArrayContent(bytes),
            r => r.Headers.TransferEncodingChunked = chunked);
        return response.StatusCode;
    }

    private Task<V2Response> CompleteAsync(V2Session who, Guid book, Guid file, int partCount) =>
        v2.SendAsync(who, HttpMethod.Post, $"{Files(book, file)}/content", new { partCount });

    [Fact]
    public async Task Upload_TwoPartsThenComplete_HasContentAndARangeIs206()
    {
        v2.Require();
        var bytes = RandomBytes(1000);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);

        var completed = await v2.UploadAsync(v2.Alice, book, file, bytes);
        var replay = await CompleteAsync(v2.Alice, book, file, 2);
        using var range = await v2.SendRawAsync(v2.Alice, HttpMethod.Get, $"{Files(book, file)}/content", configure: r => r.Headers.Range = new RangeHeaderValue(0, 9));

        Assert.Equal((HttpStatusCode.OK, true), (completed.Status, completed.Body.GetProperty("hasContent").GetBoolean()));
        Assert.Equal(HttpStatusCode.OK, replay.Status);
        Assert.Equal((HttpStatusCode.PartialContent, "bytes"), (range.StatusCode, range.Headers.AcceptRanges.Single()));
        Assert.Equal(bytes[..10], await range.Content.ReadAsByteArrayAsync(Ct));
        Assert.Equal("nosniff", range.Headers.GetValues("X-Content-Type-Options").Single());
        Assert.Contains("sandbox", range.Headers.GetValues("Content-Security-Policy").Single());
        Assert.True(range.Headers.CacheControl is { Private: true, NoStore: true });
    }

    [Fact]
    public async Task Upload_BooksFeed_CarriesHasContent()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var bytes = RandomBytes(64);
        var (book, file) = await v2.ImportBytesAsync(guest, bytes);
        await v2.UploadAsync(guest, book, file, bytes);

        var feed = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/library/changes");

        var item = feed.Body.GetProperty("items").EnumerateArray().Single(b => b.GetProperty("id").GetGuid() == book);
        Assert.True(item.GetProperty("currentFile").GetProperty("hasContent").GetBoolean());
    }

    [Fact]
    public async Task Complete_BytesThatDoNotMatch_IsContentMismatchAndThePartsAreGone()
    {
        v2.Require();
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, RandomBytes(100));

        var mismatch = await v2.UploadAsync(v2.Alice, book, file, RandomBytes(100));
        var again = await CompleteAsync(v2.Alice, book, file, 2);

        Assert.Equal((HttpStatusCode.UnprocessableEntity, "content_mismatch"), (mismatch.Status, mismatch.Code));
        Assert.Equal(100, mismatch.Body.GetProperty("current").GetProperty("byteSize").GetInt64());
        Assert.Equal((HttpStatusCode.BadRequest, "incomplete_upload"), (again.Status, again.Code));
    }

    [Fact]
    public async Task Complete_PartMissing_IsIncompleteUploadThenTheResentPartCompletes()
    {
        v2.Require();
        var bytes = RandomBytes(100);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);
        await PartAsync(v2.Alice, book, file, 0, bytes[..50]);

        var incomplete = await CompleteAsync(v2.Alice, book, file, 2);
        await PartAsync(v2.Alice, book, file, 1, bytes[50..]);
        var complete = await CompleteAsync(v2.Alice, book, file, 2);

        Assert.Equal((HttpStatusCode.BadRequest, "incomplete_upload"), (incomplete.Status, incomplete.Code));
        Assert.Equal(HttpStatusCode.OK, complete.Status);
    }

    [Fact]
    public async Task Part_SupersededFile_IsFileReplaced()
    {
        v2.Require();
        var bytes = RandomBytes(100);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);
        var replaced = await v2.SendAsync(v2.Alice, HttpMethod.Put, $"{Files(book, Guid.NewGuid())}", V2ApiFixture.Replacement(file));
        Assert.Equal(HttpStatusCode.OK, replaced.Status);

        using var response = await v2.SendRawAsync(v2.Alice, HttpMethod.Put, $"{Files(book, file)}/parts/0", new ByteArrayContent(bytes));
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

        Assert.Equal((HttpStatusCode.Conflict, "file_replaced"), (response.StatusCode, body.GetProperty("code").GetString()));
    }

    [Fact]
    public async Task Part_WithoutContentLength_Is411()
    {
        v2.Require();
        var bytes = RandomBytes(100);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);

        Assert.Equal(HttpStatusCode.LengthRequired, await PartAsync(v2.Alice, book, file, 0, bytes, chunked: true));
    }

    [Fact]
    public async Task RemoveContent_ThenRead_Is204Then404NoContentAndAReuploadIsAllowed()
    {
        v2.Require();
        var bytes = RandomBytes(100);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);
        await v2.UploadAsync(v2.Alice, book, file, bytes);

        var removed = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"{Files(book, file)}/content");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"{Files(book, file)}/content");
        var read = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"{Files(book, file)}/content");
        var reupload = await v2.UploadAsync(v2.Alice, book, file, bytes);

        Assert.Equal((HttpStatusCode.NoContent, HttpStatusCode.NoContent), (removed.Status, again.Status));
        Assert.Equal((HttpStatusCode.NotFound, "no_content"), (read.Status, read.Code));
        Assert.Equal((HttpStatusCode.OK, JsonValueKind.Null), (reupload.Status, reupload.Body.GetProperty("contentRemovedAt").ValueKind));
    }

    private static readonly byte[] OnePixelPng = Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

    private async Task<HttpResponseMessage> PutCoverAsync(V2Session who, Guid book, byte[] bytes, string contentType)
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        return await v2.SendRawAsync(who, HttpMethod.Put, $"/me/v2/books/{book}/cover", content);
    }

    [Fact]
    public async Task Cover_PngThenGet_IsTheImageAndAWrongTypeIsInvalidPayload()
    {
        v2.Require();
        var (book, _, _) = await v2.ImportAsync(v2.Alice);

        using var put = await PutCoverAsync(v2.Alice, book, OnePixelPng, "image/png");
        using var get = await v2.SendRawAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{book}/cover");
        using var wrong = await PutCoverAsync(v2.Alice, book, OnePixelPng, "image/jpeg");

        Assert.Equal(HttpStatusCode.OK, put.StatusCode);
        Assert.True((await put.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("hasCover").GetBoolean());
        Assert.Equal((HttpStatusCode.OK, "image/png"), (get.StatusCode, get.Content.Headers.ContentType!.MediaType));
        Assert.Equal(OnePixelPng, await get.Content.ReadAsByteArrayAsync(Ct));
        Assert.NotNull(get.Headers.ETag);
        Assert.True(get.Headers.CacheControl!.Private);
        using var again = await v2.SendRawAsync(v2.Alice, HttpMethod.Get, $"/me/v2/books/{book}/cover", configure: r => r.Headers.IfNoneMatch.Add(get.Headers.ETag!));
        Assert.Equal(HttpStatusCode.NotModified, again.StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
    }

    [Fact]
    public async Task EveryBytesRoute_AnotherUsersBook_IsBookNotFound()
    {
        v2.Require();
        var bytes = RandomBytes(100);
        var (book, file) = await v2.ImportBytesAsync(v2.Alice, bytes);
        await v2.UploadAsync(v2.Alice, book, file, bytes);
        using var _ = await PutCoverAsync(v2.Alice, book, OnePixelPng, "image/png");

        using var part = await v2.SendRawAsync(v2.Bob, HttpMethod.Put, $"{Files(book, file)}/parts/0", new ByteArrayContent(bytes));
        using var cover = await PutCoverAsync(v2.Bob, book, OnePixelPng, "image/png");
        V2Response[] answers =
        [
            await CompleteAsync(v2.Bob, book, file, 2),
            await v2.SendAsync(v2.Bob, HttpMethod.Get, $"{Files(book, file)}/content"),
            await v2.SendAsync(v2.Bob, HttpMethod.Delete, $"{Files(book, file)}/content"),
            await v2.SendAsync(v2.Bob, HttpMethod.Get, $"/me/v2/books/{book}/cover"),
            await v2.SendAsync(v2.Bob, HttpMethod.Get, $"{Files(book, file)}/chapters"),
            await v2.SendAsync(v2.Bob, HttpMethod.Get, $"{Files(book, file)}/chapters/1-one"),
        ];

        Assert.Equal((HttpStatusCode.NotFound, HttpStatusCode.NotFound), (part.StatusCode, cover.StatusCode));
        Assert.All(answers, a => Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (a.Status, a.Code)));
        using var stillThere = await v2.SendRawAsync(v2.Alice, HttpMethod.Get, $"{Files(book, file)}/content");
        Assert.Equal(HttpStatusCode.OK, stillThere.StatusCode);
    }

    [Fact]
    public async Task Chapters_AfterContent_SucceedAndAChapterCarriesItsNeighbours()
    {
        v2.Require();
        var (book, file, keys) = await v2.ImportWithChaptersAsync(v2.Alice, "One", "Two", "Three");

        var middle = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"{Files(book, file)}/chapters/{keys[1]}");
        var unknown = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"{Files(book, file)}/chapters/no-such-chapter");

        Assert.Equal(3, keys.Count);
        Assert.Equal(HttpStatusCode.OK, middle.Status);
        Assert.Contains("Two", middle.Body.GetProperty("html").GetString());
        Assert.Equal((keys[0], keys[2]), (middle.Body.GetProperty("previous").GetProperty("chapterKey").GetString(), middle.Body.GetProperty("next").GetProperty("chapterKey").GetString()));
        Assert.Equal((HttpStatusCode.NotFound, "not_found"), (unknown.Status, unknown.Code));
    }
}
