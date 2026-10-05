using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// 2026-10 reader audit H1: Retry on a Ready upload re-extracted it by deleting every chapter and
/// inserting new ones, so the reader's highlights and bookmarks lost their chapter (SET NULL).
/// Re-extraction now updates chapters in place (ChapterReconciler). Needs the worker running —
/// skips when the book never reaches Ready.
/// </summary>
public class ReingestKeepsReaderDataTests(AuthenticatedApiFixture auth) : IClassFixture<AuthenticatedApiFixture>
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task RetryReadyBook_SameContent_ChapterIdsBookmarksHighlightsAndProgressUnchanged()
    {
        Assert.SkipUnless(auth.IsAuthenticated, "test auth unavailable");

        var clip = auth.CreateRequest(HttpMethod.Post, "/me/books/clip");
        clip.Content = JsonContent.Create(new
        {
            title = $"Reingest {Guid.NewGuid():N}"[..20],
            html = "<h1>Reingest</h1><p>Real fluency comes from real books, read to the end.</p>",
            language = "en"
        });
        var clipped = await auth.Client.SendAsync(clip, Ct);
        Assert.SkipWhen(clipped.StatusCode == HttpStatusCode.TooManyRequests, "clip rate limited");
        Assert.Equal(HttpStatusCode.OK, clipped.StatusCode);
        var bookId = (await clipped.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("userBookId").GetGuid();

        try
        {
            var before = await WaitForReadyAsync(bookId);
            Assert.SkipWhen(before is null, "worker did not process the clip");
            var chapter = before!.Value.GetProperty("chapters")[0];
            var chapterId = chapter.GetProperty("id").GetGuid();
            var slug = chapter.GetProperty("slug").GetString();

            var bm = auth.CreateRequest(HttpMethod.Post, $"/me/books/{bookId}/bookmarks");
            bm.Content = JsonContent.Create(new { chapterId, locator = $"scroll:{slug}:10", title = "here" });
            Assert.True((await auth.Client.SendAsync(bm, Ct)).IsSuccessStatusCode, "bookmark");

            var hl = auth.CreateRequest(HttpMethod.Post, "/me/highlights");
            hl.Content = JsonContent.Create(new
            {
                userBookId = bookId,
                userChapterId = chapterId,
                anchorJson = """{"prefix":"","exact":"real books","suffix":""}""",
                color = "yellow",
                selectedText = "real books"
            });
            Assert.Equal(HttpStatusCode.Created, (await auth.Client.SendAsync(hl, Ct)).StatusCode);

            var progress = auth.CreateRequest(HttpMethod.Put, $"/me/books/{bookId}/progress");
            progress.Content = JsonContent.Create(new { chapterSlug = slug, locator = $"scroll:{slug}:10", percent = 0.5, percentUnit = "book" });
            Assert.True((await auth.Client.SendAsync(progress, Ct)).IsSuccessStatusCode, "progress");

            var retry = await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Post, $"/me/books/{bookId}/retry"), Ct);
            Assert.True(retry.IsSuccessStatusCode, $"retry: {retry.StatusCode}");
            var after = await WaitForReadyAsync(bookId);
            Assert.SkipWhen(after is null, "worker did not re-process the book");

            Assert.Equal(chapterId, after!.Value.GetProperty("chapters")[0].GetProperty("id").GetGuid());

            var bookmarks = await GetJsonAsync($"/me/books/{bookId}/bookmarks");
            Assert.Equal(chapterId, Assert.Single(bookmarks.EnumerateArray()).GetProperty("chapterId").GetGuid());

            var highlights = await GetJsonAsync($"/me/highlights/userbook/{bookId}");
            Assert.Equal(chapterId, Assert.Single(highlights.EnumerateArray()).GetProperty("userChapterId").GetGuid());

            var savedProgress = await GetJsonAsync($"/me/books/{bookId}/progress");
            Assert.Equal(slug, savedProgress.GetProperty("chapterSlug").GetString());
        }
        finally
        {
            await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Delete, $"/me/books/{bookId}"), Ct);
        }
    }

    private async Task<JsonElement> GetJsonAsync(string path)
    {
        var resp = await auth.Client.SendAsync(auth.CreateRequest(HttpMethod.Get, path), Ct);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return await resp.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private async Task<JsonElement?> WaitForReadyAsync(Guid bookId)
    {
        for (var i = 0; i < 60; i++)
        {
            var book = await GetJsonAsync($"/me/books/{bookId}");
            if (book.GetProperty("status").GetString() == "Ready" && book.GetProperty("chapters").GetArrayLength() > 0)
                return book;
            await Task.Delay(1000, Ct);
        }
        return null;
    }
}
