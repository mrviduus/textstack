using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for authors endpoints.
/// Runs against live API at localhost:8080.
/// </summary>
public class AuthorsEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public AuthorsEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    #region GET /authors

    [Fact]
    public async Task GetAuthors_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithPagination_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors?limit=10&offset=0");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithLanguageFilter_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors?language=en");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithSortRecent_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors?sort=recent");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_ReturnsValidPaginatedResult()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors");
        var response = await _fixture.Client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var result = await response.Content.ReadFromJsonAsync<AuthorsResponse>();
        Assert.NotNull(result);
        Assert.True(result.Total >= 0);
        Assert.NotNull(result.Items);
    }

    #endregion

    #region GET /authors/{slug}

    [Fact]
    public async Task GetAuthor_NonExistent_Returns404()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/authors/non-existent-author-slug-12345");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    #endregion

    private record AuthorsResponse(int Total, object[] Items);
}
