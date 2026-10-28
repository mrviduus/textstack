using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration coverage for the Phase 1 anti-spiral endpoints & shape:
/// weekly budget progress on review queue + stats, settings CRUD, and unretire.
/// Skips authenticated paths when docker compose isn't running or
/// ENABLE_TEST_AUTH isn't set.
/// </summary>
[Collection("VocabularySpiral")]
public class VocabularyAntiSpiralEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _anon;
    private readonly AuthenticatedApiFixture _auth;

    public VocabularyAntiSpiralEndpointTests(LiveApiFixture anon, AuthenticatedApiFixture auth)
    {
        _anon = anon;
        _auth = auth;
    }

    #region Unauthenticated → 401

    [Fact]
    public async Task GetSettings_WithoutAuth_Returns401()
    {
        var request = _anon.CreateRequest(HttpMethod.Get, "/me/vocabulary/settings");
        var response = await _anon.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task UpdateSettings_WithoutAuth_Returns401()
    {
        var request = _anon.CreateRequest(HttpMethod.Put, "/me/vocabulary/settings");
        request.Content = JsonContent.Create(new { dailyNewCap = 15, weeklyReviewBudget = 70, frequencyFilterEnabled = true, clusteringEnabled = true, autoRetireEnabled = true });
        var response = await _anon.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Unretire_WithoutAuth_Returns401()
    {
        var request = _anon.CreateRequest(HttpMethod.Post, $"/me/vocabulary/words/{Guid.NewGuid()}/unretire");
        var response = await _anon.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    #endregion

    #region Authenticated — budget shape

    [Fact]
    public async Task GetSettings_Authenticated_ReturnsDefaultsForNewUser()
    {
        var request = _auth.CreateRequest(HttpMethod.Get, "/me/vocabulary/settings");
        var response = await _auth.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: TestContext.Current.CancellationToken);

        // Defaults from the anti-spiral plan — if these change, bump the shared
        // constants too.
        Assert.Equal(15, body.GetProperty("dailyNewCap").GetInt32());
        Assert.Equal(70, body.GetProperty("weeklyReviewBudget").GetInt32());
    }

    [Fact]
    public async Task GetReviewQueue_Authenticated_IncludesWeeklyProgress()
    {
        var request = _auth.CreateRequest(HttpMethod.Get, "/me/vocabulary/review");
        var response = await _auth.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: TestContext.Current.CancellationToken);

        Assert.True(body.TryGetProperty("weeklyProgress", out var progress), "queue response must include weeklyProgress");
        Assert.True(progress.TryGetProperty("used", out _));
        Assert.True(progress.TryGetProperty("budget", out _));
        Assert.True(progress.TryGetProperty("remaining", out _));
    }

    [Fact]
    public async Task GetStats_Authenticated_IncludesRetiredAndWeeklyProgress()
    {
        var request = _auth.CreateRequest(HttpMethod.Get, "/me/vocabulary/stats");
        var response = await _auth.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: TestContext.Current.CancellationToken);

        Assert.True(body.TryGetProperty("retiredCount", out _));
        Assert.True(body.TryGetProperty("weeklyProgress", out _));
    }

    [Fact]
    public async Task UpdateSettings_Authenticated_RoundTrips()
    {
        var payload = new { dailyNewCap = 20, weeklyReviewBudget = 100, frequencyFilterEnabled = true, clusteringEnabled = false, autoRetireEnabled = true };
        var request = _auth.CreateRequest(HttpMethod.Put, "/me/vocabulary/settings");
        request.Content = JsonContent.Create(payload);
        var response = await _auth.Client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: TestContext.Current.CancellationToken);
        Assert.Equal(20, body.GetProperty("dailyNewCap").GetInt32());
        Assert.Equal(100, body.GetProperty("weeklyReviewBudget").GetInt32());
        Assert.False(body.GetProperty("clusteringEnabled").GetBoolean());

        // Restore defaults so we don't poison later test runs that share the
        // integration test user.
        var reset = _auth.CreateRequest(HttpMethod.Put, "/me/vocabulary/settings");
        reset.Content = JsonContent.Create(new { dailyNewCap = 15, weeklyReviewBudget = 70, frequencyFilterEnabled = true, clusteringEnabled = true, autoRetireEnabled = true });
        await _auth.Client.SendAsync(reset, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task Unretire_NonexistentWord_Returns404()
    {
        var request = _auth.CreateRequest(HttpMethod.Post, $"/me/vocabulary/words/{Guid.NewGuid()}/unretire");
        var response = await _auth.Client.SendAsync(request, TestContext.Current.CancellationToken);
        // No IntegrationSkip.Unavailable here: 404 IS the expected answer, so that guard skipped this
        // test on every run instead of letting it pass.
        Assert.SkipUnless(_auth.IsAuthenticated, "test auth unavailable");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        // A missing route is a 404 too. A wrong method on an existing route is a 405: the route is there.
        var probe = _auth.CreateRequest(HttpMethod.Get, $"/me/vocabulary/words/{Guid.NewGuid()}/unretire");
        var probeResponse = await _auth.Client.SendAsync(probe, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, probeResponse.StatusCode);
    }

    #endregion
}
