using Application.SeoCrawl;

namespace OnlineLib.UnitTests.SeoCrawl;

public class HtmlSeoParserTests
{
    [Fact]
    public void Parse_ExtractsTitle()
    {
        const string html = "<html><head><title>Test Title</title></head><body></body></html>";
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("Test Title", result.Title);
    }

    [Fact]
    public void Parse_ExtractsMetaDescription()
    {
        const string html = """
            <html><head>
            <meta name="description" content="Test description">
            </head><body></body></html>
            """;
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("Test description", result.MetaDescription);
    }

    [Fact]
    public void Parse_ExtractsMetaDescriptionCaseInsensitive()
    {
        const string html = """
            <html><head>
            <meta name="Description" content="Test description">
            </head><body></body></html>
            """;
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("Test description", result.MetaDescription);
    }

    [Fact]
    public void Parse_ExtractsH1()
    {
        const string html = "<html><body><h1>Main Heading</h1></body></html>";
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("Main Heading", result.H1);
    }

    [Fact]
    public void Parse_ExtractsFirstH1Only()
    {
        const string html = "<html><body><h1>First</h1><h1>Second</h1></body></html>";
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("First", result.H1);
    }

    [Fact]
    public void Parse_ExtractsCanonical()
    {
        const string html = """
            <html><head>
            <link rel="canonical" href="https://example.com/canonical">
            </head><body></body></html>
            """;
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("https://example.com/canonical", result.Canonical);
    }

    [Fact]
    public void Parse_ExtractsMetaRobots()
    {
        const string html = """
            <html><head>
            <meta name="robots" content="noindex, nofollow">
            </head><body></body></html>
            """;
        var result = HtmlSeoParser.Parse(html, "https://example.com");
        Assert.Equal("noindex, nofollow", result.MetaRobots);
    }

    [Fact]
    public void Parse_HandlesEmptyHtml()
    {
        var result = HtmlSeoParser.Parse("", "https://example.com");

        Assert.Null(result.Title);
        Assert.Null(result.MetaDescription);
        Assert.Null(result.H1);
        Assert.Null(result.Canonical);
        Assert.Null(result.MetaRobots);
    }

    [Fact]
    public void Parse_HandlesMalformedHtml()
    {
        const string html = "<html><head><title>Test</title><body><h1>Heading</h1>";
        var result = HtmlSeoParser.Parse(html, "https://example.com");

        Assert.Equal("Test", result.Title);
        Assert.Equal("Heading", result.H1);
    }

    [Fact]
    public void Parse_TrimsWhitespace()
    {
        const string html = """
            <html>
            <head>
                <title>  Spaced Title  </title>
                <meta name="description" content="  Spaced description  ">
            </head>
            <body>
                <h1>  Spaced Heading  </h1>
            </body>
            </html>
            """;
        var result = HtmlSeoParser.Parse(html, "https://example.com");

        Assert.Equal("Spaced Title", result.Title);
        Assert.Equal("Spaced description", result.MetaDescription);
        Assert.Equal("Spaced Heading", result.H1);
    }
}
