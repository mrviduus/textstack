using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// What number <c>set_book_progress</c> actually writes into the reading state's <c>bookFraction</c>.
///
/// <para>The app derives a book's fraction word-weighted (<c>computeBookProgress</c> in
/// <c>packages/shared/src/reader/bookProgress.ts</c>): the word counts of the chapters before the current
/// one over the book's total. <c>McpToolCatalog.AfterFinishing</c> derives it differently:
/// chapters-done over chapters-total. On a book whose chapters are all the same length the two agree;
/// real uploads are not that shape — front matter is many short chapters and the body one long one.</para>
///
/// <para><b>The first test is characterization of a defect.</b> It asserts the chapter-count number
/// the bridge sends today and states, in the same test, the word-weighted number the reader's own
/// app would have computed for the same position. When the bridge is fixed to weight by
/// <c>wordCount</c> (which <c>get_my_book</c> already returns), the expectations swap.</para>
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

    /// <summary>The app's formula, for the position "just finished chapter <paramref name="index"/>".</summary>
    private static double WordWeighted(int[] wordCounts, int finishedIndexInclusive)
    {
        var total = wordCounts.Sum();
        var done = wordCounts.Take(finishedIndexInclusive + 1).Sum();
        return (double)done / total;
    }

    private JsonElement SentBody() => JsonDocument.Parse(_harness.Stub.Last("v2_put_reading_state")!.Body).RootElement;

    /// <summary>
    /// <b>DEFECT (characterized).</b> The reader finished the preface — the 5th of six chapters, and
    /// 4% of the words. The bridge records 83%.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_ShortFrontMatter_WritesChaptersDoneNotWordsRead()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "set_book_progress",
            Args(("bookId", StubBackend.FrontMatterBookId), ("chapterSlug", "preface"))!,
            cancellationToken: Ct);

        AssertOk(result);
        Assert.False(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("bookFinished").GetBoolean());
        var sent = (double)SentBody().GetProperty("bookFraction").GetDecimal();

        // 5 of 6 chapters.
        Assert.Equal(5d / 6d, sent, 6);

        // What the reader's own app would have stored for the same position: 1888 of 45204 words.
        var honest = WordWeighted(StubBackend.FrontMatterWordCounts, finishedIndexInclusive: 4);
        Assert.True(honest < 0.05, $"fixture check: expected the preface to be <5% of the book, got {honest:P1}");

        // The two disagree by more than 75 points on an ordinary non-fiction shape.
        Assert.True(sent - honest > 0.75,
            $"expected a large divergence to characterize; sent {sent:P1}, word-weighted {honest:P1}");
    }

    /// <summary>
    /// Finishing the last chapter must be exactly 1.0 and complete the book, whichever formula is
    /// used: a book the reader said they finished has to be finished.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_LastChapterOfALopsidedBook_IsExactlyOneAndCompleted()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "set_book_progress",
            Args(("bookId", StubBackend.FrontMatterBookId), ("chapterSlug", "the-book-itself"))!,
            cancellationToken: Ct);

        AssertOk(result);
        Assert.True(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("bookFinished").GetBoolean());
        Assert.Equal(1m, SentBody().GetProperty("bookFraction").GetDecimal());
        Assert.Equal(JsonValueKind.String, SentBody().GetProperty("completedAt").ValueKind);
    }
}
