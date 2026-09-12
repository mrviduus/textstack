using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// What <c>get_my_reading</c> can see after <c>set_book_progress</c> has written.
///
/// <para>#601 gave the assistant three tools and told it, in <c>get_my_reading</c>'s own description,
/// "Call this FIRST when you do not already have a bookId or editionId — nothing else here can find a
/// book without one." That tool is <c>GET /me/library/shelves</c>. Its saved-book shelf is an INNER
/// JOIN on <c>user_libraries</c>: a catalog book the reader has never explicitly saved is not on it,
/// whatever its progress says.</para>
///
/// <para>The reader's own app hides this because <c>ReaderPage</c> auto-adds a book to the library at
/// 1% (<c>apps/web/src/pages/ReaderPage.tsx</c>). <c>set_book_progress</c> does not: it writes
/// <c>PUT /me/progress/{editionId}</c> and nothing else. So an assistant that records "you finished
/// chapter 3 of Dracula" for a book the reader has read only outside the app cannot find that book
/// again on its next call — <c>get_book_progress</c> still answers, but only if the model still
/// happens to hold the editionId.</para>
///
/// <para><b>Characterization.</b> The first test asserts the hole. When <c>set_book_progress</c>
/// starts putting the book on the shelf (a <c>POST /me/library/{editionId}</c> alongside the
/// progress write), it should assert presence instead.</para>
///
/// <para>Requires docker compose up + ENABLE_TEST_AUTH=true; skips rather than fails otherwise.</para>
/// </summary>
public class ShelfAfterAssistantProgressTests(LiveApiFixture fixture, AuthenticatedApiFixture auth)
    : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>
    /// A third edition, for the same reason <c>MarkFinishedClientClockTests</c> takes the second:
    /// these classes run in parallel against one test user, and each rewrites the progress row of
    /// the edition it picks. Index 0 belongs to <c>ProgressUnitEndpointTests</c>.
    /// </summary>
    private const int EditionIndex = 2;

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

    /// <summary>Every edition id on the "continue reading" + "finished this month" shelves.</summary>
    private async Task<HashSet<Guid>> ShelfEditionIdsAsync()
    {
        var resp = await auth.Client.SendAsync(
            auth.CreateRequest(HttpMethod.Get, "/me/library/shelves"), Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/library/shelves unavailable");
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        var ids = new HashSet<Guid>();
        foreach (var shelf in new[] { "continueReading", "finishedThisMonth" })
        {
            if (!body.TryGetProperty(shelf, out var arr) || arr.ValueKind != JsonValueKind.Array) continue;
            foreach (var item in arr.EnumerateArray())
            {
                if (item.TryGetProperty("type", out var t) && t.GetString() == "savedbook"
                    && item.TryGetProperty("id", out var id))
                    ids.Add(id.GetGuid());
            }
        }
        return ids;
    }

    /// <summary>
    /// <b>DEFECT (characterized).</b> The exact write <c>set_book_progress</c> makes for a catalog
    /// book, on a book the reader has not saved: stored, readable by edition id, invisible to the
    /// shelf the assistant is told to start from.
    /// </summary>
    [Fact]
    public async Task ProgressWrittenWithoutSavingTheBook_IsInvisibleToTheShelf()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        // Start from "not saved, no progress".
        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/library/{editionId}"), Ct);
        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);

        var put = auth.CreateRequest(HttpMethod.Put, $"/me/progress/{editionId}");
        put.Content = JsonContent.Create(new
        {
            chapterId,
            locator = """{"type":"start"}""",
            percent = 0.25,
            percentUnit = "book",
        });
        var wrote = await auth.Client.SendAsync(put, Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(wrote), "/me/progress unavailable");
        Assert.True(wrote.IsSuccessStatusCode, await wrote.Content.ReadAsStringAsync(Ct));

        // The position is genuinely there — get_book_progress answers from this.
        var read = await auth.Client.SendAsync(
            auth.CreateRequest(HttpMethod.Get, $"/me/progress/{editionId}"), Ct);
        var row = await read.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: Ct);
        Assert.Equal(0.25, row.GetProperty("percent").GetDouble());

        // …and the shelf the assistant is told to call FIRST does not list it.
        Assert.DoesNotContain(editionId, await ShelfEditionIdsAsync());

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
    }

    /// <summary>
    /// The control: the same progress, plus the library row the reader's own app would have created
    /// at 1%, and the book appears. Without this, "the shelf is always empty" would also pass above.
    /// </summary>
    [Fact]
    public async Task SameProgress_WithTheLibraryRowTheAppWouldHaveCreated_IsOnTheShelf()
    {
        var seeded = await FindSeededChapterAsync();
        Assert.SkipWhen(seeded is null, "no seeded edition with chapters");
        Assert.SkipWhen(!auth.IsAuthenticated, "test auth unavailable");
        var (editionId, chapterId) = seeded!.Value;

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);

        var put = auth.CreateRequest(HttpMethod.Put, $"/me/progress/{editionId}");
        put.Content = JsonContent.Create(new
        {
            chapterId,
            locator = """{"type":"start"}""",
            percent = 0.25,
            percentUnit = "book",
        });
        var wrote = await auth.Client.SendAsync(put, Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(wrote), "/me/progress unavailable");
        Assert.True(wrote.IsSuccessStatusCode, await wrote.Content.ReadAsStringAsync(Ct));

        var saved = await auth.Client.SendAsync(
            auth.CreateRequest(HttpMethod.Post, $"/me/library/{editionId}"), Ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(saved), "/me/library unavailable");

        Assert.Contains(editionId, await ShelfEditionIdsAsync());

        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/progress/{editionId}"), Ct);
        await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/library/{editionId}"), Ct);
    }
}
