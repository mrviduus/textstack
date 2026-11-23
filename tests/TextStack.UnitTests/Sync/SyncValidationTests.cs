using System.Text.Json;
using Application.Sync;
using Contracts.Sync;
using static Application.Sync.SyncValidation;
using static Contracts.Sync.SyncLimits;

namespace TextStack.UnitTests.Sync;

/// <summary>
/// The payload rules of v2-sync-protocol.md "Payloads": what a V2 write accepts, and what it refuses with
/// 400 <c>invalid_payload</c> naming the field. One story per payload kind; each refusal is a row.
/// </summary>
public class SyncValidationTests
{
    private static readonly string Hash = new('a', 64);
    private static readonly DateTimeOffset Now = new(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);

    private static JsonElement Parse(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static string? FieldOf(SyncResult? result) => result is null ? null : Assert.IsType<SyncError>(result.Body).Field;

    // ---- An uploaded file version ----

    private static readonly BookFileRequest Upload = new(Guid.NewGuid(), Hash, 10, "book.epub", "epub", null, null);

    private const int MaxTocBytes = 256 * 1024;

    private const string Entry = """{"key":"toc-0","title":"One","depth":0,"fraction":0}""";

    // A TOC of exactly this many UTF-8 bytes: one entry, padded with JSON whitespace.
    private static string TocOf(int bytes) => "[" + Entry + new string(' ', bytes - 2 - Entry.Length) + "]";

    // #1128: every format the reader opens (ADR-032) is a client upload, a TOC of up to 256 KB beside it.
    [Theory]
    [InlineData("epub", false)]
    [InlineData("pdf", false)]
    [InlineData("mobi", false)]
    [InlineData("azw3", false)]
    [InlineData("fb2", false)]
    [InlineData("cbz", false)]
    [InlineData("epub", true)]
    public void File_AReaderFormatUpload_Passes(string format, bool tocAtTheCap) =>
        Assert.Null(File("file.", Upload with
        {
            Format = format,
            OriginalName = "book." + format,
            Toc = tocAtTheCap ? TocOf(MaxTocBytes) : $"[{Entry}]",
        }));

    public static TheoryData<string, BookFileRequest?> BrokenUploads => new()
    {
        { "file", null },
        // Lowercase only: the client keys its local files by the hash, so uppercase is refused, never lowered.
        { "file.sha256", Upload with { Sha256 = Hash.ToUpperInvariant() } },
        { "file.sha256", Upload with { Sha256 = Hash + "\n" } },
        { "file.sha256", Upload with { Sha256 = null } },
        { "file.byteSize", Upload with { ByteSize = 0 } },
        { "file.byteSize", Upload with { ByteSize = null } },
        { "file.originalName", Upload with { OriginalName = "book\u0000.epub" } },
        { "file.originalName", Upload with { OriginalName = " " } },
        { "file.originalName", Upload with { OriginalName = null } },
        // html is server-only (clips); the format is lowercase, as the schema's CHECK.
        { "file.format", Upload with { Format = null } },
        { "file.format", Upload with { Format = "html" } },
        { "file.format", Upload with { Format = "docx" } },
        { "file.format", Upload with { Format = "MOBI" } },
        { "file.toc", Upload with { Toc = """{"chapters":[]}""" } },
        { "file.toc", Upload with { Toc = """[{"key":"toc-0","title":"t\u0000","depth":0,"fraction":0}]""" } },
        { "file.toc", Upload with { Toc = """[{"title":"One","children":[]}]""" } },
        { "file.toc", Upload with { Toc = TocOf(MaxTocBytes + 1) } },
    };

    [Theory]
    [MemberData(nameof(BrokenUploads))]
    public void File_BrokenUpload_IsRefusedNamingTheField(string field, BookFileRequest? file) =>
        Assert.Equal(field, FieldOf(File("file.", file)));

    // ---- A file's TOC as the reader writes it (ADR-033 P3) ----

    private static string TocEntry(string key = "\"toc-1\"", string title = "\"Two\"", string depth = "1", string fraction = "0.5") =>
        $$"""{"key":{{key}},"title":{{title}},"depth":{{depth}},"fraction":{{fraction}}}""";

    // Reading order, not fraction order: a nested entry may share or precede its parent's fraction.
    [Theory]
    [InlineData(true, "[]")]
    [InlineData(true, "[" + Entry + ",{\"key\":\"section-3\",\"title\":\"Two\",\"depth\":6,\"fraction\":0,\"extra\":true}]")]
    [InlineData(false, "{}")]
    [InlineData(false, "[\"One\"]")]
    [InlineData(false, "[" + Entry + "," + Entry + "]")]
    [InlineData(false, "[{\"key\":\"a\",\"key\":\"b\",\"title\":\"T\",\"depth\":0,\"fraction\":0}]")]
    public void Toc_ReaderEntries_PassOnlyInTheirShape(bool passes, string toc) =>
        Assert.Equal(passes ? null : "toc", FieldOf(Toc(toc, "toc")));

    public static TheoryData<string> BrokenEntries => new()
    {
        TocEntry(key: "\"\""), TocEntry(key: $"\"{new string('k', MaxChapterKey + 1)}\""), TocEntry(key: "1"),
        TocEntry(title: "\"\""), TocEntry(title: $"\"{new string('t', 501)}\""), TocEntry(title: "\"\\ud800\""),
        TocEntry(depth: "-1"), TocEntry(depth: "7"), TocEntry(depth: "1.5"),
        TocEntry(fraction: "-0.1"), TocEntry(fraction: "1.01"), TocEntry(fraction: "\"0.5\""),
        """{"title":"Two","depth":1,"fraction":0.5}""",
    };

    [Theory]
    [MemberData(nameof(BrokenEntries))]
    public void Toc_BrokenEntry_IsRefused(string entry)
    {
        Assert.Null(Toc($"[{TocEntry(key: "\"k\"", title: $"\"{new string('t', 500)}\"", depth: "6", fraction: "1")}]", "toc"));
        Assert.Equal("toc", FieldOf(Toc($"[{entry}]", "toc")));
    }

    // ---- A locator: where a reading position or an annotation points ----

    private static string LocatorJson(string scheme, string value, string extra = "") =>
        $$"""{"version":1,"scheme":"{{scheme}}","value":{{value}}{{extra}}}""";

    private static string Cfi(string members) => $$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)"{{members}}}""";

    private static string PageName(string value, string extra = "") => LocatorJson("page-name", value, extra);

    // The legacy reader's position as serializeTextPosition writes it (its own "v" included), and its highlight anchor.
    private const string Anchor = """{"prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";
    private const string TextPositionValue = $$"""{"v":1,"chapterSlug":"ch-1","anchor":{{Anchor}},"charOffset":6,"chapterFraction":0.25}""";
    private const string TextAnchorValue = """{"chapterKey":"ch-1","prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";

    private static string TextPosition(string value = TextPositionValue, string extra = "") => LocatorJson("textstack-position-v1", value, extra);

    private static string TextAnchor(string value = TextAnchorValue) => LocatorJson("textstack-anchor-v1", value);

    /// <summary><paramref name="json"/> with one member set to <paramref name="value"/> (JSON), or removed when it is null.</summary>
    private static string With(string json, string member, string? value)
    {
        var members = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
        if (value is null) members.Remove(member);
        else members[member] = Parse(value);
        return JsonSerializer.Serialize(members);
    }

    private static string Quoted(char c, int count) => $"\"{new string(c, count)}\"";

    private static readonly string Emoji64 = string.Concat(Enumerable.Repeat("😀", 64));

    public static TheoryData<LocatorUse, string> WhatReadersWrite => new()
    {
        // V2 positions: a CFI with the quote at it (64 code points, though 128 UTF-16 units), a PDF page.
        { LocatorUse.Position, Cfi(""","quote":"It was" """) },
        { LocatorUse.Position, Cfi($$""","quote":"{{Emoji64}}" """) },
        { LocatorUse.Position, LocatorJson("pdf-page", """{"page":3}""") },
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
        { LocatorUse.Annotation, LocatorJson("pdf-page", """{"page":2,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"quoted"}""") },
        { LocatorUse.Annotation, TextAnchor() },
        { LocatorUse.Annotation, TextAnchor(With(With(TextAnchorValue, "prefix", Quoted('p', 32)), "suffix", Quoted('s', 32))) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", int.MaxValue.ToString())) },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", Quoted('q', MaxSelectedText))) },
    };

    [Theory]
    [MemberData(nameof(WhatReadersWrite))]
    public void Locator_WhatAReaderWrites_Passes(LocatorUse use, string locator) =>
        Assert.Null(Locator(Parse(locator), "locator", use));

    // Every refusal names "locator": the message says which rule refused it, so a row cannot pass for another.
    private const string Unstorable = "holds a NUL, an unpaired surrogate";
    private const string Envelope = "A locator is {";
    private const string UnknownScheme = "schemes only";
    private const string NeedsQuote = "A reading position needs the quote";
    private const string QuoteLength = "quote is 1-64 characters";
    private const string CfiValue = "An epub-cfi value is the CFI string";
    private const string ContextLength = "prefix is at most 32 characters";
    private const string QuoteOnCfiOnly = "Only epub-cfi carries a quote";
    private const string PdfPosition = "A pdf-page position is";
    private const string PdfAnnotation = "A pdf-page annotation is";
    private const string PageNameShape = "A page-name value is";
    private const string PageNamePositionOnly = "page-name is a reading position only";
    private const string TextPositionShape = "A textstack-position-v1 value is";
    private const string TextPositionOnly = "textstack-position-v1 is a reading position only";
    private const string TextAnchorShape = "A textstack-anchor-v1 value is";
    private const string TextAnchorOnly = "textstack-anchor-v1 is an annotation locator only";

    public static TheoryData<LocatorUse, string, string> BrokenLocators => new()
    {
        // Unstorable anywhere (NUL, lone surrogate, even in a member name): refused, never thrown.
        { LocatorUse.Position, Cfi(""","quote":"\ud800" """), Unstorable },
        { LocatorUse.Position, Cfi(""","quote":"a\u0000" """), Unstorable },
        { LocatorUse.Position, Cfi(""","quote":"ok","x\u0000":1"""), Unstorable },
        // The envelope.
        { LocatorUse.Position, """{"version":2,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"x"}""", Envelope },
        { LocatorUse.Position, """{"version":1,"scheme":"epub-cfi","value":null,"quote":"x"}""", Envelope },
        { LocatorUse.Position, """["not","an","object"]""", Envelope },
        { LocatorUse.Position, LocatorJson("Page-Name", """{"page":"p01.png","index":0}"""), UnknownScheme },
        { LocatorUse.Annotation, """{"version":1,"value":"x","quote":"q"}""", UnknownScheme },
        { LocatorUse.Annotation, """{"version":1,"scheme":"cfi","value":"x","quote":"q"}""", UnknownScheme },
        // epub-cfi: a position needs its quote (a page member does not stand in), 1-64 code points; context 32.
        { LocatorUse.Position, Cfi(""), NeedsQuote },
        { LocatorUse.Position, Cfi(""","page":"p01.png" """), NeedsQuote },
        { LocatorUse.Position, Cfi($$""","quote":"{{Emoji64}}a" """), QuoteLength },
        { LocatorUse.Position, """{"version":1,"scheme":"epub-cfi","value":" ","quote":"x"}""", CfiValue },
        { LocatorUse.Annotation, Cfi($$""","prefix":"{{new string('p', 33)}}" """), ContextLength },
        // pdf-page: a position is {page:N≥1} only, no quote; an annotation needs its rects and exact.
        { LocatorUse.Position, LocatorJson("pdf-page", """{"page":0}"""), PdfPosition },
        { LocatorUse.Position, LocatorJson("pdf-page", """{"page":3,"rects":[]}"""), PdfPosition },
        { LocatorUse.Position, LocatorJson("pdf-page", """{"page":3}""", ""","quote":"x" """), QuoteOnCfiOnly },
        { LocatorUse.Annotation, LocatorJson("pdf-page", """{"page":2,"rects":[{"x":0.1}],"exact":"quoted"}"""), PdfAnnotation },
        // page-name: {page,index} and nothing else; page 1-512 units, no control character; index an int32 ≥ 0.
        { LocatorUse.Position, PageName($$"""{"page":"{{new string('a', MaxPageName + 1)}}","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"   ","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"a\nb.png","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"a\u0001.png","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"a\u007f.png","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"a\u0085.png","index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"a\u0000.png","index":0}"""), Unstorable },
        { LocatorUse.Position, PageName("""{"page":"a\ud800.png","index":0}"""), Unstorable },
        { LocatorUse.Position, PageName("""{"page":7,"index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":null,"index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png"}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"index":0}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":-1}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":1.5}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":"0"}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":2147483648}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0,"fraction":0.5}"""), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0,"cfi":"epubcfi(/6/2)"}"""), PageNameShape },
        { LocatorUse.Position, PageName("""["p01.png",0]"""), PageNameShape },
        { LocatorUse.Position, PageName("\"p01.png\""), PageNameShape },
        { LocatorUse.Position, PageName("3"), PageNameShape },
        { LocatorUse.Position, PageName("""{"page":"p01.png","index":0}""", ""","quote":"x" """), QuoteOnCfiOnly },
        // A CBZ has no text to highlight: page-name never anchors an annotation.
        { LocatorUse.Annotation, PageName("""{"page":"p01.png","index":0}"""), PageNamePositionOnly },
        // textstack-position-v1: one rule broken at a time; a position only, never with a quote.
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", null)), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", "\" \"")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", "1")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterSlug", Quoted('k', MaxChapterKey + 1))), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", null)), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "1.01")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "-0.01")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "chapterFraction", "\"0.5\"")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "anchor", "null")), TextPositionShape },
        // A position quotes textPosition.ts's POSITION_QUOTE_LENGTH (64); a highlight quotes whatever was selected.
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "anchor", With(Anchor, "exact", Quoted('q', 65)))), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "charOffset", "-1")), TextPositionShape },
        { LocatorUse.Position, TextPosition(With(TextPositionValue, "charOffset", "1.5")), TextPositionShape },
        { LocatorUse.Position, TextPosition(extra: ""","quote":"x" """), QuoteOnCfiOnly },
        { LocatorUse.Annotation, TextPosition(), TextPositionOnly },
        // textstack-anchor-v1: one rule broken at a time; an annotation only. Offsets are int32, never clamped.
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "chapterKey", null)), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "chapterKey", "\"\"")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", null)), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", "\"\"")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "exact", Quoted('q', MaxSelectedText + 1))), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "prefix", null)), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "prefix", Quoted('p', 33))), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "suffix", Quoted('s', 33))), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "suffix", "null")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", null)), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", "-1")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "startOffset", "\"6\"")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", null)), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", "5")), TextAnchorShape },
        { LocatorUse.Annotation, TextAnchor(With(TextAnchorValue, "endOffset", "2147483648")), TextAnchorShape },
        { LocatorUse.Position, TextAnchor(), TextAnchorOnly },
    };

    [Theory]
    [MemberData(nameof(BrokenLocators))]
    public void Locator_OutsideItsSchemeShape_IsRefusedNamingTheField(LocatorUse use, string locator, string rule)
    {
        var refusal = Assert.IsType<SyncError>(Locator(Parse(locator), "locator", use)?.Body);

        Assert.Equal("locator", refusal.Field);
        Assert.Contains(rule, refusal.Message);
    }

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

    private static readonly VocabularyExampleRequest FullExample = new(Guid.NewGuid(), "It quivered.", null, Guid.NewGuid(), Guid.NewGuid(), "ch1.xhtml", "1984");

    [Fact]
    public void Example_FromABookOrFromNowhere_Passes()
    {
        Assert.Null(Example(FullExample));
        Assert.Null(Example(FullExample with { BookId = null, FileId = null, ChapterKey = null, BookTitle = null }));
    }

    public static TheoryData<string, VocabularyExampleRequest> BrokenExamples => new()
    {
        { "operationId", FullExample with { OperationId = Guid.Empty } },
        { "sentence", FullExample with { Sentence = " " } },
        { "sentence", FullExample with { Sentence = new string('s', MaxSentence + 1) } },
        { "contextualTranslation", FullExample with { ContextualTranslation = new string('t', MaxContextualTranslation + 1) } },
        { "bookTitle", FullExample with { BookTitle = new string('b', MaxBookTitle + 1) } },
        { "chapterKey", FullExample with { ChapterKey = " " } },
        { "bookId", FullExample with { BookId = null, ChapterKey = null } },
        { "bookId", FullExample with { BookId = null, FileId = null } },
    };

    [Theory]
    [MemberData(nameof(BrokenExamples))]
    public void Example_BrokenOrBooklessProvenance_IsRefusedNamingTheField(string field, VocabularyExampleRequest example) =>
        Assert.Equal(field, FieldOf(Example(example)));

    // ---- The scalars every write carries: ids, client clocks, fractions, text Postgres can store ----
    // Rows by label: xUnit carries test data as UTF-8, where a lone surrogate becomes U+FFFD, and a Func has no name.

    private static readonly Dictionary<string, Func<SyncResult?>> InBounds = new()
    {
        ["ClientId: a minted UUID"] = () => ClientId(Guid.NewGuid(), "id"),
        // ADR-019's skew: a little ahead is a clock...
        ["NotFuture: at the 5-minute skew"] = () => NotFuture(Now.AddMinutes(5), Now, "endedAt"),
        ["NotFuture: no time sent"] = () => NotFuture(null, Now, "endedAt"),
        ["Fraction: 0"] = () => Fraction(0m, "bookFraction"),
        ["Fraction: 1"] = () => Fraction(1m, "bookFraction"),
        ["Text: paired surrogates"] = () => Text("😀 fine", "title"),
        ["Text: null"] = () => Text(null, "title"),
        ["Tags: non-blank, an emoji"] = () => Tags(["ok", "😀"]),
        ["Tags: null"] = () => Tags(null),
    };

    public static TheoryData<string> GoodScalars => new(InBounds.Keys);

    [Theory]
    [MemberData(nameof(GoodScalars))]
    public void Scalar_InBounds_Passes(string row) => Assert.Null(InBounds[row]());

    private static readonly Dictionary<string, (string Field, Func<SyncResult?> Check)> OutOfBounds = new()
    {
        ["ClientId: the empty UUID"] = ("id", () => ClientId(Guid.Empty, "id")),
        ["ClientId: missing"] = ("id", () => ClientId(null, "id")),
        // ...far ahead is a broken one.
        ["NotFuture: a second past the skew"] = ("endedAt", () => NotFuture(Now.AddMinutes(5).AddSeconds(1), Now, "endedAt")),
        ["Fraction: below 0"] = ("bookFraction", () => Fraction(-0.01m, "bookFraction")),
        ["Fraction: above 1"] = ("bookFraction", () => Fraction(1.01m, "bookFraction")),
        ["Fraction: missing"] = ("bookFraction", () => Fraction(null, "bookFraction")),
        ["Text: a NUL"] = ("title", () => Text("a\u0000b", "title")),
        ["Text: a lone high surrogate"] = ("title", () => Text("\ud800", "title")),
        ["Text: a lone low surrogate"] = ("title", () => Text("x\udc00y", "title")),
        ["Text: a cut emoji"] = ("title", () => Text("\ud83d", "title")),
        ["Tags: a NUL"] = ("tags", () => Tags(["ok", "b\u0000d"])),
        ["Tags: a blank tag"] = ("tags", () => Tags(["ok", " "])),
    };

    public static TheoryData<string> BrokenScalars => new(OutOfBounds.Keys);

    [Theory]
    [MemberData(nameof(BrokenScalars))]
    public void Scalar_OutOfBounds_IsRefusedNamingTheField(string row) =>
        Assert.Equal(OutOfBounds[row].Field, FieldOf(OutOfBounds[row].Check()));
}
