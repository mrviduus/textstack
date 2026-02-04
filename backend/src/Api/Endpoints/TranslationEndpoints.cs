using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace Api.Endpoints;

public static class TranslationEndpoints
{
    public static void MapTranslationEndpoints(this WebApplication app)
    {
        var group = app.MapGroup("/api/translate").WithTags("Translation");

        group.MapPost("", Translate).WithName("Translate");
        group.MapGet("/languages", GetLanguages).WithName("GetTranslationLanguages");
    }

    private static async Task<IResult> Translate(
        [FromBody] TranslateRequest request,
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        CancellationToken ct)
    {
        var maxLength = config.GetValue("LibreTranslate:MaxTextLength", 500);
        var baseUrl = config.GetValue<string>("LibreTranslate:BaseUrl") ?? "http://localhost:5000";
        var timeout = config.GetValue("LibreTranslate:TimeoutSeconds", 30);

        // Validate input
        if (string.IsNullOrWhiteSpace(request.Text))
            return Results.BadRequest("Text is required");

        if (request.Text.Length > maxLength)
            return Results.BadRequest($"Text exceeds maximum length of {maxLength} characters");

        if (string.IsNullOrWhiteSpace(request.SourceLang))
            return Results.BadRequest("Source language is required");

        if (string.IsNullOrWhiteSpace(request.TargetLang))
            return Results.BadRequest("Target language is required");

        try
        {
            var client = httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(timeout);

            var libreRequest = new
            {
                q = request.Text,
                source = request.SourceLang,
                target = request.TargetLang,
                format = "text"
            };

            var response = await client.PostAsJsonAsync($"{baseUrl}/translate", libreRequest, ct);

            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(ct);
                return Results.Problem(
                    detail: $"Translation service error: {response.StatusCode}",
                    statusCode: 502
                );
            }

            var result = await response.Content.ReadFromJsonAsync<LibreTranslateResponse>(ct);

            if (result == null || string.IsNullOrEmpty(result.TranslatedText))
                return Results.Problem("Translation service returned empty result", statusCode: 502);

            return Results.Ok(new TranslateResponse(
                result.TranslatedText,
                request.SourceLang,
                request.TargetLang
            ));
        }
        catch (TaskCanceledException)
        {
            return Results.Problem("Translation request timed out", statusCode: 504);
        }
        catch (HttpRequestException ex)
        {
            return Results.Problem(
                detail: $"Translation service unavailable: {ex.Message}",
                statusCode: 503
            );
        }
    }

    private static async Task<IResult> GetLanguages(
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        CancellationToken ct)
    {
        var baseUrl = config.GetValue<string>("LibreTranslate:BaseUrl") ?? "http://localhost:5000";
        var timeout = config.GetValue("LibreTranslate:TimeoutSeconds", 30);

        try
        {
            var client = httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(timeout);

            var response = await client.GetAsync($"{baseUrl}/languages", ct);

            if (!response.IsSuccessStatusCode)
                return Results.Problem("Failed to fetch languages", statusCode: 502);

            var languages = await response.Content.ReadFromJsonAsync<List<LibreTranslateLanguage>>(ct);

            return Results.Ok(languages?.Select(l => new LanguageInfo(l.Code, l.Name)) ?? []);
        }
        catch (HttpRequestException)
        {
            return Results.Problem("Translation service unavailable", statusCode: 503);
        }
    }
}

// Request/Response DTOs
public record TranslateRequest(
    string Text,
    string SourceLang,
    string TargetLang
);

public record TranslateResponse(
    string TranslatedText,
    string SourceLang,
    string TargetLang
);

public record LanguageInfo(string Code, string Name);

// LibreTranslate API response types
file class LibreTranslateResponse
{
    public string TranslatedText { get; set; } = "";
}

file class LibreTranslateLanguage
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
}
