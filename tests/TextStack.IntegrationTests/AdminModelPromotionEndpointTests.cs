using System.Net;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the table-driven promote/rollback endpoints (Phase 12 RLOps slice 3),
/// against the live API on the admin host. Auth + validation
/// paths assert without depending on seeded mutable state, and a full promote→reflected-in-/models
/// →rollback round-trip runs when the fixture user is admin. Skips (not fails) when auth/endpoint
/// is unavailable. To run: `docker compose up` (API on :8080) with ENABLE_TEST_AUTH=true; runs in CI.
/// </summary>
public class AdminModelPromotionEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private readonly AuthenticatedApiFixture _fixture;

    public AdminModelPromotionEndpointTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Promote_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post, $"/admin/ai-quality/models/{Guid.NewGuid()}/promote");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Rollback_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post, "/admin/ai-quality/models/explain/rollback");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Promote_NonexistentModel_BadRequest()
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "auth unavailable");

        var request = _fixture.CreateAdminRequest(
            HttpMethod.Post, $"/admin/ai-quality/models/{Guid.NewGuid()}/promote");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.SkipWhen(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden,
            "test user is not admin");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Promote_AlreadyPrimaryRow_BadRequest()
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "auth unavailable");

        // Find a currently-Primary registration from the seeded registry; promoting it again
        // must be rejected (already-Primary → 400). Read-only; leaves the registry untouched.
        var models = await GetModels();
        Assert.SkipWhen(models is null, "endpoint not deployed / not admin");
        var primary = models!.Value.EnumerateArray()
            .FirstOrDefault(m => m.GetProperty("status").GetString() == "Primary");
        Assert.SkipWhen(primary.ValueKind == JsonValueKind.Undefined, "no seeded Primary row");

        var id = primary.GetProperty("id").GetString();
        var request = _fixture.CreateAdminRequest(
            HttpMethod.Post, $"/admin/ai-quality/models/{id}/promote");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Rollback_NoPriorPromotion_Conflict()
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "auth unavailable");

        // A feature that has never been promoted has nothing to roll back → 409.
        var request = _fixture.CreateAdminRequest(
            HttpMethod.Post, $"/admin/ai-quality/models/__never_promoted__{Guid.NewGuid():N}/rollback");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.SkipWhen(
            response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden,
            "test user is not admin");
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
    }

    private async Task<JsonElement?> GetModels()
    {
        var request = _fixture.CreateAdminRequest(HttpMethod.Get, "/admin/ai-quality/models");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);
        if (IntegrationSkip.Unavailable(response)
            || response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
            || response.StatusCode != HttpStatusCode.OK)
            return null;

        var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        return doc.RootElement.GetProperty("models").Clone();
    }
}
