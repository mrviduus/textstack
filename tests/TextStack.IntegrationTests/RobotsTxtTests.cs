namespace TextStack.IntegrationTests;

/// <summary>
/// <c>GET /robots.txt</c> — Bing flagged "limited crawl capacity": <c>?direct=1</c> chapter links
/// are duplicates of the chapter page and must not be crawled.
/// </summary>
public class RobotsTxtTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public RobotsTxtTests(LiveApiFixture fixture) => _fixture = fixture;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task GetRobots_ParamDuplicates_AreDisallowed()
    {
        var resp = await _fixture.Client.SendAsync(_fixture.CreateRequest(HttpMethod.Get, "/robots.txt"), Ct);
        var body = await resp.Content.ReadAsStringAsync(Ct);

        Assert.True(resp.IsSuccessStatusCode);
        // A site with indexing off serves only "Disallow: /" (the CI stack) — nothing more to assert.
        Assert.SkipWhen(body.ReplaceLineEndings("\n").Trim() == "User-agent: *\nDisallow: /", "site has indexing disabled");
        Assert.Contains("Disallow: /*?direct=", body);
        Assert.Contains("Disallow: /*?highlight=", body);
        Assert.Contains("Disallow: /*&direct=", body);
        Assert.Contains("Disallow: /*&highlight=", body);
    }
}
