using Api.Seo;

namespace TextStack.UnitTests.Seo;

public class CanonicalUrlBuilderTests
{
    [Fact]
    public void GetCanonicalBase_ForcesHttps()
    {
        var result = CanonicalUrlBuilder.GetCanonicalBase("http://textstack.app");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void GetCanonicalBase_StripsWww()
    {
        var result = CanonicalUrlBuilder.GetCanonicalBase("https://www.textstack.app");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void GetCanonicalBase_AddsHttpsIfMissing()
    {
        var result = CanonicalUrlBuilder.GetCanonicalBase("textstack.app");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void GetCanonicalBase_StripsTrailingSlash()
    {
        var result = CanonicalUrlBuilder.GetCanonicalBase("https://textstack.app/");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void GetCanonicalBase_CombinedNormalization()
    {
        var result = CanonicalUrlBuilder.GetCanonicalBase("http://www.textstack.app/");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void GetCanonicalBase_ThrowsOnEmpty()
    {
        Assert.Throws<ArgumentException>(() => CanonicalUrlBuilder.GetCanonicalBase(""));
        Assert.Throws<ArgumentException>(() => CanonicalUrlBuilder.GetCanonicalBase("   "));
    }

    [Fact]
    public void BuildSitemapUrl_FullPath()
    {
        var result = CanonicalUrlBuilder.BuildSitemapUrl("textstack.app", "/en/books/test-book");
        Assert.Equal("https://textstack.app/en/books/test-book", result);
    }

    [Fact]
    public void BuildSitemapUrl_AddsLeadingSlash()
    {
        var result = CanonicalUrlBuilder.BuildSitemapUrl("textstack.app", "en/books/test");
        Assert.Equal("https://textstack.app/en/books/test", result);
    }

    [Fact]
    public void BuildSitemapUrl_StripsTrailingSlash()
    {
        var result = CanonicalUrlBuilder.BuildSitemapUrl("textstack.app", "/en/books/test/");
        Assert.Equal("https://textstack.app/en/books/test", result);
    }

    [Fact]
    public void BuildSitemapUrl_EmptyPath()
    {
        var result = CanonicalUrlBuilder.BuildSitemapUrl("textstack.app", "");
        Assert.Equal("https://textstack.app", result);
    }

    [Fact]
    public void BuildSitemapUrl_NormalizeDomainToo()
    {
        var result = CanonicalUrlBuilder.BuildSitemapUrl("http://www.textstack.app/", "/en/authors/doe");
        Assert.Equal("https://textstack.app/en/authors/doe", result);
    }
}
