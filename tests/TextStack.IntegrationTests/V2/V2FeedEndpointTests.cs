using System.Net;
using System.Text.Json;
using static TextStack.IntegrationTests.V2.V2ApiFixture;

namespace TextStack.IntegrationTests.V2;

/// <summary>
/// The three change feeds of v2-sync-protocol.md "Pull and push", each on a fresh guest so the feed
/// holds exactly what the test wrote: paged one row at a time by cursor, tombstones included, and a
/// pull resumed from the final cursor re-delivering the last 30 s.
/// </summary>
public class V2FeedEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    /// <summary>Every row of the feed, one page of one row at a time; and the final cursor.</summary>
    private async Task<(List<JsonElement> Rows, string Cursor)> PullAsync(V2Session who, string feed)
    {
        var rows = new List<JsonElement>();
        string? cursor = null;
        for (var pages = 0; pages < 20; pages++)
        {
            var page = await v2.SendAsync(who, HttpMethod.Get, $"/me/v2/{feed}/changes?limit=1" + (cursor is null ? "" : $"&cursor={cursor}"));
            Assert.Equal(HttpStatusCode.OK, page.Status);
            rows.AddRange(page.Body.GetProperty("items").EnumerateArray());
            cursor = page.Body.GetProperty("cursor").GetString();
            if (!page.Body.GetProperty("hasMore").GetBoolean()) return (rows, cursor!);
        }
        throw new InvalidOperationException("the feed never ended");
    }

    private async Task<int> ResumeCountAsync(V2Session who, string feed, string cursor) =>
        (await v2.SendAsync(who, HttpMethod.Get, $"/me/v2/{feed}/changes?cursor={cursor}")).Body.GetProperty("items").GetArrayLength();

    [Fact]
    public async Task LibraryChanges_PagedByCursor_HasEveryBookOnceWithTheRemovedOneAsATombstone()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var books = new[] { await v2.ImportAsync(guest), await v2.ImportAsync(guest), await v2.ImportAsync(guest) };
        await v2.SendAsync(guest, HttpMethod.Delete, $"/me/v2/books/{books[0].Book}");

        var (rows, cursor) = await PullAsync(guest, "library");

        Assert.Equal([books[1].Book, books[2].Book, books[0].Book], rows.Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.String, rows[2].GetProperty("removedAt").ValueKind);
        Assert.All(rows, r => Assert.NotEqual(JsonValueKind.Null, r.GetProperty("currentFile").ValueKind));
        Assert.Equal(3, await ResumeCountAsync(guest, "library", cursor));
    }

    [Fact]
    public async Task ReadingChanges_PagedByCursor_HasEachBooksState()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var first = await v2.ImportAsync(guest);
        var second = await v2.ImportAsync(guest);
        await v2.WriteStateAsync(guest, first.Book, State(first.File, null));
        await v2.WriteStateAsync(guest, second.Book, State(second.File, null));

        var (rows, cursor) = await PullAsync(guest, "reading");

        Assert.Equal([first.Book, second.Book], rows.Select(r => r.GetProperty("bookId").GetGuid()));
        Assert.Equal(2, await ResumeCountAsync(guest, "reading", cursor));
    }

    [Fact]
    public async Task AnnotationChanges_PagedByCursor_HasTheDeletedOneAsATombstone()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var (bookId, _, _) = await v2.ImportAsync(guest);
        var (deleted, kept) = (Guid.NewGuid(), Guid.NewGuid());
        foreach (var id in new[] { deleted, kept })
            await v2.SendAsync(guest, HttpMethod.Put, $"/me/v2/annotations/{id}", new { expectedRevision = (long?)null, bookId, selectedText = "a quotation" });
        await v2.SendAsync(guest, HttpMethod.Delete, $"/me/v2/annotations/{deleted}");

        var (rows, _) = await PullAsync(guest, "annotations");

        Assert.Equal([kept, deleted], rows.Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.String, rows[1].GetProperty("deletedAt").ValueKind);
    }

    [Fact]
    public async Task Changes_EmptyCursorAndLimit_AreAFullPull()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var (bookId, _, _) = await v2.ImportAsync(guest);

        var page = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/library/changes?cursor=&limit=");

        Assert.Equal((HttpStatusCode.OK, bookId), (page.Status, page.Body.GetProperty("items")[0].GetProperty("id").GetGuid()));
    }

    [Fact]
    public async Task Changes_ForeignCursor_IsInvalidPayload()
    {
        v2.Require();

        var response = await v2.SendAsync(v2.Alice, HttpMethod.Get, "/me/v2/library/changes?cursor=bm90LWEtY3Vyc29y");

        Assert.Equal((HttpStatusCode.BadRequest, "cursor"), (response.Status, response.Body.GetProperty("field").GetString()));
    }

    [Fact]
    public async Task LibraryChanges_AnotherUser_SeesNoneOfTheGuestsBooks()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var other = await v2.NewGuestAsync();
        await v2.ImportAsync(guest);

        Assert.Empty((await PullAsync(other, "library")).Rows);
    }
}
