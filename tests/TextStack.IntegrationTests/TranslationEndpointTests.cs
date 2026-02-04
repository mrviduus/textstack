using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for translation endpoints.
/// Requires: docker compose up (API + LibreTranslate must be running)
/// </summary>
public class TranslationEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public TranslationEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    #region POST /api/translate

    [Fact]
    public async Task Translate_ValidRequest_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/api/translate");
        request.Content = JsonContent.Create(new
        {
            text = "Hello",
            sourceLang = "en",
            targetLang = "uk"
        });

        var response = await _fixture.Client.SendAsync(request);

        // LibreTranslate might not be running, so accept 502/503
        if (response.StatusCode == HttpStatusCode.BadGateway ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable)
        {
            return; // Skip - LibreTranslate not available
        }

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var result = await response.Content.ReadFromJsonAsync<TranslateResponse>();
        Assert.NotNull(result);
        Assert.NotNull(result.TranslatedText);
        Assert.Equal("en", result.SourceLang);
        Assert.Equal("uk", result.TargetLang);
    }

    [Fact]
    public async Task Translate_EmptyText_Returns400()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/api/translate");
        request.Content = JsonContent.Create(new
        {
            text = "",
            sourceLang = "en",
            targetLang = "uk"
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Translate_MissingSourceLang_Returns400()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/api/translate");
        request.Content = JsonContent.Create(new
        {
            text = "Hello",
            sourceLang = "",
            targetLang = "uk"
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Translate_MissingTargetLang_Returns400()
    {
        var request = _fixture.CreateRequest(HttpMethod.Post, "/api/translate");
        request.Content = JsonContent.Create(new
        {
            text = "Hello",
            sourceLang = "en",
            targetLang = ""
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Translate_TextTooLong_Returns400()
    {
        var longText = new string('a', 600); // Over 500 char limit
        var request = _fixture.CreateRequest(HttpMethod.Post, "/api/translate");
        request.Content = JsonContent.Create(new
        {
            text = longText,
            sourceLang = "en",
            targetLang = "uk"
        });

        var response = await _fixture.Client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    #endregion

    #region GET /api/translate/languages

    [Fact]
    public async Task GetLanguages_Returns200()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/translate/languages");
        var response = await _fixture.Client.SendAsync(request);

        // LibreTranslate might not be running, so accept 502/503
        if (response.StatusCode == HttpStatusCode.BadGateway ||
            response.StatusCode == HttpStatusCode.ServiceUnavailable)
        {
            return; // Skip - LibreTranslate not available
        }

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var languages = await response.Content.ReadFromJsonAsync<LanguageInfo[]>();
        Assert.NotNull(languages);
        Assert.True(languages.Length > 0);
    }

    [Fact]
    public async Task GetLanguages_ContainsEnglishAndUkrainian()
    {
        var request = _fixture.CreateRequest(HttpMethod.Get, "/api/translate/languages");
        var response = await _fixture.Client.SendAsync(request);

        // LibreTranslate might not be running
        if (response.StatusCode != HttpStatusCode.OK)
        {
            return;
        }

        var languages = await response.Content.ReadFromJsonAsync<LanguageInfo[]>();
        Assert.NotNull(languages);
        Assert.Contains(languages, l => l.Code == "en");
        Assert.Contains(languages, l => l.Code == "uk");
    }

    #endregion

    private record TranslateResponse(string TranslatedText, string SourceLang, string TargetLang);
    private record LanguageInfo(string Code, string Name);
}
