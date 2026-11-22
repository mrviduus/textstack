using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;

namespace TextStack.IntegrationTests;

/// <summary>
/// Refresh tokens are stored hashed and rotate on use; a user access token is not an admin one.
/// Requires: docker compose up (API at localhost:8080), ENABLE_TEST_AUTH=true. The stored-hash
/// assertion also needs TEST_DB_CONNECTION and is skipped without it.
/// </summary>
public class RefreshTokenHardeningTests : IClassFixture<AuthenticatedApiFixture>
{
    private const string Email = "integration-refresh@textstack.app";
    private readonly AuthenticatedApiFixture _fixture;

    public RefreshTokenHardeningTests(AuthenticatedApiFixture fixture) => _fixture = fixture;

    private static string? DbConn => Environment.GetEnvironmentVariable("TEST_DB_CONNECTION");

    private async Task<HttpResponseMessage> PostMobileAsync(string path, object body, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, path);
        req.Headers.Host = AuthenticatedApiFixture.TestHost;
        req.Headers.Add("X-Client", "mobile");
        req.Content = JsonContent.Create(body);
        return await _fixture.Client.SendAsync(req, ct);
    }

    private async Task<(string Access, string Refresh)> SignInAsync(CancellationToken ct)
    {
        var resp = await PostMobileAsync("/auth/test-login", new { email = Email }, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), "test-login unavailable");
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
        return (body.GetProperty("accessToken").GetString()!, body.GetProperty("refreshToken").GetString()!);
    }

    [Fact]
    public async Task RefreshMobile_RotatedToken_OldRefusedNewWorks()
    {
        var ct = TestContext.Current.CancellationToken;
        var (_, first) = await SignInAsync(ct);

        var rotated = await PostMobileAsync("/auth/refresh-mobile", new { refreshToken = first }, ct);
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode);
        var second = (await rotated.Content.ReadFromJsonAsync<JsonElement>(ct))
            .GetProperty("refreshToken").GetString()!;
        Assert.NotEqual(first, second);

        var replay = await PostMobileAsync("/auth/refresh-mobile", new { refreshToken = first }, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);

        // Replayed inside the grace window (a concurrent tab), so the successor is still alive.
        var next = await PostMobileAsync("/auth/refresh-mobile", new { refreshToken = second }, ct);
        Assert.Equal(HttpStatusCode.OK, next.StatusCode);
    }

    [Fact]
    public async Task RefreshToken_Stored_OnlyAsSha256Hex()
    {
        Assert.SkipWhen(DbConn is null, "TEST_DB_CONNECTION not set");
        var ct = TestContext.Current.CancellationToken;
        var (_, refresh) = await SignInAsync(ct);
        var expected = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(refresh)));

        await using var conn = new NpgsqlConnection(DbConn);
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(
            "SELECT count(*) FROM user_refresh_tokens WHERE token_hash = @h OR token_hash = @raw", conn);
        cmd.Parameters.AddWithValue("h", expected);
        cmd.Parameters.AddWithValue("raw", refresh);
        await using var hashCmd = new NpgsqlCommand(
            "SELECT encode(sha256(convert_to(@raw, 'UTF8')), 'hex')", conn);
        hashCmd.Parameters.AddWithValue("raw", refresh);

        Assert.Equal(1L, (long)(await cmd.ExecuteScalarAsync(ct))!);
        // The migration's SQL expression and the C# helper agree on a real token.
        Assert.Equal(expected, (string?)await hashCmd.ExecuteScalarAsync(ct));
    }

    [Fact]
    public async Task AdminMe_UserAccessToken_Unauthorized()
    {
        var ct = TestContext.Current.CancellationToken;
        var (access, _) = await SignInAsync(ct);

        var req = new HttpRequestMessage(HttpMethod.Get, "/admin/auth/me");
        req.Headers.Host = AuthenticatedApiFixture.AdminHost;
        req.Headers.Add("Cookie", $"admin_access_token={access}");
        var resp = await _fixture.Client.SendAsync(req, ct);

        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }
}
