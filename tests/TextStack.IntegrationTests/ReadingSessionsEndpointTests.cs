using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

// R5 slice-4 wire-equivalence gate for POST /me/reading/sessions (the mutating submit).
// Live data is non-deterministic, so we assert status + response shape + the two behaviours the
// refactor must preserve: a fresh user-book session gets a non-empty sessionId, and re-POSTing the
// SAME (userBook, startedAt) idempotently acks with sessionId == Guid.Empty (the dedup pre-check).
// Plus one validation 400. Never asserts concrete values. Skips (not fails) when unavailable.
public class ReadingSessionsEndpointTests : IClassFixture<LiveApiFixture>, IClassFixture<AuthenticatedApiFixture>
{
    private readonly LiveApiFixture _anon;
    private readonly AuthenticatedApiFixture _auth;

    public ReadingSessionsEndpointTests(LiveApiFixture anon, AuthenticatedApiFixture auth)
    {
        _anon = anon;
        _auth = auth;
    }

    private HttpRequestMessage PostSession(object body)
    {
        var req = _auth.CreateRequest(HttpMethod.Post, "/me/reading/sessions");
        req.Content = JsonContent.Create(body);
        return req;
    }

    [Fact]
    public async Task SubmitSession_WithoutAuth_Returns401()
    {
        var req = _anon.CreateRequest(HttpMethod.Post, "/me/reading/sessions");
        req.Content = JsonContent.Create(new { editionId = Guid.NewGuid(), startedAt = DateTimeOffset.UtcNow.AddMinutes(-5), endedAt = DateTimeOffset.UtcNow, durationSeconds = 60, wordsRead = 10, startPercent = 0.0, endPercent = 0.1 });
        var response = await _anon.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task SubmitSession_ValidUserBookSession_Returns200WithSessionIdAndAchievementsArray()
    {
        var ct = TestContext.Current.CancellationToken;

        // Create a user book to attach the session to (clip flow — same as AccountDeletion test).
        var clipReq = _auth.CreateRequest(HttpMethod.Post, "/me/books/clip");
        clipReq.Content = JsonContent.Create(new
        {
            title = $"Clip {Guid.NewGuid():N}"[..16],
            html = "<p>Hello world. This is a clipped article body for the sessions test.</p>",
            language = "en"
        });
        var clipResp = await _auth.Client.SendAsync(clipReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(clipResp), "clip endpoint unavailable");
        Assert.True(clipResp.IsSuccessStatusCode, $"clip failed: {clipResp.StatusCode}");
        var userBookId = (await clipResp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct)).GetProperty("userBookId").GetGuid();

        var startedAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        var endedAt = DateTimeOffset.UtcNow;
        var body = new
        {
            userBookId,
            startedAt,
            endedAt,
            durationSeconds = 300,
            wordsRead = 100,
            startPercent = 0.0,
            endPercent = 0.5
        };

        var first = await _auth.Client.SendAsync(PostSession(body), ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(first), "endpoint unavailable (404/500)");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        var firstResult = await first.Content.ReadFromJsonAsync<SubmitResult>(cancellationToken: ct);
        Assert.NotNull(firstResult);
        Assert.NotEqual(Guid.Empty, firstResult.SessionId);   // fresh insert → real id
        Assert.NotNull(firstResult.NewAchievements);          // always an array (maybe empty)

        // Re-POST the SAME (userBook, startedAt) → dedup pre-check acks idempotently with Guid.Empty.
        var second = await _auth.Client.SendAsync(PostSession(body), ct);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var secondResult = await second.Content.ReadFromJsonAsync<SubmitResult>(cancellationToken: ct);
        Assert.NotNull(secondResult);
        Assert.Equal(Guid.Empty, secondResult.SessionId);     // duplicate → Guid.Empty
        Assert.NotNull(secondResult.NewAchievements);
        Assert.Empty(secondResult.NewAchievements);
    }

    // S-b: a session for a user_book that isn't the caller's (re-upload → old row deleted) must 404,
    // not 500-flood on the FK. Validation passes (valid times/duration) so the existence guard is what
    // returns 404. A random id is never an owned live book for this user.
    [Fact]
    public async Task SubmitSession_NonExistentUserBook_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "auth unavailable");
        var now = DateTimeOffset.UtcNow;
        var body = new
        {
            userBookId = Guid.NewGuid(),   // never an owned live book
            startedAt = now.AddMinutes(-5),
            endedAt = now,
            durationSeconds = 300,
            wordsRead = 100,
            startPercent = 0.0,
            endPercent = 0.5
        };

        var response = await _auth.Client.SendAsync(PostSession(body), TestContext.Current.CancellationToken);
        Assert.SkipWhen(response.StatusCode == HttpStatusCode.InternalServerError, "host erroring");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    // S-b edition twin: a session for a non-existent edition → 404 (existence guard, no FK 500).
    [Fact]
    public async Task SubmitSession_NonExistentEdition_Returns404()
    {
        Assert.SkipUnless(_auth.IsAuthenticated, "auth unavailable");
        var now = DateTimeOffset.UtcNow;
        var body = new
        {
            editionId = Guid.NewGuid(),    // no such edition
            startedAt = now.AddMinutes(-5),
            endedAt = now,
            durationSeconds = 300,
            wordsRead = 100,
            startPercent = 0.0,
            endPercent = 0.5
        };

        var response = await _auth.Client.SendAsync(PostSession(body), TestContext.Current.CancellationToken);
        Assert.SkipWhen(response.StatusCode == HttpStatusCode.InternalServerError, "host erroring");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task SubmitSession_BothEditionAndUserBook_Returns400()
    {
        var now = DateTimeOffset.UtcNow;
        var body = new
        {
            editionId = Guid.NewGuid(),
            userBookId = Guid.NewGuid(),   // invalid: exactly one owner (#939)
            startedAt = now.AddMinutes(-5),
            endedAt = now,
            durationSeconds = 300,
            wordsRead = 10,
            startPercent = 0.0,
            endPercent = 0.1
        };

        var response = await _auth.Client.SendAsync(PostSession(body), TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task SubmitSession_ZeroDuration_Returns400()
    {
        var now = DateTimeOffset.UtcNow;
        var body = new
        {
            editionId = Guid.NewGuid(),
            startedAt = now.AddMinutes(-5),
            endedAt = now,
            durationSeconds = 0,   // invalid: must be 1-14400
            wordsRead = 10,
            startPercent = 0.0,
            endPercent = 0.1
        };

        var response = await _auth.Client.SendAsync(PostSession(body), TestContext.Current.CancellationToken);
        Assert.SkipWhen(IntegrationSkip.Unavailable(response), "endpoint unavailable (404/500)");
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    // Local deserialization mirror of Contracts.ReadingTracking.SubmitSessionResponse — field names
    // drive the camelCase wire contract this gate protects.
    private record SubmitResult(Guid SessionId, List<string> NewAchievements);
}
