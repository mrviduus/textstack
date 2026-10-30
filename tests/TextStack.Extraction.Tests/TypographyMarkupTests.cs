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
    public void Clean_AttributesUnchanged(string markup)
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
    [InlineData("<abbr title=\"Mister\">Mr.</abbr> Darcy")]
    [InlineData("<img src=\"a.png\" alt=\"Mr. Smith's &quot;hat&quot; . . . 1/2\"><br class=\"x\"/>")]
    public void Process_AttributesUnchanged(string markup)
    {
        var result = _processor.Process(markup, _context);

        Assert.StartsWith(markup.Split('>')[0] + ">", result);
        Assert.Contains(markup.Contains("<br") ? "<br class=\"x\"/>" : "title=\"Mister\"", result);
    }

    [Fact]
    public void Clean_TextStillTypographed()
    {
        var (html, _) = HtmlCleaner.Clean("<body><p class=\"x\">\"Hello,\" she said. It's 10-20...</p></body>");

        Assert.Equal("<p class=\"x\">\u201CHello,\u201D she said. It\u2019s 10\u201320\u2060\u200A\u2060\u2026 </p>", html);
    }

    [Theory]
    // Quote opened before an inline element, closed after it
    [InlineData("<p class=\"a\">\"<i class=\"b\">Hello</i>,\" said he.</p>", "<p class=\"a\">\u201C<i class=\"b\">Hello</i>,\u201D said he.</p>")]
    // Rules that read across tags: nbsp after </abbr>, possessive after </i>
    [InlineData("<p><abbr class=\"name\">Mr.</abbr> Darcy</p>", "<p><abbr class=\"name\">Mr.</abbr>\u00A0Darcy</p>")]
    [InlineData("<p><i class=\"t\">Emma</i>'s book</p>", "<p><i class=\"t\">Emma</i>\u2019s book</p>")]
    public void Process_NestedInlineElements(string input, string expected)
    {
        Assert.Equal(expected, _processor.Process(input, _context));
    }

    [Fact]
    public void Process_NestedInline_SameAsWithoutAttributes()
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
    public void Process_CommentsScriptStyleUnchanged(string raw)
    {
        var result = _processor.Process($"<p>\"a\"</p>{raw}<p>\"b\"</p>", _context);

        Assert.Equal($"<p>\u201Ca\u201D</p>{raw}<p>\u201Cb\u201D</p>", result);
    }

    [Fact]
    public void Clean_EntitiesKeepMeaning()
    {
        var (html, plain) = HtmlCleaner.Clean("<body><p title=\"&quot;a&quot; &amp; b\">Tom &amp; Jerry &lt;3 &#169;</p></body>");

        Assert.Contains("title=\"&quot;a&quot; &amp; b\"", html);
        Assert.Contains("&lt;3", html);
        Assert.Equal("Tom & Jerry <3 \u00A9", plain);   // plain text collapses the nbsp
    }

    private static string Attrs(HtmlAgilityPack.HtmlNode n)
        => string.Join(" ", n.Attributes.Select(a => $"{a.Name}={a.Value}"));
}
