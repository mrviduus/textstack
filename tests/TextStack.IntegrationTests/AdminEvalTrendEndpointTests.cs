using System.Net;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the scheduled-eval trend endpoint (Phase 12 RLOps slice 5a), against
/// the live API on the admin host. The endpoint returns RunType='scheduled' eval rows newest-first
/// (the Drift tab in slice 5b consumes it). Scheduled evals are OFF by default, so the regression
/// guarantee is: admin-gated (401 without auth), and a well-formed (possibly empty) array when
/// authed. Each row, if present, carries the scheduled-eval point shape.
///
/// To run: `docker compose up` (API on :8080) with `ENABLE_TEST_AUTH=true`; runs in CI.
/// </summary>
public class AdminEvalTrendEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private readonly AuthenticatedApiFixture _fixture;

    public AdminEvalTrendEndpointTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task GetEvalTrend_NoAuth_Unauthorized()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/admin/ai-quality/drift/eval-trend");
        request.Headers.Host = AuthenticatedApiFixture.AdminHost;

        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(response.StatusCode is HttpStatusCode.NotFound, "endpoint not deployed");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task GetEvalTrend_Authed_ReturnsScheduledRowsArray()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(HttpMethod.Get, "/admin/ai-quality/drift/eval-trend");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        var root = doc.RootElement;
        // Scheduled evals OFF by default → empty array is the expected steady state. Either way the
        // payload is a well-formed array; every present row carries the scheduled-eval point shape.
        Assert.Equal(JsonValueKind.Array, root.ValueKind);

        foreach (var row in root.EnumerateArray())
        {
            Assert.True(row.TryGetProperty("feature", out var feature));
            Assert.Equal(JsonValueKind.String, feature.ValueKind);
            Assert.True(row.TryGetProperty("modelId", out _));
            Assert.True(row.TryGetProperty("score", out _));
            Assert.True(row.TryGetProperty("n", out _));
            Assert.True(row.TryGetProperty("createdAt", out _));
        }
    }

    [Fact]
    public async Task GetEvalTrend_FilteredByMissingFeature_ReturnsEmpty()
    {
        _fixture.RequireAdmin();

        var request = _fixture.CreateAdminRequest(
            HttpMethod.Get, "/admin/ai-quality/drift/eval-trend?feature=__no_such_feature__&limit=5");
        var response = await _fixture.Client.SendAsync(request, TestContext.Current.CancellationToken);

        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint not deployed");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        using var doc = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal(JsonValueKind.Array, doc.RootElement.ValueKind);
        Assert.Equal(0, doc.RootElement.GetArrayLength());
    }
}
