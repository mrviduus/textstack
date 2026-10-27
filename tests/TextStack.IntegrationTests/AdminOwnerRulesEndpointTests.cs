using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Admin writes refuse rows that 0012's constraints would reject (#939): a quality job with both
/// owners, a second active SEO template for one key. Needs the fixture's test user to be admin;
/// otherwise skipped. To run: `docker compose up` (API on :8080) with `ENABLE_TEST_AUTH=true`.
/// </summary>
public class AdminOwnerRulesEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private readonly AuthenticatedApiFixture _fixture;

    public AdminOwnerRulesEndpointTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    private async Task<HttpResponseMessage> SendAdminAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "auth unavailable");
        var request = _fixture.CreateAdminRequest(method, path);
        if (body is not null) request.Content = JsonContent.Create(body);
        var response = await _fixture.Client.SendAsync(request, ct);
        Assert.SkipWhen(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden,
            "test user is not admin");
        return response;
    }

    [Fact]
    public async Task CreateQualityJob_BothEditionAndUserBook_Returns400()
    {
        var ct = TestContext.Current.CancellationToken;
        var response = await SendAdminAsync(HttpMethod.Post, "/admin/quality/jobs",
            new { editionId = Guid.NewGuid(), userBookId = Guid.NewGuid() }, ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateSeoTemplate_KeyAlreadyActive_Returns409()
    {
        var ct = TestContext.Current.CancellationToken;
        var list = await SendAdminAsync(HttpMethod.Get, "/admin/seo/templates", null, ct);
        Assert.Equal(HttpStatusCode.OK, list.StatusCode);
        var active = (await list.Content.ReadFromJsonAsync<JsonElement>(ct)).EnumerateArray().FirstOrDefault();
        Assert.SkipWhen(active.ValueKind == JsonValueKind.Undefined, "no active template seeded");

        var response = await SendAdminAsync(HttpMethod.Post, "/admin/seo/templates", new
        {
            entityType = active.GetProperty("entityType").GetString(),
            fieldType = active.GetProperty("fieldType").GetString(),
            languageCode = active.GetProperty("languageCode").GetString(),
            name = "duplicate",
            promptTemplate = "x",
            outputSchema = "{}",
        }, ct);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }
}
