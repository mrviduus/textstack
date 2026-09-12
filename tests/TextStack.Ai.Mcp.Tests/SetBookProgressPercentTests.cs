using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;

namespace TextStack.Ai.Mcp.Tests;

/// <summary>
/// What number <c>set_book_progress</c> actually writes into <c>ReadingProgress.Percent</c>.
///
/// <para>That column is the ONE canonical answer to "how far through is this book" — every shelf,
/// card and detail screen reads it, and the whole <c>percentUnit</c> contract exists to keep a
/// client from putting a differently-derived number in it (see
/// <c>Application.ReadingTracking.ProgressUnit</c>). The app derives it word-weighted:
/// <c>computeBookProgress</c> in <c>packages/shared/src/reader/bookProgress.ts</c> sums the word
/// counts of the chapters before the current one over the book's total.</para>
///
/// <para><c>McpToolCatalog.AfterFinishing</c> derives it differently: chapters-done over
/// chapters-total. Both declare <c>percentUnit: "book"</c>, so the server trusts both. On a book
/// whose chapters are all the same length the two agree and nothing shows — which is why
/// <c>McpOverTheWireTests</c>, whose Dracula fixture has two chapters of 4200 and 3900 words, cannot
/// see this. Real uploads are not that shape: front matter is many short chapters and the body is
/// one or two long ones.</para>
///
/// <para><b>The first test is characterization of a defect.</b> It asserts the chapter-count number
/// the bridge sends today and states, in the same test, the word-weighted number the reader's own
/// app would have computed for the same position. When the bridge is fixed to weight by
/// <c>wordCount</c> (which <c>get_book</c> and <c>get_my_book</c> both already return, alongside
/// <c>totalWordCount</c>), the expectations swap.</para>
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
            Args(("slug", StubBackend.FrontMatterSlug), ("chapterSlug", "preface"))!,
            cancellationToken: Ct);

        AssertOk(result);

        var body = JsonDocument.Parse(_harness.Stub.Last("set_edition_progress")!.Body).RootElement;
        var sent = body.GetProperty("percent").GetDouble();

        // 5 of 6 chapters.
        Assert.Equal(5d / 6d, sent, 6);
        Assert.Equal("book", body.GetProperty("percentUnit").GetString());

        // What the reader's own app would have stored for the same position: 1888 of 45204 words.
        var honest = WordWeighted(StubBackend.FrontMatterWordCounts, finishedIndexInclusive: 4);
        Assert.True(honest < 0.05, $"fixture check: expected the preface to be <5% of the book, got {honest:P1}");

        // The two disagree by more than 75 points on an ordinary non-fiction shape, and the larger
        // one is the one that gets stored — the smaller is only ever recomputed inside the reader.
        Assert.True(sent - honest > 0.75,
            $"expected a large divergence to characterize; sent {sent:P1}, word-weighted {honest:P1}");
    }

    /// <summary>
    /// The same call on a book whose chapters ARE evenly sized: the two formulas agree, which is
    /// exactly why the existing Dracula fixture cannot show the problem. Kept so a future reader can
    /// see that the fixture, not the code, was what made this invisible.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_EvenChapters_ChapterCountAndWordWeightedAgree()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "set_book_progress",
            Args(("slug", "dracula"), ("chapterSlug", "ch-1"))!,
            cancellationToken: Ct);

        AssertOk(result);

        var sent = JsonDocument.Parse(_harness.Stub.Last("set_edition_progress")!.Body)
            .RootElement.GetProperty("percent").GetDouble();
        var honest = WordWeighted([4200, 3900], finishedIndexInclusive: 0);

        Assert.Equal(0.5, sent, 6);
        Assert.True(Math.Abs(sent - honest) < 0.02,
            $"fixture check: the two formulas should be within 2 points here; {sent:P1} vs {honest:P1}");
    }

    /// <summary>
    /// Finishing the last chapter must round to exactly 1.0 whichever formula is used — the server
    /// turns <c>&gt;= 0.99</c> into <c>CompletedAt</c>, and a book the reader said they finished has
    /// to be finished.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_LastChapterOfALopsidedBook_IsExactlyOne()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "set_book_progress",
            Args(("slug", StubBackend.FrontMatterSlug), ("chapterSlug", "the-book-itself"))!,
            cancellationToken: Ct);

        AssertOk(result);
        var json = JsonDocument.Parse(TextOf(result)).RootElement;
        Assert.True(json.GetProperty("bookFinished").GetBoolean());

        var body = JsonDocument.Parse(_harness.Stub.Last("set_edition_progress")!.Body).RootElement;
        Assert.Equal(1d, body.GetProperty("percent").GetDouble());
        Assert.Equal("""{"type":"end"}""", body.GetProperty("locator").GetString());
    }

    /// <summary>
    /// The inverse of the front-matter case, and the one that costs the reader most: a book whose
    /// LAST chapter is a one-page acknowledgements section. Finishing the real final chapter is 99%
    /// of the words and the bridge records it as 83%, so the book does not become finished.
    /// </summary>
    [Fact]
    public async Task SetBookProgress_SecondToLastChapter_DoesNotFinishABookTheReaderHasEffectivelyFinished()
    {
        await using var client = await _harness.ConnectAsync(McpServerHarness.TestJwt, Ct);

        var result = await client.CallToolAsync(
            "set_book_progress",
            Args(("slug", StubBackend.FrontMatterSlug), ("chapterSlug", "preface"))!,
            cancellationToken: Ct);

        AssertOk(result);
        Assert.False(JsonDocument.Parse(TextOf(result)).RootElement.GetProperty("bookFinished").GetBoolean());

        var sent = JsonDocument.Parse(_harness.Stub.Last("set_edition_progress")!.Body)
            .RootElement.GetProperty("percent").GetDouble();
        Assert.True(sent < 0.99, "chapters-done never reaches the completion threshold before the last chapter");
    }
}
