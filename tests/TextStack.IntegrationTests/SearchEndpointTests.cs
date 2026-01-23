using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for search endpoints.
/// These tests catch SQL schema mismatches by actually executing queries against the database.
/// Critical: Search is a key feature - these tests must pass before deployment.
/// </summary>
public class SearchEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public SearchEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    #region Search Endpoint - Schema Validation

    [Fact]
    public async Task Search_TitleQuery_Returns200()
    {
        // This test catches SQL schema errors (e.g., missing columns)
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=test");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_AuthorQuery_Returns200()
    {
        // Tests author search path - catches edition_authors join issues
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=shevchenko");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_ShortQuery_ReturnsBadRequest()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=a");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Search_EmptyQuery_ReturnsBadRequest()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Search_WithHighlight_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=test&highlight=true");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_WithPagination_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=test&limit=10&offset=0");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    #endregion

    #region Suggest Endpoint - Schema Validation

    [Fact]
    public async Task Suggest_ValidPrefix_Returns200()
    {
        // Tests suggest SQL - catches schema mismatches in autocomplete
        var request = new HttpRequestMessage(HttpMethod.Get, "/search/suggest?q=kob");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Suggest_AuthorPrefix_Returns200()
    {
        // Tests author lookup in suggest - catches edition_authors issues
        var request = new HttpRequestMessage(HttpMethod.Get, "/search/suggest?q=shev");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Suggest_ShortPrefix_ReturnsEmptyArray()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search/suggest?q=a");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var content = await response.Content.ReadAsStringAsync();
        Assert.Equal("[]", content);
    }

    #endregion

    #region Response Format Validation

    [Fact]
    public async Task Search_ReturnsValidPaginatedResult()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/search?q=test");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<SearchResponse>();
        Assert.NotNull(result);
        Assert.True(result.Total >= 0);
        Assert.NotNull(result.Items);
    }

    #endregion

    private record SearchResponse(int Total, object[] Items);
}
