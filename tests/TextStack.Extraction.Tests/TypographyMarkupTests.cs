using TextStack.Extraction.TextProcessing.Configuration;
using TextStack.Extraction.TextProcessing.Pipeline;
using TextStack.Extraction.TextProcessing.Processors;
using TextStack.Extraction.Utilities;

namespace TextStack.Extraction.Tests;

/// <summary>Typography rewrites prose only: markup, attribute values, comments and raw text stay byte-identical.</summary>
public class TypographyMarkupTests
{
    private readonly TypographyProcessor _processor = new();
    private readonly ProcessingContext _context = new("en", new TextProcessingOptions());

    [Theory]
    [InlineData("<p class=\"copyright\">x</p>")]
    [InlineData("<div style=\"width: 65%;\">x</div>")]
    [InlineData("<a href=\"ch-1/2.html#p10-20\" title=\"Don't say &quot;X&quot;...\">x</a>")]
    [InlineData("<img src=\"img/1/2.png\" alt=\"Smith's 'hat' 1/2\" />")]
    [InlineData("<video controls title=\"a>'b'\" muted>x</video>")]
    [InlineData("<span class='it' data-x='a \"b\" c'>x</span>")]
    public void Clean_AttributedMarkup_AttributesUnchanged(string markup)
    {
        var (html, _) = HtmlCleaner.Clean($"<body>{markup}</body>");

        // The ingestion path still parses the same attributes back out.
        var expected = new HtmlAgilityPack.HtmlDocument();
        expected.LoadHtml(markup);
        var actual = new HtmlAgilityPack.HtmlDocument();
        actual.LoadHtml(html);
        var want = expected.DocumentNode.Descendants().Where(n => n.HasAttributes).Select(Attrs);
        var got = actual.DocumentNode.Descendants().Where(n => n.HasAttributes).Select(Attrs);
        Assert.Equal(want, got);
        Assert.DoesNotContain('\u201D', html.Split('>')[0]);
    }

    [Theory]
    [InlineData("<abbr title=\"Mister\">Mr.</abbr> Darcy", "title=\"Mister\"")]
    [InlineData("<img src=\"a.png\" alt=\"Mr. Smith's &quot;hat&quot; . . . 1/2\"><br class=\"x\"/>", "<br class=\"x\"/>")]
    public void Process_AttributeValuesWithProse_AttributesUnchanged(string markup, string kept)
    {
        var result = _processor.Process(markup, _context);

        Assert.StartsWith(markup.Split('>')[0] + ">", result);
        Assert.Contains(kept, result);
    }

    [Fact]
    public void Clean_AttributedParagraph_TextTypographed()
    {
        var (html, _) = HtmlCleaner.Clean("<body><p class=\"x\">\"Hello,\" she said. It's 10-20...</p></body>");

        Assert.Equal("<p class=\"x\">\u201CHello,\u201D she said. It\u2019s 10\u201320\u2060\u200A\u2060\u2026 </p>", html);
    }

    [Fact]
    public void Process_NestedInlineWithAttributes_SameAsWithout()
    {
        const string withAttrs = "<p class=\"a\">\"<em id=\"e\">'Tis</em> 1/2 o'clock,\" <b lang=\"en\">Bob</b>'s</p>";
        const string bare = "<p>\"<em>'Tis</em> 1/2 o'clock,\" <b>Bob</b>'s</p>";

        var a = _processor.Process(withAttrs, _context);
        var b = _processor.Process(bare, _context);

        Assert.Equal(b, a.Replace(" class=\"a\"", "").Replace(" id=\"e\"", "").Replace(" lang=\"en\"", ""));
    }

    [Theory]
    [InlineData("<!-- \"draft\" 1/2 ... c/o -->")]
    [InlineData("<style>p::before { content: \"...\"; width: 1/2 }</style>")]
    [InlineData("<script>var s = \"it's 10-20\";</script>")]
    [InlineData("<![CDATA[ \"x\" 1/2 ... ]]>")]
    [InlineData("<![CDATA[ a > b \"c\" ]]>")]
    [InlineData("<title lang=\"en\">Mr. X</title>")]
    [InlineData("<textarea>\"x\" 1/2</textarea>")]
    [InlineData("<SCRIPT type=\"text/javascript\">var s = \"1/2\";</SCRIPT>")]
    public void Process_RawTextSpans_Unchanged(string raw)
    {
        var result = _processor.Process($"<p>\"a\"</p>{raw}<p>\"b\"</p>", _context);

        Assert.Equal($"<p>\u201Ca\u201D</p>{raw}<p>\u201Cb\u201D</p>", result);
    }

    [Theory]
    // Quote opened before an inline element, closed after it
    [InlineData("<p class=\"a\">\"<i class=\"b\">Hello</i>,\" said he.</p>", "<p class=\"a\">\u201C<i class=\"b\">Hello</i>,\u201D said he.</p>")]
    // Rules that read across tags: nbsp after </abbr>, possessive after </i>
    [InlineData("<p><abbr class=\"name\">Mr.</abbr> Darcy</p>", "<p><abbr class=\"name\">Mr.</abbr>\u00A0Darcy</p>")]
    [InlineData("<p><i class=\"t\">Emma</i>'s book</p>", "<p><i class=\"t\">Emma</i>\u2019s book</p>")]
    // Uppercase tags, a quoted '<' in an attribute, non-Latin prose
    [InlineData("<P CLASS=\"x\">\"Hi\"</P>", "<P CLASS=\"x\">\u201CHi\u201D</P>")]
    [InlineData("<IMG SRC=\"a.png\" ALT=\"it's 1/2\"/>\"Yes\"", "<IMG SRC=\"a.png\" ALT=\"it's 1/2\"/>\u201CYes\u201D")]
    [InlineData("<p title=\"a<b 'c'\">\"q\"</p>", "<p title=\"a<b 'c'\">\u201Cq\u201D</p>")]
    [InlineData("<p data-x='it\"s'>\"k\"</p>", "<p data-x='it\"s'>\u201Ck\u201D</p>")]
    [InlineData("<p>\u201E\u041F\u0440\u0438\u0432\u0456\u0442\", '\u0414\u043E\u0431\u0440\u0435'</p>", "<p>\u201E\u041F\u0440\u0438\u0432\u0456\u0442\u201D, \u2018\u0414\u043E\u0431\u0440\u0435\u2019</p>")]
    public void Process_MarkupAroundProse_OnlyTextChanged(string input, string expected)
    {
        Assert.Equal(expected, _processor.Process(input, _context));
    }

    [Fact]
    public void Process_MarkerCharInText_ReturnsInputAndRecordsSkip()
    {
        // One U+FDD0 anywhere disables typography for the whole chapter; the counter is the only trace.
        const string input = "<p class=\"m\">Price \uFDD0 \"x\" 1/2</p>";
        string? result = null;

        var reasons = RecordSkips(() => result = _processor.Process(input, _context));

        Assert.Equal(input, result);
        Assert.Equal(["marker_in_input"], reasons);
    }

    [Fact]
    public void Process_UnclosedScriptWithAttributes_ProseTypographedScriptKept()
    {
        string? result = null;

        var reasons = RecordSkips(() => result = _processor.Process("<p class=\"a\">\"x\"</p><script type=\"x\">\"s\"", _context));

        Assert.Equal("<p class=\"a\">\u201Cx\u201D</p><script type=\"x\">\"s\"", result);
        Assert.Empty(reasons);
    }

    [Theory]
    [InlineData("<\uFDD0>x", "<p class=\"a\">x")]   // intact placeholder
    [InlineData("<\uFDD0 x", null)]                 // '>' eaten by a rule
    [InlineData("<\uFDD0", null)]                   // marker at end of string
    public void Unmask_Placeholder_RestoresOrReturnsNull(string html, string? expected)
    {
        Assert.Equal(expected, TypographyProcessor.Unmask(html, ["<p class=\"a\">"]));
    }

    [Fact]
    public void Process_RealBookChapters_EveryAttributedStartTagByteIdentical()
    {
        using var zip = System.IO.Compression.ZipFile.OpenRead(Path.Combine(AppContext.BaseDirectory, "Fixtures", "frankenstein.epub"));
        var startTag = new System.Text.RegularExpressions.Regex(@"<[A-Za-z][^>]*\s[^>]*>");
        var checkedTags = 0;
        foreach (var entry in zip.Entries.Where(e => e.Name.EndsWith("html")))
        {
            using var reader = new StreamReader(entry.Open());
            var doc = new HtmlAgilityPack.HtmlDocument();
            doc.LoadHtml(reader.ReadToEnd());
            var body = (doc.DocumentNode.SelectSingleNode("//body") ?? doc.DocumentNode).InnerHtml;

            var result = _processor.Process(body, _context);

            var want = startTag.Matches(body).Select(m => m.Value).ToList();
            Assert.Equal(want, startTag.Matches(result).Select(m => m.Value).ToList());
            Assert.DoesNotContain('\uFDD0', result);
            checkedTags += want.Count;
        }
        Assert.True(checkedTags > 100, $"corpus too small: {checkedTags} tags");
    }

    [Fact]
    public void Clean_Entities_KeepMeaning()
    {
        var (html, plain) = HtmlCleaner.Clean("<body><p title=\"&quot;a&quot; &amp; b\">Tom &amp; Jerry &lt;3 &#169;</p></body>");

        Assert.Contains("title=\"&quot;a&quot; &amp; b\"", html);
        Assert.Contains("&lt;3", html);
        Assert.Equal("Tom & Jerry <3 \u00A9", plain);   // plain text collapses the nbsp
    }

    private static List<string> RecordSkips(Action act)
    {
        var reasons = new List<string>();
        var thread = Environment.CurrentManagedThreadId;   // the counter fires synchronously; ignore parallel classes
        using var listener = new System.Diagnostics.Metrics.MeterListener();
        listener.InstrumentPublished = (i, l) =>
        {
            if (ReferenceEquals(i, TypographyProcessor.SkippedCounter))
                l.EnableMeasurementEvents(i);
        };
        listener.SetMeasurementEventCallback<long>((_, _, tags, _) =>
        {
            if (Environment.CurrentManagedThreadId != thread)
                return;
            foreach (var t in tags)
                if (t.Key == "reason")
                    reasons.Add((string)t.Value!);
        });
        listener.Start();
        act();
        return reasons;
    }

    private static string Attrs(HtmlAgilityPack.HtmlNode n)
        => string.Join(" ", n.Attributes.Select(a => $"{a.Name}={a.Value}"));
}
