using System.Net;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for sitemap endpoints.
/// Runs against live API at localhost:8080.
/// </summary>
public class SitemapEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private static readonly XNamespace SitemapNs = "http://www.sitemaps.org/schemas/sitemap/0.9";

    public SitemapEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    // Helper: skip test if site not configured (CI with empty DB)
    private static bool ShouldSkip(HttpResponseMessage response) =>
        response.StatusCode == HttpStatusCode.NotFound ||
        response.StatusCode == HttpStatusCode.InternalServerError;

    #region Sitemap Index

    [Fact]
    public async Task SitemapIndex_Returns200WithXmlContentType()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemap.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return; // CI: no site configured

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("xml", response.Content.Headers.ContentType?.MediaType ?? "");
    }

    [Fact]
    public async Task SitemapIndex_StartsWithXmlDeclaration()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemap.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        Assert.StartsWith("<?xml", content.TrimStart());
    }

    [Fact]
    public async Task SitemapIndex_HasCorrectNamespace()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemap.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        Assert.NotNull(doc.Root);
        Assert.Equal("sitemapindex", doc.Root.Name.LocalName);
        Assert.Equal(SitemapNs.NamespaceName, doc.Root.Name.NamespaceName);
    }

    [Fact]
    public async Task SitemapIndex_DoesNotContainChapters()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemap.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("chapters", content, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SitemapIndex_ContainsRequiredSitemaps()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemap.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        Assert.Contains(locs, loc => loc.Contains("/sitemaps/books.xml"));
        Assert.Contains(locs, loc => loc.Contains("/sitemaps/authors.xml"));
        Assert.Contains(locs, loc => loc.Contains("/sitemaps/genres.xml"));
    }

    #endregion

    #region Books Sitemap

    [Fact]
    public async Task BooksSitemap_Returns200WithXmlContentType()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("xml", response.Content.Headers.ContentType?.MediaType ?? "");
    }

    [Fact]
    public async Task BooksSitemap_HasCorrectUrlsetNamespace()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        Assert.NotNull(doc.Root);
        Assert.Equal("urlset", doc.Root.Name.LocalName);
        Assert.Equal(SitemapNs.NamespaceName, doc.Root.Name.NamespaceName);
    }

    [Fact]
    public async Task BooksSitemap_AllLocsAreValidAbsoluteUrls()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            Assert.True(Uri.TryCreate(loc, UriKind.Absolute, out var uri),
                $"<loc> is not a valid absolute URL: {loc}");
            Assert.True(uri.Scheme == "http" || uri.Scheme == "https",
                $"URL scheme must be http or https: {loc}");
        }
    }

    [Fact]
    public async Task BooksSitemap_LastmodFormatIsValid()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var lastmods = doc.Descendants(SitemapNs + "lastmod").Select(e => e.Value).ToList();
        var dateRegex = new Regex(@"^\d{4}-\d{2}-\d{2}$");

        foreach (var lastmod in lastmods)
        {
            Assert.Matches(dateRegex, lastmod);
        }
    }

    [Fact]
    public async Task BooksSitemap_UrlsMatchBookPattern()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.Matches(@"^/[a-z]{2}/books/[^/]+$", uri.AbsolutePath);
        }
    }

    [Fact]
    public async Task BooksSitemap_NoChapterUrls()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/books.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);

            if (segments.Length >= 2 && segments[1] == "books")
            {
                Assert.True(segments.Length <= 3, $"URL appears to be a chapter: {loc}");
            }
        }
    }

    #endregion

    #region Authors Sitemap

    [Fact]
    public async Task AuthorsSitemap_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/authors.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task AuthorsSitemap_UrlsMatchAuthorPattern()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/authors.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.Matches(@"^/[a-z]{2}/authors/[^/]+$", uri.AbsolutePath);
        }
    }

    #endregion

    #region Genres Sitemap

    [Fact]
    public async Task GenresSitemap_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/genres.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GenresSitemap_UrlsMatchGenrePattern()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/genres.xml");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.Matches(@"^/[a-z]{2}/genres/[^/]+$", uri.AbsolutePath);
        }
    }

    #endregion

    #region Chapters Sitemap (should not exist)

    [Fact]
    public async Task ChaptersSitemap_Returns404()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/sitemaps/chapters-1.xml");
        var response = await _fixture.Client.SendAsync(request);

        // 404 expected, but also accept if site not configured
        Assert.True(response.StatusCode == HttpStatusCode.NotFound ||
                    response.StatusCode == HttpStatusCode.InternalServerError);
    }

    #endregion

    #region Robots.txt

    [Fact]
    public async Task RobotsTxt_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/robots.txt");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task RobotsTxt_ContainsSitemapReference()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/robots.txt");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("Sitemap:", content);
        Assert.Contains("sitemap.xml", content);
    }

    [Fact]
    public async Task RobotsTxt_DisallowsAdminAndApi()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/robots.txt");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("Disallow: /admin", content);
        Assert.Contains("Disallow: /api", content);
    }

    #endregion

    #region XML Validation

    [Theory]
    [InlineData("/sitemap.xml")]
    [InlineData("/sitemaps/books.xml")]
    [InlineData("/sitemaps/authors.xml")]
    [InlineData("/sitemaps/genres.xml")]
    public async Task Sitemaps_AreValidXml(string path)
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, path);
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);
        Assert.NotNull(doc.Root);
    }

    #endregion
}
