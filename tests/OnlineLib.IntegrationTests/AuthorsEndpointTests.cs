using System.Net;
using System.Net.Http.Json;

namespace OnlineLib.IntegrationTests;

/// <summary>
/// Integration tests for authors endpoints.
/// Tests endpoint availability and response format.
/// </summary>
public class AuthorsEndpointTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly HttpClient _client;

    public AuthorsEndpointTests(TestWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    #region GET /authors

    [Fact]
    public async Task GetAuthors_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithPagination_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors?limit=10&offset=0");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithLanguageFilter_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors?language=en");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_WithSortRecent_Returns200()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors?sort=recent");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task GetAuthors_ReturnsValidPaginatedResult()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);
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
        var request = new HttpRequestMessage(HttpMethod.Get, "/authors/non-existent-author-slug-12345");
        request.Headers.Host = "general.localhost";

        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    #endregion

    private record AuthorsResponse(int Total, object[] Items);
}
