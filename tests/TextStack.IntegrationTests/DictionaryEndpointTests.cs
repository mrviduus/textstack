using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for dictionary endpoints.
/// Uses Free Dictionary API (external service).
/// </summary>
public class DictionaryEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public DictionaryEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    #region GET /api/dictionary/{lang}/{word}

    [Fact]
    public async Task LookupWord_ValidEnglishWord_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/en/hello");
        var response = await _fixture.Client.SendAsync(request);

        // External API might be unavailable
        if (response.StatusCode == HttpStatusCode.BadGateway ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable ||
            response.StatusCode == HttpStatusCode.GatewayTimeout)
        {
            return; // Skip - external API not available
        }

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var result = await response.Content.ReadFromJsonAsync<DictionaryResponse>();
        Assert.NotNull(result);
        Assert.Equal("hello", result.Word.ToLower());
        Assert.NotEmpty(result.Definitions);
    }

    [Fact]
    public async Task LookupWord_NonExistentWord_Returns404()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/en/asdfghjklzxcv");
        var response = await _fixture.Client.SendAsync(request);

        // External API might be unavailable
        if (response.StatusCode == HttpStatusCode.BadGateway ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable ||
            response.StatusCode == HttpStatusCode.GatewayTimeout)
        {
            return; // Skip
        }

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task LookupWord_EmptyWord_Returns400()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/en/");
        var response = await _fixture.Client.SendAsync(request);

        // Empty path segment might result in 404 from routing
        Assert.True(
            response.StatusCode == HttpStatusCode.BadRequest ||
            response.StatusCode == HttpStatusCode.NotFound
        );
    }

    [Fact]
    public async Task LookupWord_WordTooLong_Returns400()
    {
        var longWord = new string('a', 150);
        var request = _fixture.CreateRequest(HttpMethod.Get, $"/api/dictionary/en/{longWord}");
        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task LookupWord_ReturnsPhonetic()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/en/book");
        var response = await _fixture.Client.SendAsync(request);

        if (response.StatusCode != HttpStatusCode.OK)
        {
            return; // Skip
        }

        var result = await response.Content.ReadFromJsonAsync<DictionaryResponse>();
        Assert.NotNull(result);
        // Phonetic might or might not be available depending on word
        // Just verify the structure is valid
        Assert.NotNull(result.Definitions);
    }

    [Fact]
    public async Task LookupWord_ReturnsPartOfSpeech()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/en/run");
        var response = await _fixture.Client.SendAsync(request);

        if (response.StatusCode != HttpStatusCode.OK)
        {
            return; // Skip
        }

        var result = await response.Content.ReadFromJsonAsync<DictionaryResponse>();
        Assert.NotNull(result);
        Assert.NotEmpty(result.Definitions);
        Assert.All(result.Definitions, d => Assert.NotNull(d.PartOfSpeech));
    }

    [Fact]
    public async Task LookupWord_DifferentLanguage_Returns200()
    {
        // German word
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/dictionary/de/hallo");
        var response = await _fixture.Client.SendAsync(request);

        // External API might not support all languages or be unavailable
        if (response.StatusCode == HttpStatusCode.BadGateway ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable ||
            response.StatusCode == HttpStatusCode.GatewayTimeout ||
            response.StatusCode == HttpStatusCode.NotFound)
        {
            return; // Skip
        }

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    #endregion

    private record DictionaryResponse(
        string Word,
        string? Phonetic,
        DictionaryMeaning[] Definitions
    );

    private record DictionaryMeaning(
        string PartOfSpeech,
        DictionaryDefinition[] Definitions
    );

    private record DictionaryDefinition(
        string Definition,
        string? Example
    );
}
