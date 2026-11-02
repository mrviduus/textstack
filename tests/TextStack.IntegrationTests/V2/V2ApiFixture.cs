using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TextStack.IntegrationTests.V2;

/// <summary>A session cookie of one test user or guest.</summary>
public sealed record V2Session(string Cookie);

/// <summary>An answer: status code and JSON body (Undefined when there is none).</summary>
public sealed record V2Response(HttpStatusCode Status, JsonElement Body)
{
    public string? Code => Body.ValueKind == JsonValueKind.Object && Body.TryGetProperty("code", out var c) ? c.GetString() : null;
}

/// <summary>
/// <see cref="LiveApiFixture"/>'s V2 mode: the running stack with <c>textstack_v2</c> migrated
/// (<c>make migrate-v2</c>) and <c>Features__V2Api=true</c> on the api. Opt-in by
/// <c>V2_API_TESTS=1</c>; set, a stack whose <c>/me/v2</c> is not mapped fails every test instead of
/// skipping it, so a run that meant to cover V2 cannot go green without it. Two test users
/// (test-login, <c>ENABLE_TEST_AUTH</c>) for owner isolation, and fresh guests where a test needs an
/// empty library.
/// </summary>
public sealed class V2ApiFixture : IAsyncLifetime
{
    private readonly HttpClient _client = new(new HttpClientHandler { UseCookies = false })
    {
        BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080"),
        Timeout = TimeSpan.FromSeconds(30),
    };

    private bool _enabled;
    private string? _failure;

    public V2Session Alice { get; private set; } = null!;
    public V2Session Bob { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        _enabled = Environment.GetEnvironmentVariable("V2_API_TESTS") == "1";
        if (!_enabled) return;
        try
        {
            (Alice, Bob) = await Users.Value;
            var status = await SendAsync(Alice, HttpMethod.Get, "/me/v2/status");
            if (status.Status != HttpStatusCode.OK)
                _failure = $"V2_API_TESTS=1 but GET /me/v2/status answered {(int)status.Status}: run `make migrate-v2` and recreate the api with Features__V2Api=true";
        }
        catch (Exception e) when (e is HttpRequestException or InvalidOperationException)
        {
            _failure = $"V2 fixture setup failed: {e.Message}";
        }
    }

    /// <summary>Skips without <c>V2_API_TESTS=1</c>; fails when it is set and V2 is not there.</summary>
    public void Require()
    {
        Assert.SkipUnless(_enabled, "V2 API tests are opt-in: set V2_API_TESTS=1 against a stack with Features__V2Api=true and `make migrate-v2` run");
        if (_failure is not null) Assert.Fail(_failure);
    }

    // One login per user per run, shared by every class: concurrent first test-logins of one email
    // race on ix_users_email in the legacy database and answer 500.
    private static readonly Lazy<Task<(V2Session, V2Session)>> Users = new(async () =>
    {
        using var client = new HttpClient(new HttpClientHandler { UseCookies = false }) { BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080") };
        return (await LoginAsync(client, "v2-alice@textstack.app"), await LoginAsync(client, "v2-bob@textstack.app"));
    });

    private static async Task<V2Session> LoginAsync(HttpClient client, string email)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/test-login") { Content = JsonContent.Create(new { email }) };
        request.Headers.Host = LiveApiFixture.TestHost;
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"test-login answered {(int)response.StatusCode} (ENABLE_TEST_AUTH=true?)");
        return new V2Session(Cookie(response));
    }

    /// <summary>A fresh guest: an empty library, so a feed holds exactly what the test wrote.</summary>
    public async Task<V2Session> NewGuestAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/auth/guest");
        request.Headers.Host = LiveApiFixture.TestHost;
        using var response = await _client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(response.StatusCode == HttpStatusCode.TooManyRequests,
            "guest-session rate limit hit: raise GUEST_SESSION_PERMIT_LIMIT on the api (CLAUDE.md)");
        response.EnsureSuccessStatusCode();
        return new V2Session(Cookie(response));
    }

    // "access_token=xxx; path=/; ..." → "access_token=xxx", joined into one Cookie header.
    private static string Cookie(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Set-Cookie", out var cookies)
            ? string.Join("; ", cookies.Select(c => c.Split(';')[0].Trim()).Where(c => c.Length > 0))
            : throw new InvalidOperationException("no session cookie");

    public async Task<V2Response> SendAsync(V2Session who, HttpMethod method, string path, object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Host = LiveApiFixture.TestHost;
        request.Headers.Add("Cookie", who.Cookie);
        if (body is not null) request.Content = JsonContent.Create(body);
        using var response = await _client.SendAsync(request, TestContext.Current.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        return new V2Response(response.StatusCode, text.Length == 0 ? default : JsonSerializer.Deserialize<JsonElement>(text));
    }

    public static string NewSha256() => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString())));

    public static object File(Guid id, string? sha256 = null) =>
        new { id, sha256 = sha256 ?? NewSha256(), byteSize = 1024, originalName = "book.epub", format = "epub" };

    /// <summary>Imports a new book with one file; returns its ids.</summary>
    public async Task<(Guid Book, Guid File, string Sha256)> ImportAsync(V2Session who)
    {
        var (bookId, fileId, sha256) = (Guid.NewGuid(), Guid.NewGuid(), NewSha256());
        var created = await SendAsync(who, HttpMethod.Put, $"/me/v2/books/{bookId}", new { title = "A V2 book", file = File(fileId, sha256) });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        return (bookId, fileId, sha256);
    }

    /// <summary>An epub-cfi position with the quote the PDD requires.</summary>
    public static object Position(int step) =>
        new { version = 1, scheme = "epub-cfi", value = $"epubcfi(/6/{2 * step}!/4/2/1:0)", quote = $"Chapter {step} begins" };

    public static object State(Guid fileId, long? expectedRevision, int step = 1) => new
    {
        expectedRevision,
        fileId,
        currentLocator = Position(step),
        bookFraction = step / 10m,
        clientRecordedAt = DateTimeOffset.UtcNow,
    };

    public ValueTask DisposeAsync()
    {
        _client.Dispose();
        return ValueTask.CompletedTask;
    }
}
