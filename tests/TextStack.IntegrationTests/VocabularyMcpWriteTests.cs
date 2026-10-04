using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// The API half of the MCP vocabulary write tools: a save with no native language falls back to the
/// profile's, a connect-key save is tagged <c>source = "mcp"</c> server-side, and the word routes share
/// the per-user <c>highlight-write</c> limit. (The OAuth wipe-all refusal is in <see cref="OAuthFlowTests"/>.)
/// Every test uses a fresh account, so the per-user limiter partition starts empty.
/// </summary>
public class VocabularyMcpWriteTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public VocabularyMcpWriteTests(LiveApiFixture fixture) => _fixture = fixture;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task SaveWord_NoNativeLanguage_UsesProfileValue()
    {
        var jwt = await SignUpAsync();
        Assert.SkipWhen(jwt is null, "registration unavailable");

        // No profile native language yet → still refused.
        var refused = await SaveAsync(jwt!, "obstinate");
        Assert.Equal(HttpStatusCode.BadRequest, refused.StatusCode);
        Assert.Contains("native_language_required", await refused.Content.ReadAsStringAsync(Ct));

        var profile = await SendAsync(HttpMethod.Put, "/me/profile", jwt!, new { nativeLanguage = "uk" });
        Assert.True(profile.IsSuccessStatusCode, $"PUT /me/profile → {(int)profile.StatusCode}");

        var saved = await SaveAsync(jwt!, "obstinate");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);
        var outcome = (await saved.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("outcome").GetString();
        Assert.Equal("srs", outcome);
    }

    [Fact]
    public async Task SaveWord_ConnectKey_IsTaggedMcp_JwtIsTaggedTap()
    {
        var jwt = await SignUpAsync();
        Assert.SkipWhen(jwt is null, "registration unavailable");
        var key = await MintKeyAsync(jwt!);

        // Smallest daily cap, filled, so the next saves land in the pending bucket — whose DTO is the
        // one that exposes Source.
        var settings = await SendAsync(HttpMethod.Put, "/me/vocabulary/settings", jwt!, new
        {
            dailyNewCap = 5,
            weeklyReviewBudget = 100,
            frequencyFilterEnabled = false,
            clusteringEnabled = false,
            autoRetireEnabled = false,
            autoSpeakCards = true,
        });
        Assert.True(settings.IsSuccessStatusCode, $"PUT settings → {(int)settings.StatusCode}");
        Assert.True((await SendAsync(HttpMethod.Put, "/me/profile", jwt!, new { nativeLanguage = "uk" })).IsSuccessStatusCode);
        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.OK, (await SaveAsync(jwt!, $"filler{i}", "uk")).StatusCode);

        // Sent the way the bridge sends it: no native language, so the profile's is used.
        Assert.Equal(HttpStatusCode.OK, (await SaveAsync(key, "assistantword")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SaveAsync(jwt!, "readerword", "uk")).StatusCode);

        var pending = await SendAsync(HttpMethod.Get, "/me/vocabulary/pending", jwt!);
        var items = (await pending.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("items").EnumerateArray().ToList();
        Assert.Equal("mcp", items.Single(p => p.GetProperty("word").GetString() == "assistantword").GetProperty("source").GetString());
        Assert.Equal("tap", items.Single(p => p.GetProperty("word").GetString() == "readerword").GetProperty("source").GetString());
    }

    [Fact]
    public async Task WordWrites_121stInAMinute_Returns429()
    {
        var jwt = await SignUpAsync();
        Assert.SkipWhen(jwt is null, "registration unavailable");

        // 120 cheap writes (deleting ids that do not exist — 404, no rows touched) fill the per-user
        // `highlight-write` window; the 121st, a save on a different word route, is refused.
        for (var i = 0; i < 120; i++)
        {
            var resp = await SendAsync(HttpMethod.Delete, $"/me/vocabulary/words/{Guid.NewGuid()}", jwt!);
            Assert.True(resp.StatusCode == HttpStatusCode.NotFound, $"write {i + 1} → {(int)resp.StatusCode}");
        }

        Assert.Equal(HttpStatusCode.TooManyRequests, (await SaveAsync(jwt!, "onemore", "uk")).StatusCode);
    }

    // ── helpers ─────────────────────────────────────────────────────────────────

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, string bearer, object? body = null)
    {
        var req = _fixture.CreateRequest(method, path);
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearer}");
        if (body is not null) req.Content = JsonContent.Create(body);
        return await _fixture.Client.SendAsync(req, Ct);
    }

    private Task<HttpResponseMessage> SaveAsync(string bearer, string word, string? nativeLanguage = null) =>
        SendAsync(HttpMethod.Post, "/me/vocabulary/words", bearer,
            new { word, language = "en", translation = "t", nativeLanguage });

    private async Task<string> MintKeyAsync(string jwt)
    {
        var resp = await SendAsync(HttpMethod.Post, "/me/mcp/keys", jwt, new { name = "Vocab probe" });
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);
        return (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("key").GetString()!;
    }

    /// <summary>A fresh account. <c>X-Client: mobile</c> so the token comes back in the body.</summary>
    private async Task<string?> SignUpAsync()
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        req.Headers.Add("X-Client", "mobile");
        req.Content = JsonContent.Create(new
        {
            email = $"vocab-mcp-{Guid.NewGuid():N}@textstack.test",
            password = "correct-horse-battery",
            name = "Vocab Probe",
        });
        var resp = await _fixture.Client.SendAsync(req, Ct);
        if (IntegrationSkip.Unavailable(resp) || !resp.IsSuccessStatusCode) return null;
        return (await resp.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("accessToken").GetString();
    }
}
