using System.Net;
using System.Net.Http.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// Fixture that authenticates via test-login and maintains cookie-based session.
/// Requires: ENABLE_TEST_AUTH=true in docker compose.
/// Handles Secure cookies over HTTP by manually extracting Set-Cookie values.
/// Admin requests carry a separate admin session (POST /admin/auth/login with ADMIN_EMAIL /
/// ADMIN_PASSWORD, defaults as the admin e2e): admin auth is its own JWT, not the user's (#990).
/// </summary>
public class AuthenticatedApiFixture : IAsyncLifetime
{
    public HttpClient Client { get; private set; } = null!;

    public const string TestHost = "localhost";
    public const string AdminHost = "textstack.dev";
    public const string TestEmail = "integration-test@textstack.app";

    private string _cookieHeader = string.Empty;
    private bool _loginAvailable;

    // One admin login per test run, shared by every fixture: admin-login allows 5 per minute per IP.
    private static readonly Lazy<Task<(string Cookie, string? Error)>> AdminLogin = new(LoginAdminAsync);
    private string _adminCookieHeader = string.Empty;
    private string? _adminLoginError;

    public async ValueTask InitializeAsync()
    {
        var baseUrl = Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080";

        // UseCookies=false: cookies added explicitly via Cookie header. Default
        // jar would duplicate/accumulate Set-Cookie values across requests.
        Client = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = new Uri(baseUrl),
            Timeout = TimeSpan.FromSeconds(30)
        };

        // Authenticate — extract Set-Cookie manually (Secure cookies don't stick over HTTP)
        var loginRequest = new HttpRequestMessage(HttpMethod.Post, "/auth/test-login");
        loginRequest.Headers.Host = TestHost;
        loginRequest.Content = JsonContent.Create(new { email = TestEmail });

        var resp = await Client.SendAsync(loginRequest);
        if (resp.StatusCode == HttpStatusCode.NotFound)
            return; // test-login not enabled

        // Retry once — handles race condition when parallel fixtures create the same test user
        if (!resp.IsSuccessStatusCode)
        {
            await Task.Delay(500);
            loginRequest = new HttpRequestMessage(HttpMethod.Post, "/auth/test-login");
            loginRequest.Headers.Host = TestHost;
            loginRequest.Content = JsonContent.Create(new { email = TestEmail });
            resp = await Client.SendAsync(loginRequest);
        }

        resp.EnsureSuccessStatusCode();
        _loginAvailable = true;
        _cookieHeader = CookieHeader(resp);

        (_adminCookieHeader, _adminLoginError) = await AdminLogin.Value;
    }

    // "access_token=xxx; path=/; ..." → "access_token=xxx", joined into one Cookie header.
    private static string CookieHeader(HttpResponseMessage resp) =>
        resp.Headers.TryGetValues("Set-Cookie", out var cookies)
            ? string.Join("; ", cookies.Select(c => c.Split(';')[0].Trim()).Where(c => c.Length > 0))
            : string.Empty;

    private static async Task<(string Cookie, string? Error)> LoginAdminAsync()
    {
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false })
        {
            BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080"),
            Timeout = TimeSpan.FromSeconds(30)
        };
        var request = new HttpRequestMessage(HttpMethod.Post, "/admin/auth/login")
        {
            Content = JsonContent.Create(new
            {
                email = Environment.GetEnvironmentVariable("ADMIN_EMAIL") ?? "admin@textstack.app",
                password = Environment.GetEnvironmentVariable("ADMIN_PASSWORD") ?? "admin",
            })
        };
        request.Headers.Host = AdminHost;
        var resp = await client.SendAsync(request);
        return resp.IsSuccessStatusCode
            ? (CookieHeader(resp), null)
            : (string.Empty, $"admin login answered {(int)resp.StatusCode}");
    }

    public HttpRequestMessage CreateRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Host = TestHost;
        if (!string.IsNullOrEmpty(_cookieHeader))
            request.Headers.Add("Cookie", _cookieHeader);
        return request;
    }

    public HttpRequestMessage CreateAdminRequest(HttpMethod method, string path)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Host = AdminHost;
        if (!string.IsNullOrEmpty(_adminCookieHeader))
            request.Headers.Add("Cookie", _adminCookieHeader);
        return request;
    }

    public bool IsAuthenticated => _loginAvailable;

    /// <summary>
    /// Skips the test locally when there is no admin session; fails it in CI, which creates the
    /// admin before this suite — there a skip would be a green run with the admin endpoints untested.
    /// </summary>
    public void RequireAdmin()
    {
        if (_adminCookieHeader.Length > 0) return;
        var reason = _adminLoginError ?? "test login unavailable";
        if (Environment.GetEnvironmentVariable("CI") == "true") Assert.Fail($"no admin session in CI: {reason}");
        Assert.Skip($"no admin session: {reason}");
    }

    public ValueTask DisposeAsync()
    {
        Client?.Dispose();
        return ValueTask.CompletedTask;
    }
}
