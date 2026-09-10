using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Mcp.Auth;

namespace TextStack.UnitTests;

/// <summary>
/// AI-050b — the CLI-side device-flow token provider + token cache.
///
/// Verifies (all against a fake HttpMessageHandler, no network, temp-dir cache):
///   • first call (no creds) returns Pending IMMEDIATELY without blocking on the poll;
///   • the background poll honors authorization_pending then caches on 200 →
///     a later GetTokenAsync returns Authorized;
///   • a cached-but-expired access token + valid refresh → body-based refresh →
///     Authorized (asserting the refresh request shape);
///   • refresh 401 → falls through to a fresh device flow (Pending);
///   • local JWT exp decode: future → not expired, past/garbage → expired;
///   • TokenCache round-trips and writes 0600 on Unix; world-readable file ignored.
///
/// Introduces NO ITool (the tool-set assertions in StarterToolsTests stay green).
/// </summary>
public class McpDeviceFlowTests
{
    private const string SiteHost = "textstack.test";

    // A scripted handler: returns queued responses in order, repeating the last.
    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _steps;
        public List<HttpRequestMessage> Requests { get; } = [];
        public List<string?> Bodies { get; } = [];
        private Func<HttpRequestMessage, HttpResponseMessage>? _last;

        public ScriptedHandler(IEnumerable<Func<HttpRequestMessage, HttpResponseMessage>> steps)
            => _steps = new(steps);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);
            Bodies.Add(request.Content is null ? null : await request.Content.ReadAsStringAsync(ct));

            var step = _steps.Count > 0 ? _steps.Dequeue() : _last;
            _last = step;
            return step!(request);
        }
    }

    // A thread-safe handler that records every request path (for concurrency
    // probes) and answers by path: device/code → one device code, device/token →
    // a configurable outcome. Unlike ScriptedHandler it has no shared mutable
    // Queue, so it is safe under truly-parallel callers.
    private sealed class PathHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _tokenResponse;
        private int _deviceCodeCount;
        private int _tokenCount;
        public int DeviceCodeCount => Volatile.Read(ref _deviceCodeCount);
        public int TokenCount => Volatile.Read(ref _tokenCount);

        public PathHandler(Func<HttpRequestMessage, HttpResponseMessage> tokenResponse)
            => _tokenResponse = tokenResponse;

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/auth/device/code")
            {
                Interlocked.Increment(ref _deviceCodeCount);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """{"device_code":"DC","user_code":"UC","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC","expires_in":600,"interval":1}""",
                        Encoding.UTF8, "application/json"),
                });
            }
            Interlocked.Increment(ref _tokenCount);
            return Task.FromResult(_tokenResponse(request));
        }
    }

    private static Func<HttpRequestMessage, HttpResponseMessage> Resp(HttpStatusCode status, string json) =>
        _ => new HttpResponseMessage(status)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };

    private static DeviceFlowTokenProvider Build(ScriptedHandler handler, TokenCache cache)
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        http.DefaultRequestHeaders.Host = SiteHost;
        return new DeviceFlowTokenProvider(
            http, cache, NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));
    }

    private static TokenCache TempCache() =>
        new(Path.Combine(Path.GetTempPath(), "ts-mcp-" + Guid.NewGuid().ToString("N") + ".json"));

    // Hand-crafted UNSIGNED JWT: header.payload.sig with a base64url exp claim.
    private static string Jwt(long expUnix)
    {
        static string B64Url(string s) =>
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

        var header = B64Url("""{"alg":"none","typ":"JWT"}""");
        var payload = B64Url($$"""{"sub":"u1","exp":{{expUnix}}}""");
        return $"{header}.{payload}.sig";
    }

    private static long FutureExp => DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
    private static long PastExp => DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeSeconds();

    // ── 1. first call → Pending immediately, no block on the poll ─────────────────

    [Fact]
    public async Task GetTokenAsync_NoCache_ReturnsPendingImmediately_WithoutBlocking()
    {
        var handler = new ScriptedHandler(
        [
            // /auth/device/code
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC","user_code":"WDJB-MQXR","verification_uri":"https://textstack.app/device","verification_uri_complete":"https://textstack.app/device?code=WDJB-MQXR","expires_in":600,"interval":1}"""),
            // /auth/device/token (poll) — keep pending forever
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
        ]);
        var provider = Build(handler, TempCache());

        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = await provider.GetTokenAsync(CancellationToken.None);
        sw.Stop();

        var pending = Assert.IsType<TokenResult.Pending>(result);
        Assert.Equal("https://textstack.app/device", pending.VerificationUri);
        Assert.Equal("WDJB-MQXR", pending.UserCode);
        // Returned promptly — did not wait on the (1s+) poll interval.
        Assert.True(sw.ElapsedMilliseconds < 800, $"GetTokenAsync blocked for {sw.ElapsedMilliseconds}ms");
    }

    // ── 2. background poll: pending ×2 then 200 → later call Authorized ───────────

    [Fact]
    public async Task BackgroundPoll_PendingThenApproved_LaterCallReturnsAuthorized()
    {
        var access = Jwt(FutureExp);
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC","user_code":"UC","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC","expires_in":600,"interval":1}"""),
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
            Resp(HttpStatusCode.OK,
                $$"""{"access_token":"{{access}}","refresh_token":"RT","token_type":"Bearer"}"""),
        ]);
        var provider = Build(handler, TempCache());

        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.IsType<TokenResult.Pending>(first);

        await provider.WaitForBackgroundPollAsync();

        var second = await provider.GetTokenAsync(CancellationToken.None);
        var authorized = Assert.IsType<TokenResult.Authorized>(second);
        Assert.Equal(access, authorized.AccessToken);

        // device/code + 3 polls = 4 requests.
        Assert.Equal("/auth/device/code", handler.Requests[0].RequestUri!.AbsolutePath);
        Assert.Equal("/auth/device/token", handler.Requests[1].RequestUri!.AbsolutePath);
    }

    // ── 3. expired access + valid refresh → body-based refresh → Authorized ───────

    [Fact]
    public async Task GetTokenAsync_ExpiredAccess_ValidRefresh_RefreshesAndAuthorizes()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(Jwt(PastExp), "REFRESH-ME", DateTimeOffset.UtcNow.AddHours(-1)));

        var newAccess = Jwt(FutureExp);
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK, $$"""{"accessToken":"{{newAccess}}","refreshToken":"NEW-RT"}"""),
        ]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        var authorized = Assert.IsType<TokenResult.Authorized>(result);
        Assert.Equal(newAccess, authorized.AccessToken);

        // Hit the body-based mobile refresh with the cached refresh token.
        Assert.Equal("/auth/refresh-mobile", handler.Requests[0].RequestUri!.AbsolutePath);
        var sent = JsonDocument.Parse(handler.Bodies[0]!).RootElement;
        Assert.Equal("REFRESH-ME", sent.GetProperty("refreshToken").GetString());

        File.Delete(cache.Path);
    }

    // ── 4. refresh 401 → falls through to a fresh device flow (Pending) ───────────

    [Fact]
    public async Task GetTokenAsync_RefreshRejected_FallsThroughToDeviceFlow()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(Jwt(PastExp), "STALE-RT", DateTimeOffset.UtcNow.AddHours(-1)));

        var handler = new ScriptedHandler(
        [
            // refresh-mobile → 401
            Resp(HttpStatusCode.Unauthorized, ""),
            // device/code
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC","user_code":"UC2","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC2","expires_in":600,"interval":1}"""),
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
        ]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        var pending = Assert.IsType<TokenResult.Pending>(result);
        Assert.Equal("UC2", pending.UserCode);
        Assert.Equal("/auth/refresh-mobile", handler.Requests[0].RequestUri!.AbsolutePath);
        Assert.Equal("/auth/device/code", handler.Requests[1].RequestUri!.AbsolutePath);

        File.Delete(cache.Path);
    }

    // ── 5. local JWT exp decode ───────────────────────────────────────────────────

    [Fact]
    public void ReadExp_FutureExp_ParsesToFutureInstant()
    {
        var exp = DeviceFlowTokenProvider.ReadExp(Jwt(FutureExp));
        Assert.NotNull(exp);
        Assert.True(exp!.Value > DateTimeOffset.UtcNow);
    }

    [Fact]
    public void ReadExp_PastExp_ParsesToPastInstant()
    {
        var exp = DeviceFlowTokenProvider.ReadExp(Jwt(PastExp));
        Assert.NotNull(exp);
        Assert.True(exp!.Value < DateTimeOffset.UtcNow);
    }

    [Theory]
    [InlineData("not-a-jwt")]
    [InlineData("only.two")]
    [InlineData("aaa.!!!notbase64!!!.ccc")]
    [InlineData("")]
    public void ReadExp_Garbage_ReturnsNull_TreatedExpired(string jwt)
    {
        Assert.Null(DeviceFlowTokenProvider.ReadExp(jwt));
    }

    [Fact]
    public void ReadExp_NoExpClaim_ReturnsNull()
    {
        static string B64Url(string s) =>
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var jwt = $"{B64Url("{}")}.{B64Url("""{"sub":"u1"}""")}.sig";

        Assert.Null(DeviceFlowTokenProvider.ReadExp(jwt));
    }

    [Fact]
    public async Task GetTokenAsync_CachedUnexpiredAccess_ReturnsAuthorized_NoHttp()
    {
        var cache = TempCache();
        var access = Jwt(FutureExp);
        cache.Write(new CachedTokens(access, "RT", DateTimeOffset.UtcNow.AddHours(1)));

        var handler = new ScriptedHandler([Resp(HttpStatusCode.InternalServerError, "")]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        var authorized = Assert.IsType<TokenResult.Authorized>(result);
        Assert.Equal(access, authorized.AccessToken);
        Assert.Empty(handler.Requests); // never touched the network

        File.Delete(cache.Path);
    }

    // ── 6. TokenCache round-trip + perms ──────────────────────────────────────────

    [Fact]
    public void TokenCache_WriteThenRead_RoundTrips()
    {
        var cache = TempCache();
        var tokens = new CachedTokens("AT", "RT", DateTimeOffset.UnixEpoch.AddSeconds(1_700_000_000));

        cache.Write(tokens);
        var read = cache.Read();

        Assert.NotNull(read);
        Assert.Equal("AT", read!.AccessToken);
        Assert.Equal("RT", read.RefreshToken);
        Assert.Equal(tokens.AccessExpiresAt, read.AccessExpiresAt);

        File.Delete(cache.Path);
    }

    [Fact]
    public void TokenCache_Write_SetsOwnerOnlyMode_OnUnix()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens("AT", "RT", DateTimeOffset.UtcNow));

        if (!OperatingSystem.IsWindows())
        {
            var mode = File.GetUnixFileMode(cache.Path);
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, mode);
        }

        File.Delete(cache.Path);
    }

    [Fact]
    public void TokenCache_Read_MissingFile_ReturnsNull()
    {
        var cache = TempCache();
        Assert.Null(cache.Read());
    }

    [Fact]
    public void TokenCache_Read_WorldReadableFile_IsIgnored_OnUnix()
    {
        if (OperatingSystem.IsWindows())
            return; // perms model differs; covered by the owner-only test on Unix

        var cache = TempCache();
        cache.Write(new CachedTokens("AT", "RT", DateTimeOffset.UtcNow));
        // Loosen perms to simulate a leaked secret.
        File.SetUnixFileMode(cache.Path,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.OtherRead);

        // Treated as no cache (refuse a world-readable secret).
        Assert.Null(cache.Read());

        File.Delete(cache.Path);
    }

    [Fact]
    public void TokenCache_ResolvePath_PrefersExplicitOverride()
    {
        Assert.Equal("/tmp/custom.json", TokenCache.ResolvePath("/tmp/custom.json"));
    }

    [Fact]
    public void TokenCache_Read_WorldWritableFile_IsIgnored_OnUnix()
    {
        if (OperatingSystem.IsWindows())
            return;

        var cache = TempCache();
        cache.Write(new CachedTokens("AT", "RT", DateTimeOffset.UtcNow));
        // Group-writable is just as dangerous as world-readable — refuse it too.
        File.SetUnixFileMode(cache.Path,
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupWrite);

        Assert.Null(cache.Read());

        File.Delete(cache.Path);
    }

    // ── concurrency / single-flight ───────────────────────────────────────────────

    // Many tool calls arrive at once with no creds. EXACTLY one device flow must
    // start (one /auth/device/code, one background poller). The single-flight slot
    // for the device-code POST is now claimed UNDER the lock BEFORE the network call,
    // so concurrent first-callers share ONE request and all return the SAME Pending.
    [Fact]
    public async Task GetTokenAsync_ConcurrentFirstCallers_StartExactlyOneDeviceFlow()
    {
        var handler = new PathHandler(
            _ => new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    """{"error":"authorization_pending"}""", Encoding.UTF8, "application/json"),
            });
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var provider = new DeviceFlowTokenProvider(
            http, TempCache(), NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));

        // Fire 20 callers as parallel as the thread pool allows.
        var tasks = Enumerable.Range(0, 20)
            .Select(_ => Task.Run(() => provider.GetTokenAsync(CancellationToken.None)))
            .ToArray();
        var results = await Task.WhenAll(tasks);

        // All callers see Pending with the SAME, non-empty user code (one flow).
        Assert.All(results, r => Assert.IsType<TokenResult.Pending>(r));
        var codes = results.Cast<TokenResult.Pending>().Select(p => p.UserCode).Distinct().ToList();
        Assert.Single(codes);
        Assert.False(string.IsNullOrEmpty(codes[0]));

        // The invariant under test: exactly ONE device flow was started.
        Assert.Equal(1, handler.DeviceCodeCount);
    }

    // A handler whose /auth/device/code POST blocks on a gate before responding, so a
    // test can land a SECOND caller while the first POST is mid-flight and prove they
    // share the one request. /auth/device/token always answers authorization_pending.
    private sealed class GatedDeviceCodeHandler : HttpMessageHandler
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _deviceCodeCount;
        public int DeviceCodeCount => Volatile.Read(ref _deviceCodeCount);
        public Task Entered => _entered.Task;
        public void Release() => _release.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath == "/auth/device/code")
            {
                Interlocked.Increment(ref _deviceCodeCount);
                _entered.TrySetResult();
                await _release.Task; // block until the test lets the POST complete
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """{"device_code":"DC","user_code":"GATED-UC","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=GATED-UC","expires_in":600,"interval":1}""",
                        Encoding.UTF8, "application/json"),
                };
            }
            return new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    """{"error":"authorization_pending"}""", Encoding.UTF8, "application/json"),
            };
        }
    }

    // A caller arriving WHILE the device-code POST is still in flight joins the same
    // single-flight request: it gets the real user_code (not a half-state) and only
    // ONE /auth/device/code is ever issued.
    [Fact]
    public async Task GetTokenAsync_SecondCallerDuringInFlightPost_SharesOneRequest()
    {
        var handler = new GatedDeviceCodeHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var provider = new DeviceFlowTokenProvider(
            http, TempCache(), NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));

        // First caller starts the POST and blocks inside the handler.
        var first = Task.Run(() => provider.GetTokenAsync(CancellationToken.None));
        await handler.Entered; // POST is now in flight

        // Second caller arrives mid-flight — must join, not start a new POST.
        var second = Task.Run(() => provider.GetTokenAsync(CancellationToken.None));

        handler.Release(); // let the shared POST complete
        var r1 = Assert.IsType<TokenResult.Pending>(await first);
        var r2 = Assert.IsType<TokenResult.Pending>(await second);

        Assert.Equal("GATED-UC", r1.UserCode);
        Assert.Equal("GATED-UC", r2.UserCode);
        Assert.Equal(1, handler.DeviceCodeCount);
    }

    // A handler whose /auth/device/code POST FAILS the first time (500) then succeeds,
    // to prove the single-flight slot is cleared on failure and the next call retries.
    private sealed class FlakyDeviceCodeHandler : HttpMessageHandler
    {
        private int _deviceCodeCount;
        public int DeviceCodeCount => Volatile.Read(ref _deviceCodeCount);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath == "/auth/device/code")
            {
                var n = Interlocked.Increment(ref _deviceCodeCount);
                if (n == 1)
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError));
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """{"device_code":"DC","user_code":"RETRY-UC","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=RETRY-UC","expires_in":600,"interval":1}""",
                        Encoding.UTF8, "application/json"),
                });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    """{"error":"authorization_pending"}""", Encoding.UTF8, "application/json"),
            });
        }
    }

    // A failed device-code POST must clear the single-flight slot so a SUBSEQUENT
    // GetTokenAsync re-initiates (issues a new /auth/device/code) instead of wedging
    // on the faulted task.
    [Fact]
    public async Task GetTokenAsync_DeviceCodePostFails_ClearsSlot_LaterCallRetries()
    {
        var handler = new FlakyDeviceCodeHandler();
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var provider = new DeviceFlowTokenProvider(
            http, TempCache(), NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));

        // First call: POST 500 → Failed (slot cleared).
        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.IsType<TokenResult.Failed>(first);

        // Second call: not wedged — re-initiates and gets a real Pending code.
        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("RETRY-UC", Assert.IsType<TokenResult.Pending>(second).UserCode);
        Assert.Equal(2, handler.DeviceCodeCount);
    }

    // ── lifecycle: terminal error clears in-flight so a later call re-initiates ────

    [Fact]
    public async Task BackgroundPoll_AccessDenied_ClearsInFlight_LaterCallReinitiates()
    {
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC","user_code":"UC1","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC1","expires_in":600,"interval":1}"""),
            // poll → access_denied (terminal)
            Resp(HttpStatusCode.BadRequest, """{"error":"access_denied"}"""),
            // a SECOND device/code for the later, re-initiated flow
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC2","user_code":"UC2","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC2","expires_in":600,"interval":1}"""),
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
        ]);
        var provider = Build(handler, TempCache());

        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("UC1", Assert.IsType<TokenResult.Pending>(first).UserCode);

        // Wait for the poll to hit access_denied and clear in-flight.
        await provider.WaitForBackgroundPollAsync();

        // A later call must NOT be wedged on the dead flow — it re-initiates.
        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("UC2", Assert.IsType<TokenResult.Pending>(second).UserCode);
    }

    // ── expired_token is terminal → in-flight cleared → later call re-initiates ───

    [Fact]
    public async Task BackgroundPoll_ExpiredToken_ClearsInFlight_LaterCallReinitiates()
    {
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC","user_code":"UC1","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC1","expires_in":600,"interval":1}"""),
            // poll → expired_token (terminal)
            Resp(HttpStatusCode.BadRequest, """{"error":"expired_token"}"""),
            // second device/code for the re-initiated flow
            Resp(HttpStatusCode.OK,
                """{"device_code":"DC2","user_code":"UC2","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code=UC2","expires_in":600,"interval":1}"""),
            Resp(HttpStatusCode.BadRequest, """{"error":"authorization_pending"}"""),
        ]);
        var provider = Build(handler, TempCache());

        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.IsType<TokenResult.Pending>(first);
        await provider.WaitForBackgroundPollAsync();

        // expired_token is terminal → in-flight cleared → re-initiate (new code).
        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("UC2", Assert.IsType<TokenResult.Pending>(second).UserCode);
    }

    // ── refresh rotation: the NEW refresh token is cached ─────────────────────────

    [Fact]
    public async Task GetTokenAsync_Refresh_PersistsRotatedRefreshToken()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(Jwt(PastExp), "OLD-RT", DateTimeOffset.UtcNow.AddHours(-1)));

        var newAccess = Jwt(FutureExp);
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK, $$"""{"accessToken":"{{newAccess}}","refreshToken":"ROTATED-RT"}"""),
        ]);
        var provider = Build(handler, cache);

        await provider.GetTokenAsync(CancellationToken.None);

        // The rotated refresh token must be persisted (not the stale one).
        var persisted = cache.Read();
        Assert.NotNull(persisted);
        Assert.Equal("ROTATED-RT", persisted!.RefreshToken);
        Assert.Equal(newAccess, persisted.AccessToken);

        File.Delete(cache.Path);
    }

    // ── refresh response without a new refresh token keeps the old one ────────────

    [Fact]
    public async Task GetTokenAsync_Refresh_NoNewRefreshToken_KeepsOld()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(Jwt(PastExp), "KEEP-RT", DateTimeOffset.UtcNow.AddHours(-1)));

        var newAccess = Jwt(FutureExp);
        var handler = new ScriptedHandler(
        [
            // Server omits refreshToken on refresh — provider must keep the old one.
            Resp(HttpStatusCode.OK, $$"""{"accessToken":"{{newAccess}}"}"""),
        ]);
        var provider = Build(handler, cache);

        await provider.GetTokenAsync(CancellationToken.None);

        var persisted = cache.Read();
        Assert.NotNull(persisted);
        Assert.Equal("KEEP-RT", persisted!.RefreshToken);

        File.Delete(cache.Path);
    }

    // ── cancellation propagates (not swallowed into Pending/Failed) ───────────────

    [Fact]
    public async Task GetTokenAsync_CallerCancelled_DuringRefresh_Propagates()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(Jwt(PastExp), "RT", DateTimeOffset.UtcNow.AddHours(-1)));

        using var cts = new CancellationTokenSource();
        // Handler that observes cancellation and throws OCE bound to the token.
        var handler = new CancelObservingHandler(cts);
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        var provider = new DeviceFlowTokenProvider(
            http, cache, NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => provider.GetTokenAsync(cts.Token));

        File.Delete(cache.Path);
    }

    private sealed class CancelObservingHandler(CancellationTokenSource cts) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            cts.Cancel();
            ct.ThrowIfCancellationRequested();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    // ── base64url payload without '=' padding decodes (exp still read) ────────────

    [Fact]
    public void ReadExp_Base64UrlPayloadNoPadding_DecodesExp()
    {
        // Build a payload whose base64url length forces a non-zero %4 remainder
        // (no '=' padding present) to exercise Base64UrlDecode's padding logic.
        var exp = DeviceFlowTokenProvider.ReadExp(Jwt(FutureExp));
        Assert.NotNull(exp);
    }

    [Fact]
    public void ReadExp_ExpAsNumericString_Parses()
    {
        static string B64Url(string s) =>
            Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var future = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds();
        var jwt = $"{B64Url("{}")}.{B64Url($$"""{"exp":"{{future}}"}""")}.sig";

        var exp = DeviceFlowTokenProvider.ReadExp(jwt);
        Assert.NotNull(exp);
    }
}
