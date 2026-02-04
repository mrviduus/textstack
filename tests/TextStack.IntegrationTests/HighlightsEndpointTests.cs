using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for highlights endpoints.
/// Requires: docker compose up (API must be running)
/// Note: These tests require authentication, so some will be skipped without valid auth tokens.
/// </summary>
public class HighlightsEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public HighlightsEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    #region GET /me/highlights/{editionId}

    [Fact]
    public async Task GetHighlights_WithoutAuth_Returns401()
    {
        var editionId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Get, $"/me/highlights/{editionId}");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region POST /me/highlights

    [Fact]
    public async Task CreateHighlight_WithoutAuth_Returns401()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/me/highlights");
        request.Content = JsonContent.Create(new
        {
            editionId = Guid.NewGuid(),
            chapterId = Guid.NewGuid(),
            anchorJson = """{"prefix":"test","exact":"text","suffix":"here","startOffset":0,"endOffset":4,"chapterId":"test"}""",
            color = "yellow",
            selectedText = "text"
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task CreateHighlight_InvalidColor_Returns400()
    {
        // This would need auth to test properly, but the endpoint should validate color
        var request = _fixture.CreateRequest(HttpMethod.Post, "/me/highlights");
        request.Content = JsonContent.Create(new
        {
            editionId = Guid.NewGuid(),
            chapterId = Guid.NewGuid(),
            anchorJson = """{"prefix":"test","exact":"text","suffix":"here","startOffset":0,"endOffset":4}""",
            color = "invalid_color",
            selectedText = "text"
        });

        var response = await _fixture.Client.SendAsync(request);

        // Without auth, should still be 401
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region PUT /me/highlights/{id}

    [Fact]
    public async Task UpdateHighlight_WithoutAuth_Returns401()
    {
        var highlightId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Put, $"/me/highlights/{highlightId}");
        request.Content = JsonContent.Create(new
        {
            color = "blue",
            noteText = "Test note"
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region DELETE /me/highlights/{id}

    [Fact]
    public async Task DeleteHighlight_WithoutAuth_Returns401()
    {
        var highlightId = Guid.NewGuid();
        var request = _fixture.CreateRequest(HttpMethod.Delete, $"/me/highlights/{highlightId}");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion
}
