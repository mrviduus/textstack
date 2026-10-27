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

    [Theory]
    [InlineData("editionId")]
    [InlineData("userBookId")]
    public async Task CreateQualityJob_UnknownBook_Returns404(string owner)
    {
        var ct = TestContext.Current.CancellationToken;
        var response = await SendAdminAsync(HttpMethod.Post, "/admin/quality/jobs",
            new Dictionary<string, Guid> { [owner] = Guid.NewGuid() }, ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Theory]
    [InlineData("entityType")]
    [InlineData("fieldType")]
    [InlineData("languageCode")]
    [InlineData("name")]
    [InlineData("promptTemplate")]
    [InlineData("outputSchema")]
    public async Task CreateSeoTemplate_MissingField_Returns400(string field)
    {
        var ct = TestContext.Current.CancellationToken;
        var body = new Dictionary<string, string>
        {
            ["entityType"] = "Edition",
            ["fieldType"] = "SeoDescription",
            ["languageCode"] = "en",
            ["name"] = "missing-field",
            ["promptTemplate"] = "x",
            ["outputSchema"] = "{}",
        };
        body.Remove(field);

        var response = await SendAdminAsync(HttpMethod.Post, "/admin/seo/templates", body, ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("name")]
    [InlineData("promptTemplate")]
    [InlineData("outputSchema")]
    public async Task UpdateSeoTemplate_MissingField_Returns400(string field)
    {
        var ct = TestContext.Current.CancellationToken;
        var body = new Dictionary<string, string>
        {
            ["name"] = "missing-field",
            ["promptTemplate"] = "x",
            ["outputSchema"] = "{}",
        };
        body.Remove(field);

        // Validation runs before the lookup: an unknown id gets 400, and nothing real is edited.
        var response = await SendAdminAsync(HttpMethod.Put, $"/admin/seo/templates/{Guid.NewGuid()}", body, ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task CreateSeoTemplate_LanguageCodeTooLong_Returns400()
    {
        var ct = TestContext.Current.CancellationToken;
        var response = await SendAdminAsync(HttpMethod.Post, "/admin/seo/templates", new
        {
            entityType = "Edition",
            fieldType = "SeoDescription",
            languageCode = "english-us",
            name = "too-long",
            promptTemplate = "x",
            outputSchema = "{}",
        }, ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task UpdateSeoTemplate_OlderVersion_Returns409AndRevivedKeyKeepsNumbering()
    {
        var ct = TestContext.Current.CancellationToken;
        // A key of its own: a random language code no real template uses.
        var body = new
        {
            entityType = "Genre",
            fieldType = "Description",
            languageCode = $"t{Guid.NewGuid():N}"[..8],
            name = "stale-edit",
            promptTemplate = "x",
            outputSchema = "{}",
        };
        async Task<(Guid Id, int Version)> Read(HttpResponseMessage r)
        {
            Assert.Equal(HttpStatusCode.OK, r.StatusCode);
            var json = await r.Content.ReadFromJsonAsync<JsonElement>(ct);
            return (json.GetProperty("id").GetGuid(), json.GetProperty("version").GetInt32());
        }

        var v1 = await Read(await SendAdminAsync(HttpMethod.Post, "/admin/seo/templates", body, ct));
        var v2 = await Read(await SendAdminAsync(HttpMethod.Put, $"/admin/seo/templates/{v1.Id}", body, ct));

        var stale = await SendAdminAsync(HttpMethod.Put, $"/admin/seo/templates/{v1.Id}", body, ct);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);

        Assert.Equal(HttpStatusCode.OK,
            (await SendAdminAsync(HttpMethod.Delete, $"/admin/seo/templates/{v2.Id}", null, ct)).StatusCode);
        var revived = await Read(await SendAdminAsync(HttpMethod.Post, "/admin/seo/templates", body, ct));
        await SendAdminAsync(HttpMethod.Delete, $"/admin/seo/templates/{revived.Id}", null, ct);

        Assert.Equal((1, 2, 3), (v1.Version, v2.Version, revived.Version));
    }
}
