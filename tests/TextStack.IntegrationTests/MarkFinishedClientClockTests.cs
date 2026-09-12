using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// "Mark finished" on a catalog book, and the client clock it is decided by.
///
/// <para>#602 gave mobile <c>markProgressFinished</c> (<c>packages/shared/src/api/readingProgress.ts</c>)
/// so that the phone and the browser write the same sentinel for the same action. They do. What they
/// do not share is the stale-write guard: <c>markProgressFinished</c> sends
/// <c>updatedAt: new Date().toISOString()</c> — a DEVICE clock — while web's <c>markAsRead</c>
/// (<c>apps/web/src/api/auth.ts</c>) sends none.</para>
///
/// <para><c>UserDataEndpoints.UpsertProgress</c> compares that client timestamp against the row's
/// server-written <c>UpdatedAt</c> and, when it is not newer, returns <b>200 with the row
/// untouched</b>. So on a device whose clock is behind the server, tapping "Mark finished" is a
/// no-op that reports success — and <c>useBookActions</c> has already optimistically flipped the
/// shelf to finished, so the UI and the server disagree until the next fetch.</para>
///
/// <para>The same reasoning has already been applied once, in the other direction:
/// <c>UserBookService.UpsertProgressAsync</c> DELETED its client-clock gate for exactly this failure
/// ("a device clock a second behind the server's was silently dropped"). The catalog path kept it.</para>
///
/// <para><b>These two tests are characterization.</b> They assert what the server does today, and
/// they are named for the fact that it is wrong. When the guard is fixed — by ignoring
/// <c>updatedAt</c> for a sentinel write, by comparing client clocks only against client clocks, or
/// by answering 409 instead of a silent 200 — both should be inverted, and the first one's name is
/// the assertion the fix should make true.</para>
///
/// <para>Requires docker compose up + ENABLE_TEST_AUTH=true; skips rather than fails otherwise.</para>
/// </summary>
public class MarkFinishedClientClockTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private const string EndOfBook = """{"type":"end"}""";
    private const string StartOfChapter = """{"type":"start"}""";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// Deliberately NOT the first seeded edition. <c>ProgressUnitEndpointTests</c> takes
    /// <c>/books?limit=1</c> and DELETEs that row's progress for the same test user; xUnit runs the
    /// two classes in parallel, so sharing an edition makes both flaky for reasons that have nothing
    /// to do with what either is testing.
    /// </summary>
    private const int EditionIndex = 1;

    private async Task<(Guid EditionId, Guid ChapterId)?> FindSeededChapterAsync()
    {
        var listResp = await fixture.Client.SendAsync(fixture.CreateRequest(HttpMethod.Get, "/books?limit=5"), Ct);
        if (!listResp.IsSuccessStatusCode) return null;

        var list = await listResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        if (!list.TryGetProperty("items", out var items) || items.GetArrayLength() <= EditionIndex) return null;

        var bookResp = await fixture.Client.SendAsync(
            fixture.CreateRequest(HttpMethod.Get, $"/books/{items[EditionIndex].GetProperty("slug").GetString()}"), Ct);
        if (!bookResp.IsSuccessStatusCode) return null;

        var book = await bookResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        if (!book.TryGetProperty("chapters", out var chapters) || chapters.GetArrayLength() == 0) return null;

        return (book.GetProperty("id").GetGuid(), chapters[0].GetProperty("id").GetGuid());
    }

    private async Task<HttpResponseMessage> PutAsync(Guid editionId, object body)
    {
        var req = auth.CreateRequest(HttpMethod.Put, $"/me/progress/{editionId}");
        req.Content = JsonContent.Create(body);
        return await auth.Client.SendAsync(req, Ct);
    }

    private async Task<JsonElement> ReadAsync(Guid editionId)
    {
        var read = await auth.Client.SendAsync(
            auth.CreateRequest(HttpMethod.Get, $"/me/progress/{editionId}"), Ct);
        return await read.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
    }

    /// <summary>
    /// The payload <c>markProgressFinished(editionId, { chapterId, finished: true })</c> puts on the
    /// wire, with the device clock as the caller supplies it.
    /// </summary>
    private static object MarkFinishedBody(Guid chapterId, DateTimeOffset deviceNow) => new
    {
        chapterId,
        locator = EndOfBook,
        percent = 1.0,
        percentUnit = "book",
        updatedAt = deviceNow.ToString("O"),
    };

    /// <summary>
    /// <b>DEFECT (characterized).</b> Device clock 60 seconds behind the server: the book is not
    /// finished, and the caller is told 200.
    /// </summary>
    [Fact]
    public async Task MarkFinished_DeviceClockBehindTheServer_Returns200AndFinishesNothing()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        // A reader mid-book: a fresh row whose UpdatedAt is the server's "now".
        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
        var seed = await PutAsync(editionId, new
        {
            chapterId,
            locator = StartOfChapter,
            percent = 0.2,
            percentUnit = "book",
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(seed), "endpoint unavailable");
        Assert.True(seed.IsSuccessStatusCode, await seed.Content.ReadAsStringAsync(Ct));

        var put = await PutAsync(editionId, MarkFinishedBody(chapterId, DateTimeOffset.UtcNow.AddSeconds(-60)));
        Assert.SkipWhen(IntegrationSkip.Unavailable(put), "endpoint unavailable");

        // Success, as far as any client can tell — the body is ignored by `authFetch<void>`.
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync(Ct));

        var row = await ReadAsync(editionId);
        // …and nothing moved. This is the line to invert when the guard is fixed:
        // the book SHOULD be finished here.
        Assert.Equal(0.2, row.GetProperty("percent").GetDouble());
        Assert.Equal(StartOfChapter, row.GetProperty("locator").GetString());
        Assert.Equal(JsonValueKind.Null, row.GetProperty("completedAt").ValueKind);

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
    }

    /// <summary>
    /// The control: the same request with a clock that is not behind does finish the book. Without
    /// this, "mark finished never works" would also pass the test above.
    /// </summary>
    [Fact]
    public async Task MarkFinished_DeviceClockAheadOfTheServer_FinishesTheBook()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
        var seed = await PutAsync(editionId, new
        {
            chapterId,
            locator = StartOfChapter,
            percent = 0.2,
            percentUnit = "book",
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(seed), "endpoint unavailable");
        Assert.True(seed.IsSuccessStatusCode, await seed.Content.ReadAsStringAsync(Ct));

        var put = await PutAsync(editionId, MarkFinishedBody(chapterId, DateTimeOffset.UtcNow.AddMinutes(1)));
        Assert.SkipWhen(IntegrationSkip.Unavailable(put), "endpoint unavailable");
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync(Ct));

        var row = await ReadAsync(editionId);
        Assert.Equal(1.0, row.GetProperty("percent").GetDouble());
        Assert.Equal(EndOfBook, row.GetProperty("locator").GetString());
        Assert.Equal(JsonValueKind.String, row.GetProperty("completedAt").ValueKind);

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
    }

    /// <summary>
    /// Web's shape of the same action — no <c>updatedAt</c> at all — is unconditional. Pinned so the
    /// asymmetry between the two clients is visible in the suite rather than only in review.
    /// </summary>
    [Fact]
    public async Task MarkFinished_WithNoClientTimestampAtAll_AlwaysFinishesTheBook()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
        var seed = await PutAsync(editionId, new
        {
            chapterId,
            locator = StartOfChapter,
            percent = 0.2,
            percentUnit = "book",
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(seed), "endpoint unavailable");
        Assert.True(seed.IsSuccessStatusCode, await seed.Content.ReadAsStringAsync(Ct));

        var put = await PutAsync(editionId, new
        {
            chapterId,
            locator = EndOfBook,
            percent = 1.0,
            percentUnit = "book",
        });
        Assert.SkipWhen(IntegrationSkip.Unavailable(put), "endpoint unavailable");
        Assert.True(put.IsSuccessStatusCode, await put.Content.ReadAsStringAsync(Ct));

        var row = await ReadAsync(editionId);
        Assert.Equal(1.0, row.GetProperty("percent").GetDouble());
        Assert.Equal(JsonValueKind.String, row.GetProperty("completedAt").ValueKind);

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
    }
}
