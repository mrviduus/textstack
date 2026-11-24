using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// What number <c>set_book_progress</c> writes into the reading state's <c>bookFraction</c>, and which chapter
/// <c>get_book_progress</c> reads back, on the reader's TOC (ADR-033 P4).
///
/// <para>The app measures a position as a fraction of the book; the TOC the reader syncs carries where each
/// entry starts on that same scale. Mapping a chapter to its entry's fraction is what makes the assistant's
/// number agree with the app's (#1515: it used to write chapters-done over chapters-total, 83% for a reader
/// who had finished the front matter of a book whose body is one long chapter).</para>
/// </summary>
public class SetBookProgressPercentTests : IAsyncLifetime
{
    private McpServerHarness _harness = null!;

    public async ValueTask InitializeAsync() =>
        _harness = await McpServerHarness.StartAsync(TestContext.Current.CancellationToken);

    public async ValueTask DisposeAsync() => await _harness.DisposeAsync();

    private CancellationToken Ct => TestContext.Current.CancellationToken;

    private static Dictionary<string, object?> Args(params (string Key, object? Value)[] pairs)
    {
        var d = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (k, v) in pairs) d[k] = v;
        return d;
    }

    private static string TextOf(CallToolResult r) => ((TextContentBlock)r.Content[0]).Text;

    private static void AssertOk(CallToolResult r) => Assert.False(r.IsError == true, TextOf(r));

    private JsonElement SentBody() => JsonDocument.Parse(_harness.Stub.Last("v2_put_reading_state")!.Body).RootElement;

    private async Task<CallToolResult> SetAsync(string bookId, string chapterSlug)
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);
        return await client.CallToolAsync("set_book_progress", Args(("bookId", bookId), ("chapterSlug", chapterSlug))!, cancellationToken: Ct);
    }

    /// <summary>
    /// The reader finished the preface: the 5th of six chapters, and 4% of the words. The position is where the
    /// next chapter starts in the TOC, the number the reader's own app would show; not 5/6.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_ShortFrontMatter_WritesWhereTheNextChapterStarts()
    {
        var result = await SetAsync(StubBackend.FrontMatterBookId, "preface");

        AssertOk(result);
        Assert.Equal(("the-book-itself", false),
            (JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("resumeChapterSlug").GetString(),
             JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("bookFinished").GetBoolean()));
        var sent = SentBody().GetProperty("bookFraction").GetDecimal();
        Assert.Equal(StubBackend.FrontMatterStart(5), sent);
        Assert.True(sent < 0.05m, $"the front matter is under 5% of the book, sent {sent:P1}");
    }

    [Fact]
    public async Task SetBookProgress_BookWhoseTocTheReaderHasNotSynced_IsRefusedWithWhatToDo()
    {
        var result = await SetAsync(StubBackend.NoTocBookId, "one");

        Assert.True(result.IsError);
        Assert.Contains("open the book once", TextOf(result));
        Assert.Null(_harness.Stub.Last("v2_put_reading_state"));
    }

    /// <summary>A reader locator names no chapter; the chapter is the last TOC entry starting at or before the position.</summary>
    [Fact]
    public async Task GetBookProgress_LocatorWithoutAChapter_NamesTheTocEntryAtTheFraction()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync("get_book_progress", Args(("bookId", StubBackend.FrontMatterBookId))!, cancellationToken: Ct);

        AssertOk(result);
        Assert.Equal("the-book-itself", JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("chapterSlug").GetString());
    }

    /// <summary>
    /// Finishing the last chapter is exactly 1.0 and completes the book, though a section of that chapter
    /// follows it in the TOC: a book the reader said they finished has to be finished.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_LastChapterWithASectionAfterIt_IsExactlyOneAndCompleted()
    {
        var result = await SetAsync(StubBackend.FrontMatterBookId, "the-book-itself");

        AssertOk(result);
        Assert.True(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("bookFinished").GetBoolean());
        Assert.Equal(1m, SentBody().GetProperty("bookFraction").GetDecimal());
        Assert.Equal(JsonValueKind.String, SentBody().GetProperty("completedAt").ValueKind);
    }
}
