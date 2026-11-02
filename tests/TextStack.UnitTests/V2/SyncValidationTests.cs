using System.Text.Json;
using Application.Sync;
using Contracts.V2;
using static Application.Sync.SyncValidation;

namespace TextStack.UnitTests.V2;

/// <summary>The payload rules of v2-sync-protocol.md "Payloads": what a V2 write refuses with 400 <c>invalid_payload</c>.</summary>
public class SyncValidationTests
{
    private static readonly string Hash = new('a', 64);

    private static JsonElement Json(string json) => JsonSerializer.Deserialize<JsonElement>(json);

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
        Assert.Equal("toc", FieldOf(File("", Hash, 10, "book.epub", "epub", Json("""[{"title":"one","children":[{"title":"t\u0000"}]}]"""))));

    [Fact]
    public void File_OriginalNameWithANul_IsRefused() =>
        Assert.Equal("originalName", FieldOf(File("", Hash, 10, "book\u0000.epub", "epub", null)));

    [Fact]
    public void Tags_WithANul_AreRefused() => Assert.Equal("tags", FieldOf(Tags(["ok", "b\u0000d"])));

    [Theory]
    [InlineData(0L, "epub", "file.byteSize")]
    [InlineData(10L, "html", "file.format")]
    [InlineData(10L, "mobi", "file.format")]
    public void File_ZeroBytesOrAServerOnlyFormat_IsRefused(long byteSize, string format, string field) =>
        Assert.Equal(field, FieldOf(File("file.", Hash, byteSize, "book.epub", format, null)));

    [Fact]
    public void File_TocThatIsNotAnArray_IsRefused() =>
        Assert.Equal("toc", FieldOf(File("", Hash, 10, "book.epub", "epub", Json("""{"chapters":[]}"""))));

    [Theory]
    [InlineData("""{"version":1,"scheme":"textstack-position-v1","value":{"chapterSlug":"one"}}""")]
    [InlineData("""{"version":1,"scheme":"textstack-anchor-v1","value":{"chapterKey":"one"}}""")]
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

    [Theory]
    [InlineData(-0.01)]
    [InlineData(1.01)]
    public void Fraction_OutsideZeroToOne_IsRefused(double value) => Assert.Equal("bookFraction", FieldOf(Fraction((decimal)value, "bookFraction")));
}
