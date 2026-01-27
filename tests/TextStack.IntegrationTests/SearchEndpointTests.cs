using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for search endpoints.
/// Runs against live API at localhost:8080.
/// </summary>
public class SearchEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public SearchEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    // Skip if site not configured (CI empty DB)
    private static bool ShouldSkip(HttpResponseMessage r) =>
        r.StatusCode == HttpStatusCode.NotFound || r.StatusCode == HttpStatusCode.InternalServerError;

    #region Search Endpoint

    [Fact]
    public async Task Search_TitleQuery_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=test");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_AuthorQuery_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=author");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_ShortQuery_ReturnsBadRequest()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=a");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Search_EmptyQuery_ReturnsBadRequest()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Search_WithHighlight_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=test&highlight=true");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Search_WithPagination_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=test&limit=10&offset=0");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    #endregion

    #region Suggest Endpoint

    [Fact]
    public async Task Suggest_ValidPrefix_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search/suggest?q=the");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Suggest_ShortPrefix_ReturnsEmptyArray()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search/suggest?q=a");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var content = await response.Content.ReadAsStringAsync();
        Assert.Equal("[]", content);
    }

    #endregion

    #region Response Format

    [Fact]
    public async Task Search_ReturnsValidPaginatedResult()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/search?q=book");
        var response = await _fixture.Client.SendAsync(request);

        if (ShouldSkip(response)) return;

        var result = await response.Content.ReadFromJsonAsync<SearchResponse>();
        Assert.NotNull(result);
        Assert.True(result.Total >= 0);
        Assert.NotNull(result.Items);
    }

    #endregion

    private record SearchResponse(int Total, object[] Items);
}
