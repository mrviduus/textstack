using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// The connect key end to end, against a live API: mint → authenticate with it → revoke → refuse.
///
/// <para><b>Why this file exists at all.</b> <c>GuestActivityMiddleware</c> is dead code in this
/// codebase — it reads a claim the pipeline never populates, so <c>users.LastActiveAt</c> has never
/// been written outside guest creation. Nothing caught it because nobody wrote the test that asks
/// "did the side effect actually happen". The connect key has the same shape: a middleware that
/// resolves a bearer and stamps a column. So the last-used assertion below is not a nice-to-have —
/// it is the specific test whose absence produced the last silent failure of exactly this kind.</para>
///
/// <para>Revocation is asserted from the other end too: a revoked key must stop authenticating in the
/// same request, with no cached decision. The middleware checks <c>RevokedAt</c> inside the lookup
/// query for that reason, and this is what proves it.</para>
/// </summary>
public class McpKeyEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;

    public McpKeyEndpointTests(LiveApiFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task ConnectKey_MintUseRevoke_AuthenticatesThenStopsDead()
    {
        var ct = TestContext.Current.CancellationToken;

        var owner = await SignUpAsync(ct);
        Assert.SkipWhen(owner is null, "registration unavailable");

        // --- mint ---------------------------------------------------------------------------
        var createReq = _fixture.CreateRequest(HttpMethod.Post, "/me/mcp/keys");
        createReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {owner}");
        createReq.Content = JsonContent.Create(new { name = "Integration probe" });

        var createResp = await _fixture.Client.SendAsync(createReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(createResp), "/me/mcp/keys unavailable");
        Assert.Equal(HttpStatusCode.OK, createResp.StatusCode);

        var created = await createResp.Content.ReadFromJsonAsync<JsonElement>(ct);
        var rawKey = created.GetProperty("key").GetString();
        var keyId = created.GetProperty("id").GetString();

        Assert.False(string.IsNullOrWhiteSpace(rawKey));
        Assert.StartsWith("tsk_", rawKey, StringComparison.Ordinal);
        // The clear-text head is stored for display and must genuinely be a prefix of the secret.
        Assert.StartsWith(created.GetProperty("prefix").GetString()!, rawKey, StringComparison.Ordinal);

        // --- it authenticates, and it is never echoed back -----------------------------------
        var listed = await ListKeysAsync(rawKey!, ct);
        Assert.Contains(listed.EnumerateArray(), k => k.GetProperty("id").GetString() == keyId);
        // The SECRET is never echoed back. Not "no tsk_ anywhere" — the display prefix legitimately
        // starts with it, which is the point of having a prefix at all.
        Assert.DoesNotContain(rawKey!, listed.ToString(), StringComparison.Ordinal);

        // --- the side effect actually happened -----------------------------------------------
        // Written at most hourly, so a fresh key transitions null → set on its first use. This is
        // the assertion GuestActivityMiddleware never had.
        var mine = listed.EnumerateArray().First(k => k.GetProperty("id").GetString() == keyId);
        var lastUsed = mine.GetProperty("lastUsedAt");
        Assert.True(
            lastUsed.ValueKind != JsonValueKind.Null,
            "lastUsedAt is still null after the key authenticated a request — the stamp is not being written");

        // --- revoke, and it stops dead --------------------------------------------------------
        var revokeReq = _fixture.CreateRequest(HttpMethod.Delete, $"/me/mcp/keys/{keyId}");
        revokeReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {owner}");
        var revokeResp = await _fixture.Client.SendAsync(revokeReq, ct);
        Assert.Equal(HttpStatusCode.NoContent, revokeResp.StatusCode);

        var afterReq = _fixture.CreateRequest(HttpMethod.Get, "/me/mcp/keys");
        afterReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {rawKey}");
        var afterResp = await _fixture.Client.SendAsync(afterReq, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, afterResp.StatusCode);
    }

    [Fact]
    public async Task ConnectKey_Nonsense_IsUnauthorized_NotAnError()
    {
        var ct = TestContext.Current.CancellationToken;

        // Shaped like a key so the middleware takes the lookup branch, but matching no row. It must
        // fall through unauthenticated and let the endpoint answer in its own shape — middleware
        // that short-circuits here would give MCP a different failure envelope than every other
        // caller of the same API.
        var req = _fixture.CreateRequest(HttpMethod.Get, "/me/mcp/keys");
        req.Headers.TryAddWithoutValidation("Authorization", "Bearer tsk_nosuchkeyatall_0000000000000000000");

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "/me/mcp/keys unavailable");
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task ConnectKey_AnotherAccountsKey_CannotBeRevoked()
    {
        var ct = TestContext.Current.CancellationToken;

        var mine = await SignUpAsync(ct);
        var theirs = await SignUpAsync(ct);
        Assert.SkipWhen(mine is null || theirs is null, "registration unavailable");

        var createReq = _fixture.CreateRequest(HttpMethod.Post, "/me/mcp/keys");
        createReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {mine}");
        createReq.Content = JsonContent.Create(new { name = "Mine" });
        var createResp = await _fixture.Client.SendAsync(createReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(createResp), "/me/mcp/keys unavailable");

        var keyId = (await createResp.Content.ReadFromJsonAsync<JsonElement>(ct))
            .GetProperty("id").GetString();

        var revokeReq = _fixture.CreateRequest(HttpMethod.Delete, $"/me/mcp/keys/{keyId}");
        revokeReq.Headers.TryAddWithoutValidation("Authorization", $"Bearer {theirs}");
        var revokeResp = await _fixture.Client.SendAsync(revokeReq, ct);

        // 404 rather than 403 on purpose: another account's key is not a key you are forbidden to
        // revoke, it is a key that does not exist as far as you are concerned.
        Assert.Equal(HttpStatusCode.NotFound, revokeResp.StatusCode);
    }

    private async Task<JsonElement> ListKeysAsync(string bearer, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Get, "/me/mcp/keys");
        req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearer}");

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        return body.GetProperty("items");
    }

    /// <summary>
    /// A fresh account per test — connect keys are per-user and revocation is permanent.
    /// <para>
    /// <c>X-Client: mobile</c> is load-bearing: without it <c>/auth/register</c> answers a web client
    /// and puts the token in a Set-Cookie header, returning only <c>{ user, guestMergeSkipped }</c>
    /// in the body. These tests need a bearer to send, not a cookie jar.
    /// </para>
    /// </summary>
    private async Task<string?> SignUpAsync(CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/register");
        req.Headers.Add("X-Client", "mobile");
        req.Content = JsonContent.Create(new
        {
            email = $"mcp-key-{Guid.NewGuid():N}@textstack.test",
            password = "correct-horse-battery",
            name = "Key Probe",
        });

        var resp = await _fixture.Client.SendAsync(req, ct);
        if (IntegrationSkip.Unavailable(resp) || !resp.IsSuccessStatusCode) return null;

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        return body.GetProperty("accessToken").GetString();
    }
}
