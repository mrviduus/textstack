using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace TextStack.IntegrationTests;

/// <summary>
/// Integration tests for the OAuth 2.0 Device Authorization Grant (RFC 8628, AI-050a).
/// Requires: docker compose up (API at localhost:8080), ENABLE_TEST_AUTH=true.
///
/// The DB-poking tests (expired seed, hashed-storage assertion) need a host-reachable
/// Postgres via TEST_DB_CONNECTION; they SKIP when it's unset so the HTTP-only suite
/// still runs anywhere.
/// </summary>
public class DeviceAuthEndpointTests : IClassFixture<AuthenticatedApiFixture>
{
    private const string GrantType = "urn:ietf:params:oauth:grant-type:device_code";

    private readonly AuthenticatedApiFixture _fixture;

    public DeviceAuthEndpointTests(AuthenticatedApiFixture fixture)
    {
        _fixture = fixture;
    }

    private async Task<JsonElement> RequestCodeAsync(CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/code");
        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "device/code endpoint unavailable");
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    private async Task<HttpResponseMessage> PollAsync(string deviceCode, CancellationToken ct)
    {
        var req = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/token");
        req.Content = JsonContent.Create(new { grant_type = GrantType, device_code = deviceCode });
        return await _fixture.Client.SendAsync(req, ct);
    }

    [Fact]
    public async Task RequestDeviceCode_ReturnsRfcFields()
    {
        var ct = TestContext.Current.CancellationToken;
        var body = await RequestCodeAsync(ct);

        // RFC 8628 §3.2 snake_case fields.
        Assert.False(string.IsNullOrEmpty(body.GetProperty("device_code").GetString()));
        var userCode = body.GetProperty("user_code").GetString()!;
        Assert.Matches("^[A-Z2-9]{4}-[A-Z2-9]{4}$", userCode);

        var verificationUri = body.GetProperty("verification_uri").GetString()!;
        Assert.EndsWith("/device", verificationUri);

        var complete = body.GetProperty("verification_uri_complete").GetString()!;
        Assert.Contains("code=", complete);
        Assert.Contains(Uri.EscapeDataString(userCode), complete);

        Assert.Equal(600, body.GetProperty("expires_in").GetInt32());
        Assert.Equal(5, body.GetProperty("interval").GetInt32());
    }

    [Fact]
    public async Task PollToken_BeforeApproval_ReturnsAuthorizationPending()
    {
        var ct = TestContext.Current.CancellationToken;
        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;

        var resp = await PollAsync(deviceCode, ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("authorization_pending", err.GetProperty("error").GetString());
    }

    [Fact]
    public async Task Approve_RequiresAuth_401WhenAnonymous()
    {
        var ct = TestContext.Current.CancellationToken;

        // Anonymous request (no Cookie header).
        var req = new HttpRequestMessage(HttpMethod.Post, "/auth/device/approve");
        req.Headers.Host = AuthenticatedApiFixture.TestHost;
        req.Content = JsonContent.Create(new { user_code = "WDJB-MQXR" });

        var resp = await _fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "device/approve endpoint unavailable");

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    // #1119: a still-valid access token whose account was deleted names nobody — 401, not the FK's 500.
    [Fact]
    public async Task Approve_TokenOfADeletedAccount_Returns401()
    {
        var ct = TestContext.Current.CancellationToken;

        var register = Bare(HttpMethod.Post, "/auth/register", null);
        register.Headers.Add("X-Client", "mobile");
        register.Content = JsonContent.Create(new { email = $"device-gone-{Guid.NewGuid():N}@textstack.test", password = "correct-horse-battery", name = "Gone" });
        var registered = await _fixture.Client.SendAsync(register, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(registered) || !registered.IsSuccessStatusCode, "registration unavailable");
        var token = (await registered.Content.ReadFromJsonAsync<JsonElement>(ct)).GetProperty("accessToken").GetString()!;

        var deleted = await _fixture.Client.SendAsync(Bare(HttpMethod.Delete, "/me/account", token), ct);
        Assert.SkipWhen(deleted.StatusCode == HttpStatusCode.TooManyRequests, "account-delete rate limit (ACCOUNT_DELETE_PERMIT_LIMIT)");
        Assert.True(deleted.IsSuccessStatusCode, $"account delete → {(int)deleted.StatusCode}");

        var userCode = (await RequestCodeAsync(ct)).GetProperty("user_code").GetString()!;
        var approve = Bare(HttpMethod.Post, "/auth/device/approve", token);
        approve.Content = JsonContent.Create(new { user_code = userCode });
        var resp = await _fixture.Client.SendAsync(approve, ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    // No fixture cookie: the bearer is the only identity on the request.
    private static HttpRequestMessage Bare(HttpMethod method, string path, string? bearer)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Host = AuthenticatedApiFixture.TestHost;
        if (bearer is not null) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {bearer}");
        return req;
    }

    [Fact]
    public async Task PollToken_AfterApproval_ReturnsAccessAndRefreshToken()
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "test-login unavailable");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        // Authenticated approve.
        var approveReq = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/approve");
        approveReq.Content = JsonContent.Create(new { user_code = userCode });
        var approveResp = await _fixture.Client.SendAsync(approveReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(approveResp), "device/approve unavailable");
        Assert.Equal(HttpStatusCode.OK, approveResp.StatusCode);

        // CLI poll → tokens.
        var resp = await PollAsync(deviceCode, ct);
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var tokens = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.False(string.IsNullOrEmpty(tokens.GetProperty("access_token").GetString()));
        Assert.False(string.IsNullOrEmpty(tokens.GetProperty("refresh_token").GetString()));
        Assert.Equal("Bearer", tokens.GetProperty("token_type").GetString());
        Assert.True(tokens.TryGetProperty("user", out var user));
        Assert.False(string.IsNullOrEmpty(user.GetProperty("email").GetString()));
    }

    [Fact]
    public async Task Approve_BindsUserId_AndSingleUse()
    {
        Assert.SkipUnless(_fixture.IsAuthenticated, "test-login unavailable");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        var approveReq = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/approve");
        approveReq.Content = JsonContent.Create(new { user_code = userCode });
        var approveResp = await _fixture.Client.SendAsync(approveReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(approveResp), "device/approve unavailable");
        Assert.Equal(HttpStatusCode.OK, approveResp.StatusCode);

        // First redeem consumes the code (single-use).
        var first = await PollAsync(deviceCode, ct);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        // Second redeem must NOT re-mint — single-use, now expired_token.
        var second = await PollAsync(deviceCode, ct);
        Assert.Equal(HttpStatusCode.BadRequest, second.StatusCode);
        var err = await second.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("expired_token", err.GetProperty("error").GetString());
    }

    [Fact]
    public async Task PollToken_UnknownDeviceCode_ReturnsExpiredToken()
    {
        var ct = TestContext.Current.CancellationToken;
        // Ensure endpoint reachable first.
        await RequestCodeAsync(ct);

        var resp = await PollAsync("this-is-not-a-real-device-code", ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("expired_token", err.GetProperty("error").GetString());
    }

    // ---- DB-backed tests (need host-reachable Postgres) ----

    private static string? DbConn => Environment.GetEnvironmentVariable("TEST_DB_CONNECTION");

    [Fact]
    public async Task DeviceCode_StoredHashed()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        await using var conn = new NpgsqlConnection(DbConn);
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(
            "SELECT device_code_hash FROM device_authorizations WHERE user_code = @uc", conn);
        cmd.Parameters.AddWithValue("uc", userCode);
        var storedHash = (string?)await cmd.ExecuteScalarAsync(ct);

        Assert.NotNull(storedHash);
        // Persisted value is the hash, never the plaintext device_code.
        Assert.NotEqual(deviceCode, storedHash);
        Assert.Equal(64, storedHash!.Length); // SHA256 hex
    }

    [Fact]
    public async Task Approve_FreshPendingRow_IgnoresStaleSameCodeTerminalRow()
    {
        // P2#1 (AI-050a): the user_code index is FILTERED on status='pending', so the
        // same 8-char code legitimately recurs across history. Approve/deny must scope
        // to the live pending row — a stale terminal row of the same code must be
        // invisible, otherwise FirstOrDefault could return it and wrongly yield
        // AlreadyUsed/Expired for a genuinely-approvable CLI flow.
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        Assert.SkipUnless(_fixture.IsAuthenticated, "test-login unavailable");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        // Seed an OLDER terminal (denied) row sharing the same user_code, created
        // before the live one — ordering by created_at would surface it first.
        await using (var conn = new NpgsqlConnection(DbConn))
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand(
                """
                INSERT INTO device_authorizations
                    (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
                VALUES
                    (@id, @hash, @uc, 'denied', now() - interval '1 hour', 5, now() - interval '2 hour')
                """, conn);
            cmd.Parameters.AddWithValue("id", Guid.NewGuid());
            cmd.Parameters.AddWithValue("hash", new string('a', 64)); // distinct device_code_hash
            cmd.Parameters.AddWithValue("uc", userCode);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        // Approve must bind the LIVE pending row, not the stale denied one.
        var approveReq = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/approve");
        approveReq.Content = JsonContent.Create(new { user_code = userCode });
        var approveResp = await _fixture.Client.SendAsync(approveReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(approveResp), "device/approve unavailable");
        Assert.Equal(HttpStatusCode.OK, approveResp.StatusCode);

        // And the live row's device_code now mints tokens — proving the right row moved.
        var poll = await PollAsync(deviceCode, ct);
        Assert.Equal(HttpStatusCode.OK, poll.StatusCode);
        var tokens = await poll.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.False(string.IsNullOrEmpty(tokens.GetProperty("access_token").GetString()));
    }

    [Fact]
    public async Task Deny_FreshPendingRow_ThenPollReturnsAccessDenied()
    {
        // Companion to the approve scoping test: deny must also hit the live pending
        // row so the CLI poll transitions to access_denied (not authorization_pending).
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        Assert.SkipUnless(_fixture.IsAuthenticated, "test-login unavailable");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        // Older approved-then-consumed (expired) terminal row, same code.
        await using (var conn = new NpgsqlConnection(DbConn))
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand(
                """
                INSERT INTO device_authorizations
                    (id, device_code_hash, user_code, status, expires_at, interval_seconds, created_at)
                VALUES
                    (@id, @hash, @uc, 'expired', now() - interval '1 hour', 5, now() - interval '2 hour')
                """, conn);
            cmd.Parameters.AddWithValue("id", Guid.NewGuid());
            cmd.Parameters.AddWithValue("hash", new string('b', 64));
            cmd.Parameters.AddWithValue("uc", userCode);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        var denyReq = _fixture.CreateRequest(HttpMethod.Post, "/auth/device/deny");
        denyReq.Content = JsonContent.Create(new { user_code = userCode });
        var denyResp = await _fixture.Client.SendAsync(denyReq, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(denyResp), "device/deny unavailable");
        Assert.Equal(HttpStatusCode.OK, denyResp.StatusCode);

        var poll = await PollAsync(deviceCode, ct);
        Assert.Equal(HttpStatusCode.BadRequest, poll.StatusCode);
        var err = await poll.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("access_denied", err.GetProperty("error").GetString());
    }

    [Fact]
    public async Task PollToken_ExpiredCode_ReturnsExpiredToken()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        var ct = TestContext.Current.CancellationToken;

        var body = await RequestCodeAsync(ct);
        var deviceCode = body.GetProperty("device_code").GetString()!;
        var userCode = body.GetProperty("user_code").GetString()!;

        // Force expiry in the past via direct DB update (faster + deterministic vs sleeping 10 min).
        await using (var conn = new NpgsqlConnection(DbConn))
        {
            await conn.OpenAsync(ct);
            await using var cmd = new NpgsqlCommand(
                "UPDATE device_authorizations SET expires_at = now() - interval '1 hour' WHERE user_code = @uc", conn);
            cmd.Parameters.AddWithValue("uc", userCode);
            await cmd.ExecuteNonQueryAsync(ct);
        }

        var resp = await PollAsync(deviceCode, ct);

        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var err = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        Assert.Equal("expired_token", err.GetProperty("error").GetString());
    }
}
