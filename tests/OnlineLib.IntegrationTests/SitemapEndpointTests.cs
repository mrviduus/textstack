using System.Net;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace OnlineLib.IntegrationTests;

/// <summary>
/// Integration tests for sitemap + publishing + indexability invariants.
/// Prevents regressions where:
/// - Sitemaps contain chapters/reader/draft pages
/// - Sitemaps contain external domains or malformed output
/// - Published pages are missing from sitemaps
/// - Draft pages leak into sitemaps or are indexable
/// - Chapter pages become indexable
/// </summary>
public class SitemapEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;
    private const string TestHost = "general.localhost";
    private static readonly XNamespace SitemapNs = "http://www.sitemaps.org/schemas/sitemap/0.9";

    public SitemapEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    #region TEST 1 — Sitemap index is valid XML and does not reference chapters

    [Fact]
    public async Task SitemapIndex_Returns200WithXmlContentType()
    {
        var response = await GetWithHost("/sitemap.xml");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("xml", response.Content.Headers.ContentType?.MediaType ?? "");
    }

    [Fact]
    public async Task SitemapIndex_StartsWithXmlDeclaration()
    {
        var response = await GetWithHost("/sitemap.xml");
        var content = await response.Content.ReadAsStringAsync();

        Assert.StartsWith("<?xml", content.TrimStart());
    }

    [Fact]
    public async Task SitemapIndex_HasCorrectNamespace()
    {
        var response = await GetWithHost("/sitemap.xml");
        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        Assert.NotNull(doc.Root);
        Assert.Equal("sitemapindex", doc.Root.Name.LocalName);
        Assert.Equal(SitemapNs.NamespaceName, doc.Root.Name.NamespaceName);
    }

    [Fact]
    public async Task SitemapIndex_DoesNotContainChapters()
    {
        var response = await GetWithHost("/sitemap.xml");
        var content = await response.Content.ReadAsStringAsync();

        // Must NOT contain any chapter references
        Assert.DoesNotContain("chapters", content, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("/sitemaps/chapters", content, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("chapters-", content, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task SitemapIndex_ContainsRequiredSitemaps()
    {
        var response = await GetWithHost("/sitemap.xml");
        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        Assert.Contains(locs, loc => loc.EndsWith("/sitemaps/books.xml"));
        Assert.Contains(locs, loc => loc.EndsWith("/sitemaps/authors.xml"));
        Assert.Contains(locs, loc => loc.EndsWith("/sitemaps/genres.xml"));
    }

    #endregion

    #region TEST 2 — books.xml is valid XML urlset

    [Fact]
    public async Task BooksSitemap_Returns200WithXmlContentType()
    {
        var response = await GetWithHost("/sitemaps/books.xml");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("xml", response.Content.Headers.ContentType?.MediaType ?? "");
    }

    [Fact]
    public async Task BooksSitemap_HasCorrectUrlsetNamespace()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        Assert.NotNull(doc.Root);
        Assert.Equal("urlset", doc.Root.Name.LocalName);
        Assert.Equal(SitemapNs.NamespaceName, doc.Root.Name.NamespaceName);
    }

    [Fact]
    public async Task BooksSitemap_AllLocsAreParseableAbsoluteUrls()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            Assert.True(Uri.TryCreate(loc, UriKind.Absolute, out var uri),
                $"<loc> value is not a valid absolute URL: {loc}");
            Assert.True(uri.Scheme == "http" || uri.Scheme == "https",
                $"URL scheme must be http or https: {loc}");
        }
    }

    [Fact]
    public async Task BooksSitemap_LastmodFormatIsValid()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
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
    public async Task BooksSitemap_NoPlainTextTokensOutsideXmlTags()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        var content = await response.Content.ReadAsStringAsync();

        // These should only appear inside XML tags, not as loose text
        // Check that content is well-formed XML (would throw if malformed)
        var doc = XDocument.Parse(content);
        Assert.NotNull(doc.Root);

        // Verify structure: each <url> should have <loc> as required element
        var urls = doc.Descendants(SitemapNs + "url").ToList();
        foreach (var url in urls)
        {
            Assert.NotNull(url.Element(SitemapNs + "loc"));
        }
    }

    #endregion

    #region TEST 3 — Sitemap URLs restricted to allowed host + path patterns (NO external domains)

    [Theory]
    [InlineData("/sitemaps/books.xml")]
    [InlineData("/sitemaps/authors.xml")]
    [InlineData("/sitemaps/genres.xml")]
    public async Task Sitemap_AllUrlsHaveCorrectSchemeAndHost(string sitemapPath)
    {
        var response = await GetWithHost(sitemapPath);
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.Equal("https", uri.Scheme); // Canonical URLs always use https
            Assert.Equal(TestHost, uri.Host);
            Assert.True(string.IsNullOrEmpty(uri.Query), $"URL should not have query string: {loc}");
            Assert.True(string.IsNullOrEmpty(uri.Fragment), $"URL should not have fragment: {loc}");
        }
    }

    [Fact]
    public async Task BooksSitemap_UrlsMatchAllowedPatterns()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            var path = uri.AbsolutePath;

            // books.xml must contain ONLY book detail pages: /{lang}/books/{slug}
            // NO homepage (/en), NO list page (/en/books), NO chapters
            Assert.Matches(@"^/[a-z]{2}/books/[^/]+$", path);
        }
    }

    [Fact]
    public async Task BooksSitemap_DoesNotContainHomepageOrListPage()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        // Must NOT contain homepage or books list page
        Assert.DoesNotContain("/en</loc>", content);
        Assert.DoesNotContain("/en/books</loc>", content);
    }

    [Fact]
    public async Task AuthorsSitemap_UrlsMatchAllowedPatterns()
    {
        var response = await GetWithHost("/sitemaps/authors.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.StartsWith("/en/authors/", uri.AbsolutePath);
        }
    }

    [Fact]
    public async Task GenresSitemap_UrlsMatchAllowedPatterns()
    {
        var response = await GetWithHost("/sitemaps/genres.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            Assert.StartsWith("/en/genres/", uri.AbsolutePath);
        }
    }

    [Fact]
    public async Task BooksSitemap_NoChapterUrlsPresent()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var locs = doc.Descendants(SitemapNs + "loc").Select(e => e.Value).ToList();

        foreach (var loc in locs)
        {
            var uri = new Uri(loc);
            var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);

            // Chapter URLs have 4 segments: /en/books/{slug}/{chapter}
            if (segments.Length >= 2 && segments[1] == "books")
            {
                Assert.True(segments.Length <= 3,
                    $"URL appears to be a chapter (4+ segments): {loc}");
            }
        }

        // Also explicitly check that test chapter is not present
        Assert.DoesNotContain(TestWebApplicationFactory.TestChapterSlug, content);
    }

    #endregion

    #region TEST 4 — Published-only invariant (seeded dataset)

    [Fact]
    public async Task BooksSitemap_ContainsPublishedBook()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        Assert.Contains(TestWebApplicationFactory.PublishedBookSlug, content);
    }

    [Fact]
    public async Task BooksSitemap_DoesNotContainDraftBook()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        Assert.DoesNotContain(TestWebApplicationFactory.DraftBookSlug, content);
    }

    [Fact]
    public async Task AuthorsSitemap_ContainsIndexableAuthor()
    {
        var response = await GetWithHost("/sitemaps/authors.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        // test-author has Indexable=true
        Assert.Contains("test-author", content);
    }

    [Fact]
    public async Task AuthorsSitemap_DoesNotContainNonIndexableAuthor()
    {
        var response = await GetWithHost("/sitemaps/authors.xml");
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        Assert.DoesNotContain(TestWebApplicationFactory.NonIndexableAuthorSlug, content);
    }

    #endregion

    #region TEST 5 — Chapters sitemap must not exist

    [Fact]
    public async Task ChaptersSitemap_Returns404()
    {
        var response = await GetWithHost("/sitemaps/chapters-1.xml");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task ChaptersSitemap_MultiplePages_Return404()
    {
        for (int i = 1; i <= 3; i++)
        {
            var response = await GetWithHost($"/sitemaps/chapters-{i}.xml");
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        }
    }

    #endregion

    #region TEST 6 — Chapter pages are never indexable

    [Fact]
    public async Task ChapterPage_IsNotInAnySitemap()
    {
        // Check books.xml doesn't contain chapter URL
        var booksSitemap = await GetWithHost("/sitemaps/books.xml");
        var booksContent = await booksSitemap.Content.ReadAsStringAsync();

        var chapterUrl = $"/en/books/{TestWebApplicationFactory.PublishedBookSlug}/{TestWebApplicationFactory.TestChapterSlug}";
        Assert.DoesNotContain(chapterUrl, booksContent);
        Assert.DoesNotContain(TestWebApplicationFactory.TestChapterSlug, booksContent);
    }

    #endregion

    #region TEST 7 — Draft pages are not indexable

    [Fact]
    public async Task DraftBookPage_IsNotInSitemap()
    {
        var response = await GetWithHost("/sitemaps/books.xml");
        var content = await response.Content.ReadAsStringAsync();

        var draftUrl = $"/en/books/{TestWebApplicationFactory.DraftBookSlug}";
        Assert.DoesNotContain(draftUrl, content);
    }

    [Fact]
    public async Task NonIndexableAuthorPage_IsNotInSitemap()
    {
        var response = await GetWithHost("/sitemaps/authors.xml");
        var content = await response.Content.ReadAsStringAsync();

        var authorUrl = $"/en/authors/{TestWebApplicationFactory.NonIndexableAuthorSlug}";
        Assert.DoesNotContain(authorUrl, content);
    }

    #endregion

    #region Additional Invariant Tests

    [Fact]
    public async Task RobotsTxt_ContainsSitemapReference()
    {
        var response = await GetWithHost("/robots.txt");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/plain", response.Content.Headers.ContentType?.MediaType);

        var content = await response.Content.ReadAsStringAsync();
        Assert.Contains("Sitemap:", content);
        Assert.Contains("/sitemap.xml", content);
    }

    [Fact]
    public async Task RobotsTxt_DisallowsAdminAndApi()
    {
        var response = await GetWithHost("/robots.txt");
        var content = await response.Content.ReadAsStringAsync();

        Assert.Contains("Disallow: /admin", content);
        Assert.Contains("Disallow: /api/", content);
    }

    [Theory]
    [InlineData("/sitemap.xml")]
    [InlineData("/sitemaps/books.xml")]
    [InlineData("/sitemaps/authors.xml")]
    [InlineData("/sitemaps/genres.xml")]
    public async Task Sitemaps_AreValidXml(string path)
    {
        var response = await GetWithHost(path);
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();

        // Should not throw
        var doc = XDocument.Parse(content);
        Assert.NotNull(doc.Root);
    }

    [Theory]
    [InlineData("/sitemaps/books.xml")]
    [InlineData("/sitemaps/authors.xml")]
    [InlineData("/sitemaps/genres.xml")]
    public async Task Sitemaps_NoExternalDomains(string path)
    {
        var response = await GetWithHost(path);
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync();
        var doc = XDocument.Parse(content);

        var allUrls = new List<string>();

        // Collect <loc> values
        allUrls.AddRange(doc.Descendants(SitemapNs + "loc").Select(e => e.Value));

        foreach (var url in allUrls)
        {
            var uri = new Uri(url);
            Assert.Equal(TestHost, uri.Host);
        }
    }

    #endregion

    #region Helper Methods

    private async Task<HttpResponseMessage> GetWithHost(string path)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Host = TestHost;
        return await _client.SendAsync(request);
    }

    #endregion
}
