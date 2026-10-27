using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the admin agent-run transcript endpoints (AI-045), against the live API on
/// the admin host (textstack.dev). Mirrors the Study Buddy live-server pattern: auth + validation +
/// not-found paths are asserted without needing seeded rows (an empty agent_run table still returns a
/// well-formed page), and the list/detail shapes are sanity-checked. A run requires the fixture's admin
/// session; without one the relevant tests skip locally and fail in CI (#990).
///
/// To run: requires `docker compose up` (API on :8080) with `ENABLE_TEST_AUTH=true`. The authed
/// assertions log in as ADMIN_EMAIL / ADMIN_PASSWORD (see <see cref="AuthenticatedApiFixture"/>).
/// </summary>
public class AdminAgentRunsEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private readonly AuthenticatedApiFixture _fixture;

    public AdminAgentRunsEndpointTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task GetAgentRuns_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/admin/ai-quality/agent-runs");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetAgentRuns_Authed_ReturnsPagedShape_ListOmitsStepsJson()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(HttpMethod.Get, "/admin/ai-quality/agent-runs?limit=5");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var root = doc.RootElement;

        Assert.True(root.TryGetProperty("total", out _), "page has total");
        Assert.True(root.TryGetProperty("items", out var items), "page has items");
        Assert.Equal(JsonValueKind.Array, items.ValueKind);

        // List items must NOT carry the heavy transcript / final output.
        foreach (var item in items.EnumerateArray())
        {
            Assert.False(item.TryGetProperty("stepsJson", out _), "list item must omit stepsJson");
            Assert.False(item.TryGetProperty("output", out _), "list item must omit output");
            Assert.True(item.TryGetProperty("agent", out _));
            Assert.True(item.TryGetProperty("hasError", out _));
        }
    }

    [Fact]
    public async Task GetAgentRuns_AgentFilter_ReturnsOnlyMatching()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(
            HttpMethod.Get, "/admin/ai-quality/agent-runs?agent=crew.autopublish&limit=10");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        foreach (var item in doc.RootElement.GetProperty("items").EnumerateArray())
        {
            var agent = item.GetProperty("agent").GetString();
            Assert.StartsWith("crew.autopublish", agent);
        }
    }

    [Fact]
    public async Task GetAgentRun_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(
            HttpMethod.Get, $"/admin/ai-quality/agent-runs/{Guid.NewGuid()}");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetAgentRun_AuthedUnknownId_NotFound()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(
            HttpMethod.Get, $"/admin/ai-quality/agent-runs/{Guid.NewGuid()}");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
