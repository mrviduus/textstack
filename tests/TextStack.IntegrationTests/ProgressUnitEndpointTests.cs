using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// <c>PUT /me/progress/{editionId}</c> — the unit contract on the FIRST write for a book.
///
/// <para>A percentage without a declared unit is not stored: an older build sending a chapter
/// fraction is byte-identical to a correct book fraction, and that column has already been wrong
/// that way (see <c>Application.ReadingTracking.ProgressUnit</c>). The update path has always
/// enforced it. The insert path had a hand-written copy of the same assignment that did not, so the
/// first write for an edition kept an untrusted number every later write would have refused — and a
/// book finished in a single write never got a <c>completedAt</c>.</para>
///
/// <para>Only reachable from outside: the branch is chosen by whether a row exists, which is a
/// database fact. The suite DELETEs the row first so the insert path is the one under test.</para>
///
/// <para>Requires docker compose up + ENABLE_TEST_AUTH=true; skips rather than fails otherwise.</para>
/// </summary>
public class ProgressUnitEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private readonly AuthenticatedApiFixture _auth;

    public ProgressUnitEndpointTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    {
        _fixture = fixture;
        _auth = auth;
    }

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>The first seeded edition that has a chapter, or null when the DB has none.</summary>
    private async Task<(Guid EditionId, Guid ChapterId)?> FindSeededChapterAsync()
    {
        var listResp = await _fixture.Client.SendAsync(_fixture.CreateRequest(HttpMethod.Get, "/books?limit=1"), Ct);
        if (!listResp.IsSuccessStatusCode) return null;

        var list = await listResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        if (!list.TryGetProperty("items", out var items) || items.GetArrayLength() == 0) return null;

        var bookResp = await _fixture.Client.SendAsync(
            _fixture.CreateRequest(HttpMethod.Get, $"/books/{items[0].GetProperty("slug").GetString()}"), Ct);
        if (!bookResp.IsSuccessStatusCode) return null;

        var book = await bookResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        if (!book.TryGetProperty("chapters", out var chapters) || chapters.GetArrayLength() == 0) return null;

        return (book.GetProperty("id").GetGuid(), chapters[0].GetProperty("id").GetGuid());
    }

    private async Task<HttpResponseMessage> PutAsync(Guid editionId, object body)
    {
        var req = _auth.CreateRequest(HttpMethod.Put, $"/me/progress/{editionId}");
        req.Content = JsonContent.Create(body);
        return await _auth.Client.SendAsync(req, Ct);
    }

    [Fact]
    public async Task FirstWrite_WithoutPercentUnit_StoresThePositionAndNotTheNumber()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!_auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        // Force the INSERT branch: it is chosen by the absence of a row, which is a DB fact.
        var deleted = await _auth.Client.SendAsync(
            _auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
        Assert.SkipWhen(deleted.StatusCode is HttpStatusCode.NotFound && !_auth.IsAuthenticated, "auth unavailable");

        var put = await PutAsync(editionId, new
        {
            chapterId,
            locator = "scroll:ch-1:120",
            percent = 0.42,   // no percentUnit — a build that predates the contract
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(put), "endpoint unavailable");
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync(Ct));

        var read = await _auth.Client.SendAsync(
            _auth.CreateRequest(HttpMethod.Get, $"/me/progress/{editionId}"), Ct);
        var row = await read.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);

        // The position is the reader's and is saved; the number is not trusted enough to store.
        Assert.Equal("scroll:ch-1:120", row.GetProperty("locator").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("percent").ValueKind);
    }

    [Fact]
    public async Task FirstWrite_Declared100Percent_FinishesTheBookInOneWrite()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!_auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        await _auth.Client.SendAsync(_auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);

        var put = await PutAsync(editionId, new
        {
            chapterId,
            locator = "{\"type\":\"end\"}",
            percent = 1.0,
            percentUnit = "book",
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(put), "endpoint unavailable");
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync(Ct));

        var read = await _auth.Client.SendAsync(
            _auth.CreateRequest(HttpMethod.Get, $"/me/progress/{editionId}"), Ct);
        var row = await read.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);

        Assert.Equal(1.0, row.GetProperty("percent").GetDouble());
        // Completion is recorded, not inferred from a threshold later — and the insert path used to
        // skip recording it, so a book read in one sitting stayed unfinished forever.
        Assert.Equal(JsonValueKind.String, row.GetProperty("completedAt").ValueKind);

        await _auth.Client.SendAsync(_auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
    }
}
