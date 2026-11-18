using System.Text.Json;
using Application.Sync;
using Contracts.V2;
using static Application.Sync.SyncValidation;
using static Contracts.V2.SyncLimits;

namespace TextStack.UnitTests.V2;

/// <summary>
/// The payload rules of v2-sync-protocol.md "Payloads": what a V2 write accepts, and what it refuses with
/// 400 <c>invalid_payload</c> naming the field. One story per payload kind; each refusal is a row.
/// </summary>
public class SyncValidationTests
{
    private static readonly string Hash = new('a', 64);
    private static readonly DateTimeOffset Now = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    private static JsonElement Json(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static string? FieldOf(SyncResult? result) => result is null ? null : Assert.IsType<V2Error>(result.Body).Field;

    // ---- An uploaded file version ----

    private static readonly BookFileRequest Upload = new(Guid.NewGuid(), Hash, 10, "book.epub", "epub", null, null);

    // #1128: every format the reader opens (ADR-032) is a client upload, a TOC beside it.
    [Theory]
    [InlineData("epub")]
    [InlineData("pdf")]
    [InlineData("mobi")]
    [InlineData("azw3")]
    [InlineData("fb2")]
    [InlineData("cbz")]
    public void File_AReaderFormatUpload_Passes(string format) =>
        Assert.Null(File("file.", Upload with { Format = format, OriginalName = "book." + format, Toc = """[{"title":"One","children":[]}]""" }));

    public static TheoryData<string, BookFileRequest?> BrokenUploads => new()
    {
        { "file", null },
        // Lowercase only: the client keys its local files by the hash, so uppercase is refused, never lowered.
        { "file.sha256", Upload with { Sha256 = Hash.ToUpperInvariant() } },
        { "file.sha256", Upload with { Sha256 = Hash + "\n" } },
        { "file.sha256", Upload with { Sha256 = null } },
        { "file.byteSize", Upload with { ByteSize = 0 } },
        { "file.originalName", Upload with { OriginalName = "book\u0000.epub" } },
        { "file.originalName", Upload with { OriginalName = " " } },
        // html is server-only (clips); the format is lowercase, as the schema's CHECK.
        { "file.format", Upload with { Format = "html" } },
        { "file.format", Upload with { Format = "docx" } },
        { "file.format", Upload with { Format = "MOBI" } },
        { "file.toc", Upload with { Toc = """{"chapters":[]}""" } },
        { "file.toc", Upload with { Toc = """[{"title":"one","children":[{"title":"t\u0000"}]}]""" } },
        { "file.toc", Upload with { Toc = "[\"" + new string('t', 256 * 1024) + "\"]" } },
    };

    [Theory]
    [MemberData(nameof(BrokenUploads))]
    public void File_BrokenUpload_IsRefusedNamingTheField(string field, BookFileRequest? file) =>
        Assert.Equal(field, FieldOf(File("file.", file)));

    // ---- A locator: where a reading position or an annotation points ----

    private static string Locator(string scheme, string value, string extra = "") =>
        $$"""{"version":1,"scheme":"{{scheme}}","value":{{value}}{{extra}}}""";

    private static string Cfi(string members) => $$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)"{{members}}}""";

    private static string PageName(string value, string extra = "") => Locator("page-name", value, extra);

    // The legacy reader's position as serializeTextPosition writes it (its own "v" included), and its highlight anchor.
    private const string Anchor = """{"prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";
    private const string TextPositionValue = $$"""{"v":1,"chapterSlug":"ch-1","anchor":{{Anchor}},"charOffset":6,"chapterFraction":0.25}""";
    private const string TextAnchorValue = """{"chapterKey":"ch-1","prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";

    private static string TextPosition(string value = TextPositionValue, string extra = "") => Locator("textstack-position-v1", value, extra);

    private static string TextAnchor(string value = TextAnchorValue) => Locator("textstack-anchor-v1", value);

    /// <summary><paramref name="json"/> with one member set to <paramref name="value"/> (JSON), or removed when it is null.</summary>
    private static string With(string json, string member, string? value)
    {
        var members = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
        if (value is null) members.Remove(member);
        else members[member] = Json(value);
        return JsonSerializer.Serialize(members);
    }

    private static string Quoted(char c, int count) => $"\"{new string(c, count)}\"";

    private static readonly string Emoji64 = string.Concat(Enumerable.Repeat("😀", 64));

    public static TheoryData<LocatorUse, string> WhatReadersWrite => new()
    {
        // V2 positions: a CFI with the quote at it (64 code points, though 128 UTF-16 units), a PDF page.
        { LocatorUse.Position, Cfi(""","quote":"It was" """) },
        { LocatorUse.Position, Cfi($$""","quote":"{{Emoji64}}" """) },
        { LocatorUse.Position, Locator("pdf-page", """{"page":3}""") },
        // #1188: a page by its stable key (a CBZ entry name), its 0-based section beside it.
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"index":41,"page":"Vol 1/Ch 3/042.jpg"}""") },
        { LocatorUse.Position, PageName("""{"page":"страница 1.webp","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"😀.png","index":2147483647}""") },
        { LocatorUse.Position, PageName($$"""{"page":"{{new string('a', MaxPageName)}}","index":0}""") },
        // The transitional reader: its position as serialized, scroll-only (no anchor), at the caps.
        { LocatorUse.Position, TextPosition() },
        { LocatorUse.Position, TextPosition("""{"chapterSlug":"ch-1","chapterFraction":0}""") },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", Quoted('k', MaxChapterKey))) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "anchor", With(Anchor, "exact", Quoted('q', 64)))) },
        // Annotations: a CFI may carry context and no quote; the legacy PDF anchor; the transitional anchor at its caps.
        { LocatorUse.Annotation, Cfi(""","prefix":"before ","suffix":" after" """) },
        { LocatorUse.Annotation, Locator("pdf-page", """{"page":2,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"quoted"}""") },
        { LocatorUse.Annotation, TextAnchor() },
        { LocatorUse.Annotation, TextAnchor(With(With(TextAnchorValue, "prefix", Quoted('p', 32)), "suffix", Quoted('s', 32))) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", int.MaxValue.ToString())) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", Quoted('q', MaxSelectedText))) },
    };

    [Theory]
    [MemberData(nameof(WhatReadersWrite))]
    public void Locator_WhatAReaderWrites_Passes(LocatorUse use, string locator) =>
        Assert.Null(SyncValidation.Locator(Json(locator), "locator", use));

    public static TheoryData<LocatorUse, string> BrokenLocators => new()
    {
        // Unstorable anywhere (NUL, lone surrogate, even in a member name): refused, never thrown.
        { LocatorUse.Position, Cfi(""","quote":"\ud800" """) },
        { LocatorUse.Position, Cfi(""","quote":"a\u0000" """) },
        { LocatorUse.Position, Cfi(""","quote":"ok","x\u0000":1""") },
        // The envelope.
        { LocatorUse.Position, """{"version":2,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"x"}""" },
        { LocatorUse.Position, """{"version":1,"scheme":"epub-cfi","value":null,"quote":"x"}""" },
        { LocatorUse.Position, """["not","an","object"]""" },
        { LocatorUse.Position, Locator("Page-Name", """{"page":"p01.png","index":0}""") },
        { LocatorUse.Annotation, """{"version":1,"value":"x","quote":"q"}""" },
        { LocatorUse.Annotation, """{"version":1,"scheme":"cfi","value":"x","quote":"q"}""" },
        // epub-cfi: a position needs its quote (a page member does not stand in), 1-64 code points; context 32.
        { LocatorUse.Position, Cfi("") },
        { LocatorUse.Position, Cfi(""","page":"p01.png" """) },
        { LocatorUse.Position, Cfi($$""","quote":"{{Emoji64}}a" """) },
        { LocatorUse.Position, """{"version":1,"scheme":"epub-cfi","value":" ","quote":"x"}""" },
        { LocatorUse.Annotation, Cfi($$""","prefix":"{{new string('p', 33)}}" """) },
        // pdf-page: a position is {page:N≥1} only, no quote; an annotation needs its rects and exact.
        { LocatorUse.Position, Locator("pdf-page", """{"page":0}""") },
        { LocatorUse.Position, Locator("pdf-page", """{"page":3,"rects":[]}""") },
        { LocatorUse.Position, Locator("pdf-page", """{"page":3}""", ""","quote":"x" """) },
        { LocatorUse.Annotation, Locator("pdf-page", """{"page":2,"rects":[{"x":0.1}],"exact":"quoted"}""") },
        // page-name: {page,index} and nothing else; page 1-512 units, no control character; index an int32 ≥ 0.
        { LocatorUse.Position, PageName($$"""{"page":"{{new string('a', MaxPageName + 1)}}","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"   ","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\nb.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\u0001.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\u007f.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\u0085.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\u0000.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"a\ud800.png","index":0}""") },
        { LocatorUse.Position, PageName("""{"page":7,"index":0}""") },
        { LocatorUse.Position, PageName("""{"page":null,"index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png"}""") },
        { LocatorUse.Position, PageName("""{"index":0}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":-1}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":1.5}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":"0"}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":2147483648}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0,"fraction":0.5}""") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0,"cfi":"epubcfi(/6/2)"}""") },
        { LocatorUse.Position, PageName("""["p01.png",0]""") },
        { LocatorUse.Position, PageName("\"p01.png\"") },
        { LocatorUse.Position, PageName("3") },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0}""", ""","quote":"x" """) },
        // A CBZ has no text to highlight: page-name never anchors an annotation.
        { LocatorUse.Annotation, PageName("""{"page":"p01.png","index":0}""") },
        // textstack-position-v1: one rule broken at a time; a position only, never with a quote.
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", null)) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", "\" \"")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", "1")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", Quoted('k', MaxChapterKey + 1))) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", null)) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "1.01")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "-0.01")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "\"0.5\"")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "anchor", "null")) },
        // A position quotes textPosition.ts's POSITION_QUOTE_LENGTH (64); a highlight quotes whatever was selected.
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "anchor", With(Anchor, "exact", Quoted('q', 65)))) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "charOffset", "-1")) },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "charOffset", "1.5")) },
        { LocatorUse.Position, TextPosition(extra: ""","quote":"x" """) },
        { LocatorUse.Annotation, TextPosition() },
        // textstack-anchor-v1: one rule broken at a time; an annotation only. Offsets are int32, never clamped.
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "chapterKey", null)) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "chapterKey", "\"\"")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", null)) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", "\"\"")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", Quoted('q', MaxSelectedText + 1))) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "prefix", null)) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "prefix", Quoted('p', 33))) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "suffix", Quoted('s', 33))) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "suffix", "null")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", null)) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", "-1")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", "\"6\"")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", null)) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", "5")) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", "2147483648")) },
        { LocatorUse.Position, TextAnchor() },
    };

    [Theory]
    [MemberData(nameof(BrokenLocators))]
    public void Locator_OutsideItsSchemeShape_IsRefusedNamingTheField(LocatorUse use, string locator) =>
        Assert.Equal("locator", FieldOf(SyncValidation.Locator(Json(locator), "locator", use)));

    // #1122/#1128: pdf-page only on a PDF; epub-cfi on every other format, never on a PDF; textstack-* anywhere;
    // page-name on a CBZ (#1188) and an EPUB (#1196: a pre-paginated one; the server cannot tell which).
    [Theory]
    [InlineData("pdf-page", "pdf", true)]
    [InlineData("pdf-page", "epub", false)]
    [InlineData("pdf-page", "mobi", false)]
    [InlineData("epub-cfi", "pdf", false)]
    [InlineData("epub-cfi", "epub", true)]
    [InlineData("epub-cfi", "html", true)]
    [InlineData("epub-cfi", "mobi", true)]
    [InlineData("epub-cfi", "azw3", true)]
    [InlineData("epub-cfi", "fb2", true)]
    [InlineData("epub-cfi", "cbz", true)]
    [InlineData("textstack-position-v1", "pdf", true)]
    [InlineData("textstack-anchor-v1", "cbz", true)]
    [InlineData("page-name", "cbz", true)]
    [InlineData("page-name", "epub", true)]
    [InlineData("page-name", "azw3", false)]
    [InlineData("page-name", "fb2", false)]
    [InlineData("page-name", "pdf", false)]
    [InlineData("page-name", "mobi", false)]
    [InlineData("page-name", "html", false)]
    public void FitsFile_SchemeOnFormat_FitsOrIsRefused(string scheme, string format, bool fits) =>
        Assert.Equal(fits, FitsFile(scheme, format, "locator") is null);

    // ---- A vocabulary example: its provenance hangs on its book ----

    private static readonly VocabularyExampleRequest Example = new(Guid.NewGuid(), "It quivered.", null, Guid.NewGuid(), Guid.NewGuid(), "ch1.xhtml", "1984");

    [Fact]
    public void Example_FromABookOrFromNowhere_Passes()
    {
        Assert.Null(SyncValidation.Example(Example));
        Assert.Null(SyncValidation.Example(Example with { BookId = null, FileId = null, ChapterKey = null, BookTitle = null }));
    }

    public static TheoryData<string, VocabularyExampleRequest> BrokenExamples => new()
    {
        { "operationId", Example with { OperationId = Guid.Empty } },
        { "sentence", Example with { Sentence = " " } },
        { "sentence", Example with { Sentence = new string('s', MaxSentence + 1) } },
        { "contextualTranslation", Example with { ContextualTranslation = new string('t', MaxContextualTranslation + 1) } },
        { "bookTitle", Example with { BookTitle = new string('b', MaxBookTitle + 1) } },
        { "chapterKey", Example with { ChapterKey = " " } },
        { "bookId", Example with { BookId = null, ChapterKey = null } },
        { "bookId", Example with { BookId = null, FileId = null } },
    };

    [Theory]
    [MemberData(nameof(BrokenExamples))]
    public void Example_BrokenOrBooklessProvenance_IsRefusedNamingTheField(string field, VocabularyExampleRequest example) =>
        Assert.Equal(field, FieldOf(SyncValidation.Example(example)));

    // ---- The scalars every write carries: ids, client clocks, fractions, text Postgres can store ----
    // Funcs, not InlineData: xUnit carries test data as UTF-8, where a lone surrogate becomes U+FFFD.

    public static TheoryData<Func<SyncResult?>> GoodScalars => new()
    {
        () => ClientId(Guid.NewGuid(), "id"),
        // ADR-019's skew: a little ahead is a clock...
        () => NotFuture(Now.AddMinutes(5), Now, "endedAt"),
        () => NotFuture(null, Now, "endedAt"),
        () => Fraction(0m, "bookFraction"),
        () => Fraction(1m, "bookFraction"),
        () => Text("😀 fine", "title"),
        () => Text(null, "title"),
        () => Tags(["ok", "😀"]),
        () => Tags(null),
    };

    [Theory]
    [MemberData(nameof(GoodScalars))]
    public void Scalar_InBounds_Passes(Func<SyncResult?> check) => Assert.Null(check());

    public static TheoryData<string, Func<SyncResult?>> BrokenScalars => new()
    {
        { "id", () => ClientId(Guid.Empty, "id") },
        { "id", () => ClientId(null, "id") },
        // ...far ahead is a broken one.
        { "endedAt", () => NotFuture(Now.AddMinutes(5).AddSeconds(1), Now, "endedAt") },
        { "bookFraction", () => Fraction(-0.01m, "bookFraction") },
        { "bookFraction", () => Fraction(1.01m, "bookFraction") },
        { "bookFraction", () => Fraction(null, "bookFraction") },
        { "title", () => Text("a\u0000b", "title") },
        { "title", () => Text("\ud800", "title") },
        { "title", () => Text("x\udc00y", "title") },
        { "title", () => Text("\ud83d", "title") },
        { "tags", () => Tags(["ok", "b\u0000d"]) },
        { "tags", () => Tags(["ok", " "]) },
    };

    [Theory]
    [MemberData(nameof(BrokenScalars))]
    public void Scalar_OutOfBounds_IsRefusedNamingTheField(string field, Func<SyncResult?> check) =>
        Assert.Equal(field, FieldOf(check()));
}
