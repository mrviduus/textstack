using System.Text.Json;
using Application.Sync;
using Contracts.V2;
using static Application.Sync.SyncValidation;
using static Contracts.V2.SyncLimits;

namespace TextStack.UnitTests.V2;

/// <summary>The payload rules of v2-sync-protocol.md "Payloads": what a V2 write refuses with 400 <c>invalid_payload</c>.</summary>
public class SyncValidationTests
{
    private static readonly string Hash = new('a', 64);

    private static JsonElement Json(string json) => JsonSerializer.Deserialize<JsonElement>(json);

    private static BookFileRequest Book(long byteSize = 10, string format = "epub", string name = "book.epub", string? toc = null) =>
        new(Guid.NewGuid(), Hash, byteSize, name, format, null, toc);

    [Fact]
    public void File_Missing_IsRefusedNamingIt() => Assert.Equal("file", FieldOf(File("file.", null)));

    private static string? FieldOf(SyncResult? result) => result is null ? null : Assert.IsType<V2Error>(result.Body).Field;

    [Fact]
    public void Sha256_UppercaseHex_IsRefusedNotLowered() => Assert.Equal("sha256", FieldOf(Sha256(Hash.ToUpperInvariant())));

    [Fact]
    public void Sha256_LowercaseHex_Passes() => Assert.Null(Sha256(Hash));

    [Fact]
    public void Sha256_TrailingNewline_IsRefused() => Assert.Equal("sha256", FieldOf(Sha256(Hash + "\n")));

    // A Fact, not InlineData: xUnit carries test data as UTF-8, where a lone surrogate becomes U+FFFD.
    [Fact]
    public void Text_NulOrUnpairedSurrogate_IsRefused() =>
        Assert.All(["a\u0000b", "\ud800", "x\udc00y", "\ud83d"], text => Assert.Equal("title", FieldOf(Text(text, "title"))));

    [Fact]
    public void Text_PairedSurrogates_Pass() => Assert.Null(Text("😀 fine", "title"));

    [Theory]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"\ud800"}""")]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"a\u0000"}""")]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"ok","x\u0000":1}""")]
    public void Locator_NulOrLoneSurrogateAnywhere_IsRefusedNotThrown(string locator) =>
        Assert.Equal("currentLocator", FieldOf(Locator(Json(locator), "currentLocator", LocatorUse.Position)));

    [Fact]
    public void File_TocWithANulDeepInside_IsRefused() =>
        Assert.Equal("file.toc", FieldOf(File("file.", Book(toc: """[{"title":"one","children":[{"title":"t\u0000"}]}]"""))));

    [Fact]
    public void File_OriginalNameWithANul_IsRefused() =>
        Assert.Equal("originalName", FieldOf(File("", Book(name: "book\u0000.epub"))));

    [Fact]
    public void Tags_WithANul_AreRefused() => Assert.Equal("tags", FieldOf(Tags(["ok", "b\u0000d"])));

    [Theory]
    [InlineData(0L, "epub", "file.byteSize")]
    [InlineData(10L, "html", "file.format")]
    [InlineData(10L, "mobi", "file.format")]
    public void File_ZeroBytesOrAServerOnlyFormat_IsRefused(long byteSize, string format, string field) =>
        Assert.Equal(field, FieldOf(File("file.", Book(byteSize: byteSize, format: format))));

    [Fact]
    public void File_TocThatIsNotAnArray_IsRefused() =>
        Assert.Equal("toc", FieldOf(File("", Book(toc: """{"chapters":[]}"""))));

    [Theory]
    [InlineData("""{"version":2,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"x"}""")]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":null,"quote":"x"}""")]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)"}""")]
    [InlineData("""{"version":1,"scheme":"pdf-page","value":{"page":0}}""")]
    [InlineData("""{"version":1,"scheme":"pdf-page","value":{"page":3,"rects":[]}}""")]
    [InlineData("""{"version":1,"scheme":"pdf-page","value":{"page":3},"quote":"x"}""")]
    public void Locator_PositionOutsideTheTwoV2Shapes_IsRefused(string locator) =>
        Assert.Equal("currentLocator", FieldOf(Locator(Json(locator), "currentLocator", LocatorUse.Position)));

    [Theory]
    [InlineData("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"It was"}""")]
    [InlineData("""{"version":1,"scheme":"pdf-page","value":{"page":3}}""")]
    public void Locator_V2Position_Passes(string locator) => Assert.Null(Locator(Json(locator), "currentLocator", LocatorUse.Position));

    [Fact]
    public void Locator_QuoteOf64EmojiCodePoints_PassesThoughItIs128Utf16Units()
    {
        var quote = string.Concat(Enumerable.Repeat("😀", 64));

        Assert.Null(Locator(Json($$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"{{quote}}"}"""), "l", LocatorUse.Position));
        Assert.Equal("l", FieldOf(Locator(Json($$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","quote":"{{quote}}a"}"""), "l", LocatorUse.Position)));
    }

    [Fact]
    public void Locator_AnnotationWithoutQuoteAndWithContext_Passes() =>
        Assert.Null(Locator(Json("""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","prefix":"before ","suffix":" after"}"""), "locator", LocatorUse.Annotation));

    [Fact]
    public void Locator_ContextOver32CodePoints_IsRefused() =>
        Assert.Equal("locator", FieldOf(Locator(Json($$"""{"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/4)","prefix":"{{new string('p', 33)}}"}"""), "locator", LocatorUse.Annotation)));

    [Fact]
    public void Locator_LegacyPdfAnchorOnAnAnnotation_Passes() =>
        Assert.Null(Locator(Json("""{"version":1,"scheme":"pdf-page","value":{"page":2,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}],"exact":"quoted"}}"""), "locator", LocatorUse.Annotation));

    // The legacy reader's position as serializeTextPosition writes it (its own "v" included), and its highlight anchor.
    private const string Anchor = """{"prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";
    private const string TextPosition = $$"""{"v":1,"chapterSlug":"ch-1","anchor":{{Anchor}},"charOffset":6,"chapterFraction":0.25}""";
    private const string TextAnchor = """{"chapterKey":"ch-1","prefix":"was a ","exact":"bright cold day","suffix":" in April","startOffset":6,"endOffset":21}""";

    private static SyncResult? Transitional(string scheme, string value, LocatorUse use, string extra = "") =>
        Locator(Json($$"""{"version":1,"scheme":"{{scheme}}","value":{{value}}{{extra}}}"""), "locator", use);

    private static SyncResult? TextPositionWith(string value) => Transitional("textstack-position-v1", value, LocatorUse.Position);

    private static SyncResult? TextAnchorWith(string value) => Transitional("textstack-anchor-v1", value, LocatorUse.Annotation);

    /// <summary><paramref name="json"/> with one member set to <paramref name="value"/> (JSON), or removed when it is null.</summary>
    private static string With(string json, string member, string? value)
    {
        var members = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;
        if (value is null) members.Remove(member);
        else members[member] = Json(value);
        return JsonSerializer.Serialize(members);
    }

    [Fact]
    public void Locator_LegacyTextPositionAsSerialized_Passes() => Assert.Null(TextPositionWith(TextPosition));

    [Fact]
    public void Locator_ScrollOnlyTextPosition_PassesWithoutAnAnchor() =>
        Assert.Null(TextPositionWith("""{"chapterSlug":"ch-1","chapterFraction":0}"""));

    [Theory]
    [InlineData("chapterSlug", null)]
    [InlineData("chapterSlug", "\" \"")]
    [InlineData("chapterSlug", "1")]
    [InlineData("chapterFraction", null)]
    [InlineData("chapterFraction", "1.01")]
    [InlineData("chapterFraction", "-0.01")]
    [InlineData("chapterFraction", "\"0.5\"")]
    [InlineData("anchor", "null")]
    [InlineData("anchor", """{"prefix":"","exact":"","suffix":"","startOffset":0,"endOffset":0}""")]
    [InlineData("charOffset", "-1")]
    [InlineData("charOffset", "1.5")]
    public void Locator_TextPositionBreakingOneRule_IsRefused(string member, string? value) =>
        Assert.Equal("locator", FieldOf(TextPositionWith(With(TextPosition, member, value))));

    [Fact]
    public void Locator_TextPositionChapterSlugOverTheChapterKeyCap_IsRefused()
    {
        Assert.Null(TextPositionWith(With(TextPosition, "chapterSlug", $"\"{new string('k', MaxChapterKey)}\"")));
        Assert.Equal("locator", FieldOf(TextPositionWith(With(TextPosition, "chapterSlug", $"\"{new string('k', MaxChapterKey + 1)}\""))));
    }

    // A position quotes textPosition.ts's POSITION_QUOTE_LENGTH (64); a highlight quotes whatever was selected.
    [Fact]
    public void Locator_TextPositionQuoteOver64_IsRefusedAndAHighlightsIsNot()
    {
        var quote = (int length) => With(Anchor, "exact", $"\"{new string('q', length)}\"");

        Assert.Null(TextPositionWith(With(TextPosition, "anchor", quote(64))));
        Assert.Equal("locator", FieldOf(TextPositionWith(With(TextPosition, "anchor", quote(65)))));
        Assert.Null(TextAnchorWith(With(TextAnchor, "exact", $"\"{new string('q', 65)}\"")));
    }

    [Fact]
    public void Locator_LegacyTextAnchor_Passes() => Assert.Null(TextAnchorWith(TextAnchor));

    [Theory]
    [InlineData("chapterKey", null)]
    [InlineData("chapterKey", "\"\"")]
    [InlineData("exact", null)]
    [InlineData("exact", "\"\"")]
    [InlineData("prefix", null)]
    [InlineData("suffix", "null")]
    [InlineData("startOffset", null)]
    [InlineData("startOffset", "-1")]
    [InlineData("startOffset", "\"6\"")]
    [InlineData("endOffset", null)]
    [InlineData("endOffset", "5")] // before startOffset
    public void Locator_TextAnchorBreakingOneRule_IsRefused(string member, string? value) =>
        Assert.Equal("locator", FieldOf(TextAnchorWith(With(TextAnchor, member, value))));

    [Fact]
    public void Locator_TextAnchorContextOver32CodePoints_IsRefused()
    {
        Assert.Null(TextAnchorWith(With(TextAnchor, "suffix", $"\"{new string('s', 32)}\"")));
        Assert.Equal("locator", FieldOf(TextAnchorWith(With(TextAnchor, "prefix", $"\"{new string('p', 33)}\""))));
    }

    [Fact]
    public void Locator_TextAnchorSuffixOver32CodePoints_IsRefused() =>
        Assert.Equal("locator", FieldOf(TextAnchorWith(With(TextAnchor, "suffix", $"\"{new string('s', 33)}\""))));

    // An int32 offset: 2^31 does not fit and is refused, never clamped.
    [Fact]
    public void Locator_TextAnchorOffsetOf2To31_IsRefused()
    {
        Assert.Null(TextAnchorWith(With(TextAnchor, "endOffset", int.MaxValue.ToString())));
        Assert.Equal("locator", FieldOf(TextAnchorWith(With(TextAnchor, "endOffset", "2147483648"))));
    }

    [Fact]
    public void Locator_TextAnchorExactOverTheSelectedTextCap_IsRefused()
    {
        Assert.Null(TextAnchorWith(With(TextAnchor, "exact", $"\"{new string('q', MaxSelectedText)}\"")));
        Assert.Equal("locator", FieldOf(TextAnchorWith(With(TextAnchor, "exact", $"\"{new string('q', MaxSelectedText + 1)}\""))));
    }

    [Fact]
    public void Locator_TextPositionAsAnAnnotation_IsRefused() =>
        Assert.Equal("locator", FieldOf(Transitional("textstack-position-v1", TextPosition, LocatorUse.Annotation)));

    [Fact]
    public void Locator_TextAnchorAsAPosition_IsRefused() =>
        Assert.Equal("locator", FieldOf(Transitional("textstack-anchor-v1", TextAnchor, LocatorUse.Position)));

    [Fact]
    public void Locator_TextstackSchemeWithAQuote_IsRefused() =>
        Assert.Equal("locator", FieldOf(Transitional("textstack-position-v1", TextPosition, LocatorUse.Position, ""","quote":"x" """)));

    [Theory]
    [InlineData("""{"version":1,"value":"x","quote":"q"}""")]
    [InlineData("""{"version":1,"scheme":"cfi","value":"x","quote":"q"}""")]
    public void Locator_UnknownOrMissingSchemeWithAQuote_IsRefusedForItsScheme(string locator) =>
        Assert.Contains("schemes only", Assert.IsType<V2Error>(Locator(Json(locator), "locator", LocatorUse.Annotation)!.Body).Message);

    [Theory]
    [InlineData(-0.01)]
    [InlineData(1.01)]
    public void Fraction_OutsideZeroToOne_IsRefused(double value) => Assert.Equal("bookFraction", FieldOf(Fraction((decimal)value, "bookFraction")));

    private static VocabularyExampleRequest Sentence(Guid? bookId = null, Guid? fileId = null, string? chapterKey = null, string sentence = "It quivered.") =>
        new(Guid.NewGuid(), sentence, null, bookId, fileId, chapterKey, null);

    [Fact]
    public void Example_FileOrChapterKeyWithoutABook_IsRefused()
    {
        Assert.Equal("bookId", FieldOf(Example(Sentence(fileId: Guid.NewGuid()))));
        Assert.Equal("bookId", FieldOf(Example(Sentence(chapterKey: "ch1.xhtml"))));
        Assert.Null(Example(Sentence(Guid.NewGuid(), Guid.NewGuid(), "ch1.xhtml")));
    }

    [Fact]
    public void Example_SentenceOverItsCap_IsRefused() =>
        Assert.Equal("sentence", FieldOf(Example(Sentence(sentence: new string('s', MaxSentence + 1)))));

    [Fact]
    public void ClientId_EmptyUuid_IsRefused() => Assert.Equal("id", FieldOf(ClientId(Guid.Empty, "id")));

    // ADR-019's skew: a little ahead is a clock, far ahead is a broken one.
    [Fact]
    public void NotFuture_PastTheSkew_IsRefusedAndAtItPasses()
    {
        var now = new DateTimeOffset(2026, 11, 1, 12, 0, 0, TimeSpan.Zero);
        Assert.Equal("endedAt", FieldOf(NotFuture(now.AddMinutes(5).AddSeconds(1), now, "endedAt")));
        Assert.Null(NotFuture(now.AddMinutes(5), now, "endedAt"));
    }
}
