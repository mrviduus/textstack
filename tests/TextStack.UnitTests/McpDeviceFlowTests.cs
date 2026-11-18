using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Mcp.Auth;
using TextStack.UnitTests.Fakes;

namespace TextStack.UnitTests;

/// <summary>
/// The MCP stdio host signs the assistant in with a device code (AI-050b): the first
/// call answers at once with a code to approve, a background poll caches the token
/// once the reader approves, the cached token is refreshed before it expires, and a
/// revoked refresh token starts a new sign-in. The token file is owner-only.
/// All against fake HTTP handlers and a temp-dir cache; no network.
/// </summary>
public class McpDeviceFlowTests : IDisposable
{
    private const string SiteHost = "textstack.test";
    private const UnixFileMode OwnerOnly = UnixFileMode.UserRead | UnixFileMode.UserWrite;

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

    // Thread-safe, answers by path: device/code → one code, device/token → pending.
    // Optionally holds the device/code POST on a gate so a second caller lands mid-flight.
    private sealed class PathHandler(bool gated = false) : HttpMessageHandler
    {
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _entered = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _deviceCodeCount;
        public int DeviceCodeCount => Volatile.Read(ref _deviceCodeCount);
        public Task Entered => _entered.Task;
        public void Release() => _release.TrySetResult();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath != "/auth/device/code")
                return Json(HttpStatusCode.BadRequest, Pending);

            Interlocked.Increment(ref _deviceCodeCount);
            if (gated)
            {
                _entered.TrySetResult();
                await _release.Task;
            }
            return Json(HttpStatusCode.OK, DeviceCode("UC"));
        }
    }

    // device/code fails (500) the first time, then succeeds.
    private sealed class FlakyDeviceCodeHandler : HttpMessageHandler
    {
        private int _deviceCodeCount;
        public int DeviceCodeCount => Volatile.Read(ref _deviceCodeCount);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            if (request.RequestUri!.AbsolutePath != "/auth/device/code")
                return Task.FromResult(Json(HttpStatusCode.BadRequest, Pending));
            return Task.FromResult(Interlocked.Increment(ref _deviceCodeCount) == 1
                ? new HttpResponseMessage(HttpStatusCode.InternalServerError)
                : Json(HttpStatusCode.OK, DeviceCode("RETRY-UC")));
        }
    }

    // Cancels the caller's token as the request goes out, then observes it.
    private sealed class CancelObservingHandler(CancellationTokenSource cts) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            cts.Cancel();
            ct.ThrowIfCancellationRequested();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    private const string Pending = """{"error":"authorization_pending"}""";

    private static string DeviceCode(string userCode, string deviceCode = "DC") =>
        $$"""{"device_code":"{{deviceCode}}","user_code":"{{userCode}}","verification_uri":"https://x/device","verification_uri_complete":"https://x/device?code={{userCode}}","expires_in":600,"interval":1}""";

    private static HttpResponseMessage Json(HttpStatusCode status, string json) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    private static Func<HttpRequestMessage, HttpResponseMessage> Resp(HttpStatusCode status, string json) =>
        _ => Json(status, json);

    private static DeviceFlowTokenProvider Build(
        HttpMessageHandler handler, TokenCache cache, ILogger<DeviceFlowTokenProvider>? logger = null)
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri("https://api.example/") };
        http.DefaultRequestHeaders.Host = SiteHost;
        return new DeviceFlowTokenProvider(
            http, cache, logger ?? NullLogger<DeviceFlowTokenProvider>.Instance,
            time: null, minPollInterval: TimeSpan.FromMilliseconds(5));
    }

    // Every token file a test creates is deleted even when the test fails.
    private readonly List<string> _tempFiles = [];

    private TokenCache TempCache()
    {
        var path = Path.Combine(Path.GetTempPath(), "ts-mcp-" + Guid.NewGuid().ToString("N") + ".json");
        _tempFiles.Add(path);
        return new TokenCache(path);
    }

    public void Dispose() => _tempFiles.ForEach(File.Delete);

    private static string B64Url(string s) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    // Hand-crafted UNSIGNED JWT with an exp claim.
    private static string Jwt(long expUnix, string sub = "u1") =>
        $"{B64Url("""{"alg":"none","typ":"JWT"}""")}.{B64Url($$"""{"sub":"{{sub}}","exp":{{expUnix}}}""")}.sig";

    private static string JwtIn(TimeSpan fromNow) => Jwt(DateTimeOffset.UtcNow.Add(fromNow).ToUnixTimeSeconds());

    [Fact]
    public async Task GetTokenAsync_FirstSignIn_ShowsCodeAtOnceThenAuthorizesOnceApproved()
    {
        var access = JwtIn(TimeSpan.FromHours(1));
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK, DeviceCode("WDJB-MQXR", deviceCode: "SECRET-DC")),
            Resp(HttpStatusCode.BadRequest, Pending),
            Resp(HttpStatusCode.BadRequest, Pending),
            Resp(HttpStatusCode.OK, $$"""{"access_token":"{{access}}","refresh_token":"SECRET-RT","token_type":"Bearer"}"""),
        ]);
        var cache = TempCache();
        var logger = new CapturingLogger<DeviceFlowTokenProvider>();
        var provider = Build(handler, cache, logger);

        var first = await provider.GetTokenAsync(CancellationToken.None);
        var pending = Assert.IsType<TokenResult.Pending>(first);
        Assert.Equal("https://x/device", pending.VerificationUri);
        Assert.Equal("WDJB-MQXR", pending.UserCode);

        await provider.WaitForBackgroundPollAsync();

        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal(access, Assert.IsType<TokenResult.Authorized>(second).AccessToken);
        Assert.Equal(
            ["/auth/device/code", "/auth/device/token", "/auth/device/token", "/auth/device/token"],
            handler.Requests.Select(r => r.RequestUri!.AbsolutePath));
        Assert.Contains("SECRET-DC", handler.Bodies[1]);

        // The approved tokens are on disk, readable by the owner only.
        var saved = cache.Read();
        Assert.NotNull(saved);
        Assert.Equal(access, saved!.AccessToken);
        Assert.Equal("SECRET-RT", saved.RefreshToken);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(OwnerOnly, File.GetUnixFileMode(cache.Path));

        // The log tells the reader where to go, and never carries a secret.
        var logs = logger.Entries.Select(e => e.Message).ToList();
        Assert.Contains(logs, m => m.Contains("https://x/device") && m.Contains("WDJB-MQXR"));
        Assert.DoesNotContain(logs, m => m.Contains("SECRET-DC") || m.Contains("SECRET-RT") || m.Contains(access));
    }

    [Fact]
    public async Task GetTokenAsync_FirstSignIn_AnswersWithoutWaitingForApproval()
    {
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK, DeviceCode("UC")),
            Resp(HttpStatusCode.BadRequest, Pending),
        ]);
        var provider = Build(handler, TempCache());

        // The tool call never waits on the (1s) poll for the reader approving in a browser.
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var result = await provider.GetTokenAsync(CancellationToken.None);
        sw.Stop();

        Assert.IsType<TokenResult.Pending>(result);
        Assert.True(sw.ElapsedMilliseconds < 800, $"GetTokenAsync blocked for {sw.ElapsedMilliseconds}ms");
    }

    // 60s left is outside the 30s refresh margin.
    [Theory]
    [InlineData(3600)]
    [InlineData(60)]
    public async Task GetTokenAsync_SavedSignInStillValid_UsedWithoutNetwork(int expiresIn)
    {
        var cache = TempCache();
        var access = JwtIn(TimeSpan.FromSeconds(expiresIn));
        cache.Write(new CachedTokens(access, "OLD-RT", DateTimeOffset.UtcNow.AddSeconds(expiresIn)));
        var handler = new ScriptedHandler([Resp(HttpStatusCode.InternalServerError, "")]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal(access, Assert.IsType<TokenResult.Authorized>(result).AccessToken);
        Assert.Empty(handler.Requests);
    }

    // expiresIn is the saved access token's lifetime; 20s is inside the 30s refresh margin.
    [Theory]
    [InlineData(20, "ROTATED-RT", "ROTATED-RT")]
    [InlineData(-3600, "ROTATED-RT", "ROTATED-RT")]
    [InlineData(-3600, null, "OLD-RT")]
    public async Task GetTokenAsync_SavedSignInNearExpiry_RefreshedAndSaved(
        int expiresIn, string? serverRefreshToken, string expectedSavedRefreshToken)
    {
        var cache = TempCache();
        var oldAccess = JwtIn(TimeSpan.FromSeconds(expiresIn));
        cache.Write(new CachedTokens(oldAccess, "OLD-RT", DateTimeOffset.UtcNow.AddSeconds(expiresIn)));

        var newAccess = JwtIn(TimeSpan.FromHours(1));
        var refreshBody = serverRefreshToken is null
            ? $$"""{"accessToken":"{{newAccess}}"}"""
            : $$"""{"accessToken":"{{newAccess}}","refreshToken":"{{serverRefreshToken}}"}""";
        var handler = new ScriptedHandler([Resp(HttpStatusCode.OK, refreshBody)]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal(newAccess, Assert.IsType<TokenResult.Authorized>(result).AccessToken);
        var request = Assert.Single(handler.Requests);
        Assert.Equal("/auth/refresh-mobile", request.RequestUri!.AbsolutePath);
        Assert.Equal("OLD-RT", JsonDocument.Parse(handler.Bodies[0]!).RootElement.GetProperty("refreshToken").GetString());

        var saved = cache.Read();
        Assert.NotNull(saved);
        Assert.Equal(newAccess, saved!.AccessToken);
        Assert.Equal(expectedSavedRefreshToken, saved.RefreshToken);
    }

    [Fact]
    public async Task GetTokenAsync_RefreshTokenRevoked_StartsNewSignIn()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(JwtIn(TimeSpan.FromHours(-1)), "STALE-RT", DateTimeOffset.UtcNow.AddHours(-1)));
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.Unauthorized, ""),
            Resp(HttpStatusCode.OK, DeviceCode("UC2")),
            Resp(HttpStatusCode.BadRequest, Pending),
        ]);
        var provider = Build(handler, cache);

        var result = await provider.GetTokenAsync(CancellationToken.None);

        Assert.Equal("UC2", Assert.IsType<TokenResult.Pending>(result).UserCode);
        Assert.Equal("/auth/refresh-mobile", handler.Requests[0].RequestUri!.AbsolutePath);
        Assert.Equal("/auth/device/code", handler.Requests[1].RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task GetTokenAsync_CallerCancelledDuringRefresh_Propagates()
    {
        var cache = TempCache();
        cache.Write(new CachedTokens(JwtIn(TimeSpan.FromHours(-1)), "RT", DateTimeOffset.UtcNow.AddHours(-1)));
        using var cts = new CancellationTokenSource();
        var provider = Build(new CancelObservingHandler(cts), cache);

        // Not swallowed into Pending / Failed.
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.GetTokenAsync(cts.Token));
    }

    [Theory]
    [InlineData("access_denied")]
    [InlineData("expired_token")]
    public async Task BackgroundPoll_SignInRefused_NextCallStartsFreshSignIn(string terminalError)
    {
        var handler = new ScriptedHandler(
        [
            Resp(HttpStatusCode.OK, DeviceCode("UC1")),
            Resp(HttpStatusCode.BadRequest, $$"""{"error":"{{terminalError}}"}"""),
            Resp(HttpStatusCode.OK, DeviceCode("UC2", deviceCode: "DC2")),
            Resp(HttpStatusCode.BadRequest, Pending),
        ]);
        var provider = Build(handler, TempCache());

        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("UC1", Assert.IsType<TokenResult.Pending>(first).UserCode);
        await provider.WaitForBackgroundPollAsync();

        // Not wedged on the dead flow: a new code.
        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("UC2", Assert.IsType<TokenResult.Pending>(second).UserCode);
    }

    [Fact]
    public async Task GetTokenAsync_DeviceCodeRequestFails_ReportsFailureAndRetriesNextCall()
    {
        var handler = new FlakyDeviceCodeHandler();
        var provider = Build(handler, TempCache());

        var first = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Contains("could not reach TextStack", Assert.IsType<TokenResult.Failed>(first).Message);

        var second = await provider.GetTokenAsync(CancellationToken.None);
        Assert.Equal("RETRY-UC", Assert.IsType<TokenResult.Pending>(second).UserCode);
        Assert.Equal(2, handler.DeviceCodeCount);
    }

    [Fact]
    public async Task GetTokenAsync_ConcurrentFirstCallers_StartExactlyOneDeviceFlow()
    {
        var handler = new PathHandler();
        var provider = Build(handler, TempCache());

        var results = await Task.WhenAll(Enumerable.Range(0, 20)
            .Select(_ => Task.Run(() => provider.GetTokenAsync(CancellationToken.None))));

        Assert.All(results, r => Assert.IsType<TokenResult.Pending>(r));
        var codes = results.Cast<TokenResult.Pending>().Select(p => p.UserCode).Distinct().ToList();
        Assert.Equal("UC", Assert.Single(codes));
        Assert.Equal(1, handler.DeviceCodeCount);
    }

    [Fact]
    public async Task GetTokenAsync_SecondCallerDuringInFlightPost_SharesOneRequest()
    {
        var handler = new PathHandler(gated: true);
        var provider = Build(handler, TempCache());

        var first = Task.Run(() => provider.GetTokenAsync(CancellationToken.None));
        await handler.Entered; // POST is in flight
        var second = Task.Run(() => provider.GetTokenAsync(CancellationToken.None));
        handler.Release();

        Assert.Equal("UC", Assert.IsType<TokenResult.Pending>(await first).UserCode);
        Assert.Equal("UC", Assert.IsType<TokenResult.Pending>(await second).UserCode);
        Assert.Equal(1, handler.DeviceCodeCount);
    }

    // 4102444800 = 2100-01-01, 946684800 = 2000-01-01. "%4" = unpadded base64url payload
    // length mod 4, i.e. which padding Base64UrlDecode restores. Null = unreadable → expired.
    public static TheoryData<string, long?> TokenShapes => new()
    {
        { Jwt(4102444800, sub: "u12"), 4102444800 }, // %4 == 0, no padding
        { Jwt(4102444800), 4102444800 }, // %4 == 3, one "=" restored
        { Jwt(946684800), 946684800 }, // %4 == 2, "==" restored
        { $"{B64Url("{}")}.{B64Url("""{"exp":"4102444800"}""")}.sig", 4102444800 }, // exp as a numeric string
        { $"{B64Url("{}")}.{B64Url("""{"sub":"u1"}""")}.sig", null },
        { $"{B64Url("{}")}.{B64Url("""{"exp":true}""")}.sig", null },
        { "not-a-jwt", null },
        { "only.two", null },
        { "aaa.!!!notbase64!!!.ccc", null },
        { "", null },
    };

    [Theory]
    [MemberData(nameof(TokenShapes))]
    public void ReadExp_TokenShapes_ReadsExpiryOrNull(string jwt, long? expectedExp)
    {
        Assert.Equal(expectedExp, DeviceFlowTokenProvider.ReadExp(jwt)?.ToUnixTimeSeconds());
    }

    [Theory]
    [InlineData(UnixFileMode.OtherRead)]
    [InlineData(UnixFileMode.GroupWrite)]
    public void TokenCache_SavedTokens_OwnerOnlyAndLooseFileRefused(UnixFileMode loosened)
    {
        Assert.Equal("/tmp/custom.json", TokenCache.ResolvePath("/tmp/custom.json"));

        var cache = TempCache();
        Assert.Null(cache.Read()); // nothing saved yet

        var tokens = new CachedTokens("AT", "RT", DateTimeOffset.UnixEpoch.AddSeconds(1_700_000_000));
        cache.Write(tokens);
        Assert.Equal(tokens, cache.Read());

        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(OwnerOnly, File.GetUnixFileMode(cache.Path));

            // A file others can read or write may have leaked: re-sign-in instead.
            File.SetUnixFileMode(cache.Path, OwnerOnly | loosened);
            Assert.Null(cache.Read());
        }
    }

    [Fact]
    public void TokenCache_SymlinkPlantedAtPath_NeverWrittenThroughAndRefusedOnRead()
    {
        if (OperatingSystem.IsWindows())
            return;

        var cache = TempCache();
        var victim = cache.Path + ".victim";
        _tempFiles.Add(victim);
        const string victimJson = """{"accessToken":"X","refreshToken":"Y","accessExpiresAt":"2030-01-01T00:00:00Z"}""";
        const UnixFileMode victimMode = OwnerOnly | UnixFileMode.UserExecute;
        File.WriteAllText(victim, victimJson);
        File.SetUnixFileMode(victim, victimMode);
        File.CreateSymbolicLink(cache.Path, victim);

        // Someone planted a link to another file: a symlinked cache is not trusted.
        Assert.Null(cache.Read());

        // Saving tokens replaces the link with our own file; the target stays untouched.
        var tokens = new CachedTokens("AT", "RT", DateTimeOffset.UnixEpoch.AddSeconds(1_700_000_000));
        cache.Write(tokens);

        Assert.Equal(victimJson, File.ReadAllText(victim));
        Assert.Equal(victimMode, File.GetUnixFileMode(victim));
        Assert.Null(new FileInfo(cache.Path).LinkTarget);
        Assert.Equal(OwnerOnly, File.GetUnixFileMode(cache.Path));
        Assert.Equal(tokens, cache.Read());
    }
}
