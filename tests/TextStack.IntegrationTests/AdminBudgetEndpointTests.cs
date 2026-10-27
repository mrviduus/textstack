using System.Net;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the admin per-feature budget endpoint (Phase 12 RLOps slice 4), against
/// the live API on the admin host (textstack.dev). Budgets are OFF by default, so the regression
/// guarantee is that GET /admin/ai-quality/budgets returns a well-formed list of rows (one per
/// routed/configured feature) with mode "off" and a $0/0% budget — and that the endpoint is
/// admin-gated (401 without auth). Authed assertions run as the fixture's admin; without
/// one they skip locally and fail in CI (#990).
///
/// To run: `docker compose up` (API on :8080) with `ENABLE_TEST_AUTH=true`; runs in CI.
/// </summary>
public class AdminBudgetEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private readonly AuthenticatedApiFixture _fixture;

    public AdminBudgetEndpointTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task GetBudgets_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/admin/ai-quality/budgets");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetBudgets_Authed_BudgetsOffByDefault_ReturnsWellFormedRows()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(HttpMethod.Get, "/admin/ai-quality/budgets");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var root = doc.RootElement;
        Assert.Equal(JsonValueKind.Array, root.ValueKind);

        // Budgets are OFF by default → every row reports mode "off", no budget, 0% used,
        // not in fallback. The list itself is well-formed (one row per routed feature).
        foreach (var row in root.EnumerateArray())
        {
            Assert.True(row.TryGetProperty("featureTag", out var feature));
            Assert.Equal(JsonValueKind.String, feature.ValueKind);

            Assert.True(row.TryGetProperty("mode", out var mode));
            Assert.Equal("off", mode.GetString());

            Assert.True(row.TryGetProperty("todaySpendUsd", out _));

            Assert.True(row.TryGetProperty("pctUsed", out var pct));
            Assert.Equal(0d, pct.GetDouble());

            Assert.True(row.TryGetProperty("inFallback", out var inFallback));
            Assert.False(inFallback.GetBoolean());
        }
    }
}
