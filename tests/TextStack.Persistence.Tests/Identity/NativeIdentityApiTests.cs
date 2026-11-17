using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Api;
using Application.Auth;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Npgsql;
using TextStack.UnitTests;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The real HTTP pipeline and real V2 repositories, with legacy deliberately unreachable.</summary>
public sealed class NativeIdentityApiTests(V2PostgresFixture db) : IAsyncDisposable
{
    private readonly string _prefix = "native_" + Guid.NewGuid().ToString("N")[..12];
    private readonly List<WebApplicationFactory<ApiMarker>> _apps = [];
    private readonly Mail _mail = new();
    private readonly FakeLlm _llm = new();
    private const string Password = "correct horse battery";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Physical connections the legacy pool opened: v2 mode must open none (a silent catch would hide a refused one).
    private int _legacyConnections;
    private const string Unreachable = "Host=127.0.0.1;Port=1;Database=down;Timeout=1";

    private void AssertLegacyUntouched() => Assert.Equal(0, Volatile.Read(ref _legacyConnections));

    /// <summary>
    /// v2 mode: V2 is the scratch database; legacy is a reachable, counted pool (<see cref="AssertLegacyUntouched"/>).
    /// legacy mode: legacy is a migrated scratch database; V2 is unreachable.
    /// <paramref name="migratedLegacy"/> (v2 mode): legacy is a migrated scratch database too, what readiness needs.
    /// </summary>
    private async Task<(HttpClient Client, string Target)> ApiAsync(bool v2 = true, bool migratedLegacy = false)
    {
        var target = v2 ? await db.Databases.NewV2Async(_prefix + (migratedLegacy ? "_m" : "")) : (await db.Databases.NewLegacyAsync(_prefix + "_legacy")).Admin;
        var legacy = !v2 ? target
            // No pooling: every legacy open is a physical one, so the counter still sees use after the health probe's.
            : migratedLegacy ? (await db.Databases.NewLegacyAsync(_prefix + "_catalog")).Admin + ";Pooling=false"
            : db.Databases.ConnectionString("postgres");
        var root = Path.Combine(Path.GetTempPath(), _prefix);
        Directory.CreateDirectory(Path.Combine(root, "library"));
        var app = new WebApplicationFactory<ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("Database:Mode", v2 ? "v2" : "legacy");
            b.UseSetting("Features:V2Api", "true");
            b.UseSetting("Maintenance:WriteFreeze", "false");
            b.UseSetting("ConnectionStrings:Default", legacy);
            b.UseSetting("ConnectionStrings:V2", v2 ? target : Unreachable);
            b.UseSetting("Jwt:SecretKey", TestTokens.Secret);
            b.UseSetting("Jwt:Issuer", TestTokens.Issuer);
            b.UseSetting("App:BaseUrl", "https://textstack.app");
            b.UseSetting("Storage:RootPath", Path.Combine(root, "storage"));
            b.UseSetting("Storage:LibraryRoot", Path.Combine(root, "library"));
            b.UseSetting("Ollama:BaseUrl", "http://127.0.0.1:1");
            b.UseSetting("Translate:CachePath", Path.Combine(root, "translate-cache"));
            b.UseSetting("Explain:CachePath", Path.Combine(root, "explain-cache"));
            b.ConfigureTestServices(s =>
            {
                s.RemoveAll<IHostedService>();
                s.RemoveAll<IEmailService>();
                s.AddSingleton<IEmailService>(_mail);
                // No paid calls: both LLM seams answer from the fake, which keeps the prompts it was given.
                s.RemoveAll<Domain.LLM.ILlmServiceFactory>();
                s.AddSingleton<Domain.LLM.ILlmServiceFactory>(_llm);
                s.RemoveAll<TextStack.Ai.Core.ILlmService>();
                s.AddSingleton<TextStack.Ai.Core.ILlmService>(_llm);
                if (!v2) return;
                // The one legacy pool EF and Dapper share (DataSource.AddTextStackDataAccess), counted.
                s.RemoveAll<NpgsqlDataSource>();
                s.AddSingleton(_ =>
                {
                    var pool = new NpgsqlDataSourceBuilder(legacy);
                    pool.UsePhysicalConnectionInitializer(
                        _ => Interlocked.Increment(ref _legacyConnections),
                        _ => { Interlocked.Increment(ref _legacyConnections); return Task.CompletedTask; });
                    return pool.Build();
                });
            });
        });
        _apps.Add(app);
        var client = app.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = false, AllowAutoRedirect = false });
        client.DefaultRequestHeaders.Add("X-Client", "mobile");
        return (client, target);
    }

    private static async Task<JsonElement> BodyAsync(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync(Ct);
        Assert.True(response.IsSuccessStatusCode, $"{response.StatusCode}: {body}");
        return JsonSerializer.Deserialize<JsonElement>(body);
    }

    private static async Task<JsonElement> RegisterAsync(HttpClient client, string email = "native@example.test") =>
        await BodyAsync(await client.PostAsJsonAsync("/auth/register", new { email, password = Password, name = "Native" }, Ct));

    private static void Bearer(HttpClient client, string token) => client.DefaultRequestHeaders.Authorization = new("Bearer", token);
    private static string Access(JsonElement body) => body.GetProperty("accessToken").GetString()!;
    private static Guid UserId(JsonElement body) => body.GetProperty("user").GetProperty("id").GetGuid();

    [Fact]
    public async Task Native_LoginRefreshResetAndLogout_WorkWithoutLegacy_AndResetRevokesLiveJwt()
    {
        var (client, _) = await ApiAsync();
        using (client)
        {
            var registered = await RegisterAsync(client);
            var oldAccess = Access(registered);
            Bearer(client, oldAccess);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/auth/me", Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
            var refreshed = await BodyAsync(await client.PostAsJsonAsync("/auth/refresh-mobile",
                new { refreshToken = registered.GetProperty("refreshToken").GetString() }, Ct));
            Assert.Equal(UserId(registered), UserId(refreshed));

            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/auth/forgot-password", new { email = "native@example.test" }, Ct)).StatusCode);
            Assert.NotNull(_mail.ResetToken);
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/auth/reset-password", new { token = _mail.ResetToken, password = "a changed password" }, Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/auth/me/", Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/auth/refresh-mobile",
                new { refreshToken = refreshed.GetProperty("refreshToken").GetString() }, Ct)).StatusCode);

            var login = await BodyAsync(await client.PostAsJsonAsync("/auth/login", new { email = "native@example.test", password = "a changed password" }, Ct));
            Bearer(client, Access(login));
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/auth/me", Ct)).StatusCode);
            client.DefaultRequestHeaders.Add("Cookie", "refresh_token=" + login.GetProperty("refreshToken").GetString());
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/auth/logout", null, Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync("/auth/refresh-mobile",
                new { refreshToken = login.GetProperty("refreshToken").GetString() }, Ct)).StatusCode);
        }
        AssertLegacyUntouched();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Native_GuestPromotionOrMerge_KeepsBooks(bool merge)
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            var account = merge ? await RegisterAsync(client) : default;
            var guest = await BodyAsync(await client.PostAsync("/auth/guest", null, Ct));
            var guestId = UserId(guest);
            var book = Guid.NewGuid();
            await ExecAsync(target, "INSERT INTO books (id,user_id,title,origin) VALUES (@book,@user,'Guest book','{\"kind\":\"upload\"}')",
                new { book, user = guestId });
            Bearer(client, Access(guest));
            var signedIn = merge
                ? await BodyAsync(await client.PostAsJsonAsync("/auth/login", new { email = "native@example.test", password = Password }, Ct))
                : await RegisterAsync(client);
            var expected = merge ? UserId(account) : guestId;
            Assert.Equal(expected, UserId(signedIn));
            Assert.Equal(expected, await TestSql.ScalarAsync<Guid>(ct => OpenAsync(target, ct), "SELECT user_id FROM books WHERE id=@book", new { book }));
            if (merge)
            {
                Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
                Bearer(client, Access(signedIn));
                Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
            }
        }
        AssertLegacyUntouched();
    }

    [Fact]
    public async Task Native_DeviceMcpKeyAndAccountDelete_UseV2AndRevokeAccess()
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            var account = await RegisterAsync(client);
            Bearer(client, Access(account));
            var device = await BodyAsync(await client.PostAsync("/auth/device/code", null, Ct));
            Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/auth/device/approve", new { user_code = device.GetProperty("user_code").GetString() }, Ct)).StatusCode);
            await BodyAsync(await client.PostAsJsonAsync("/auth/device/token", new { grant_type = "urn:ietf:params:oauth:grant-type:device_code", device_code = device.GetProperty("device_code").GetString() }, Ct));
            var key = await BodyAsync(await client.PostAsJsonAsync("/me/mcp/keys", new { name = "Native" }, Ct));
            // Another V2 account cannot revoke it (owner-scoped).
            Bearer(client, Access(await RegisterAsync(client, "other@example.test")));
            Assert.Equal(HttpStatusCode.NotFound, (await client.DeleteAsync("/me/mcp/keys/" + key.GetProperty("id").GetGuid(), Ct)).StatusCode);
            Bearer(client, key.GetProperty("key").GetString()!);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
            Bearer(client, Access(account));
            Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/me/account/", Ct)).StatusCode);
            Assert.Equal(0, await TestSql.ScalarAsync<long>(ct => OpenAsync(target, ct), "SELECT count(*) FROM users WHERE id=@id", new { id = UserId(account) }));
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
            Bearer(client, key.GetProperty("key").GetString()!);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
        }
        AssertLegacyUntouched();
    }

    [Fact]
    public async Task Native_HealthNeedsV2AndLegacyCatalog_AndUnadaptedPrivateRoutesFailClosed()
    {
        // The catalog still reads legacy until M6: an unmigrated legacy database is not ready.
        var (unmigrated, _) = await ApiAsync();
        using (unmigrated)
        {
            using var notReady = await unmigrated.GetAsync("/health/ready", Ct);
            Assert.Equal(HttpStatusCode.ServiceUnavailable, notReady.StatusCode);
            var components = JsonSerializer.Deserialize<JsonElement>(await notReady.Content.ReadAsStringAsync(Ct)).GetProperty("components");
            Assert.Equal(("ok", "behind"), (components.GetProperty("db").GetProperty("status").GetString(), components.GetProperty("legacy").GetProperty("status").GetString()));
        }

        var (client, _) = await ApiAsync(migratedLegacy: true);
        using (client)
        {
            var body = await BodyAsync(await client.GetAsync("/health/ready", Ct));
            Assert.Equal("ready", body.GetProperty("status").GetString());
            Assert.Equal("v2", body.GetProperty("components").GetProperty("db").GetProperty("mode").GetString());
            Assert.Equal("ok", body.GetProperty("components").GetProperty("legacy").GetProperty("status").GetString());
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health", Ct)).StatusCode);
            // Readiness reads legacy on purpose; identity and /me must not.
            Interlocked.Exchange(ref _legacyConnections, 0);
            var account = await RegisterAsync(client);
            Bearer(client, Access(account));
            // Part C: an old-build route is gone; a route still being ported is pending.
            client.DefaultRequestHeaders.Add("X-App-Version", "1.0.0");
            Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync("/me/books", Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await client.DeleteAsync("/me/books/" + Guid.NewGuid(), Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await client.PutAsJsonAsync("/me/progress/" + Guid.NewGuid(), new { }, Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync("/me/reading/stats", Ct)).StatusCode);
            // Ported (V2CompatEndpoints): the legacy path answers from V2, the legacy shape.
            var highlights = await BodyAsync(await client.GetAsync("/me/highlights/all?limit=5", Ct));
            Assert.Equal(0, highlights.GetProperty("totalCount").GetInt32());
        }
        AssertLegacyUntouched();
    }

    [Fact]
    public async Task Legacy_V2Unreachable_IdentityAndHealthStillServe()
    {
        var (client, target) = await ApiAsync(v2: false);
        using (client)
        {
            using var ready = await client.GetAsync("/health/ready", Ct);
            Assert.Equal(HttpStatusCode.OK, ready.StatusCode);
            var health = JsonSerializer.Deserialize<JsonElement>(await ready.Content.ReadAsStringAsync(Ct));
            Assert.Equal("legacy", health.GetProperty("components").GetProperty("db").GetProperty("mode").GetString());

            var registered = await RegisterAsync(client);
            Assert.Equal(1, await TestSql.ScalarAsync<long>(ct => OpenAsync(target, ct), "SELECT count(*) FROM users WHERE id=@id", new { id = UserId(registered) }));
            Bearer(client, Access(registered));
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/auth/me", Ct)).StatusCode);
            var refreshed = await BodyAsync(await client.PostAsJsonAsync("/auth/refresh-mobile",
                new { refreshToken = registered.GetProperty("refreshToken").GetString() }, Ct));
            Assert.Equal(UserId(registered), UserId(refreshed));
            // V2 down pauses sync only (#1053).
            Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
        }
    }

    [Fact]
    public async Task Native_OAuthConsentAndToken_WorkWithoutLegacy()
    {
        var (client, _) = await ApiAsync();
        using (client)
        {
            var account = await RegisterAsync(client);
            Bearer(client, Access(account));
            const string redirect = "http://127.0.0.1:8123/callback";
            const string resource = "https://textstack.app/mcp";
            const string verifier = "abcdefghijklmnopqrstuvwxyz0123456789-._~abcdefghijklmnopqrstuvwxyz";
            var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            var registered = await BodyAsync(await client.PostAsJsonAsync("/oauth/register", new { client_name = "Native", redirect_uris = new[] { redirect } }, Ct));
            var clientId = registered.GetProperty("client_id").GetString()!;
            using var authorize = await client.GetAsync("/oauth/authorize?response_type=code&client_id=" + clientId
                + "&redirect_uri=" + Uri.EscapeDataString(redirect) + "&state=native&code_challenge_method=S256&code_challenge=" + challenge
                + "&resource=" + Uri.EscapeDataString(resource), Ct);
            Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
            var request = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(authorize.Headers.Location!.Query)["req"].ToString();
            var approved = await BodyAsync(await client.PostAsJsonAsync("/oauth/authorize/approve", new { requestId = Guid.Parse(request) }, Ct));
            var uri = new Uri(approved.GetProperty("redirect").GetString()!);
            var code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(uri.Query)["code"].ToString();
            var token = await BodyAsync(await client.PostAsync("/oauth/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "authorization_code",
                ["client_id"] = clientId,
                ["redirect_uri"] = redirect,
                ["code"] = code,
                ["code_verifier"] = verifier,
                ["resource"] = resource,
            }), Ct));
            Bearer(client, token.GetProperty("access_token").GetString()!);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/me/v2/status", Ct)).StatusCode);
        }
        AssertLegacyUntouched();
    }

    [Fact]
    public async Task Native_AdminUsesV2_ReaderTokenIsRefused_AndResetRevokesAdminJwt()
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            var id = Guid.NewGuid();
            await ExecAsync(target, "INSERT INTO users (id,email,password_hash,role,created_at) VALUES (@id,'admin@example.test',@hash,'admin',now())",
                new { id, hash = PasswordHashing.Hash(Password) });
            using var login = await client.PostAsJsonAsync("/admin/auth/login", new { email = "admin@example.test", password = Password }, Ct);
            await BodyAsync(login);
            var cookie = login.Headers.GetValues("Set-Cookie").Single(s => s.StartsWith("admin_access_token=", StringComparison.Ordinal)).Split(';')[0];
            client.DefaultRequestHeaders.Add("Cookie", cookie);
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/admin/auth/me", Ct)).StatusCode);
            Bearer(client, cookie["admin_access_token=".Length..]);
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/auth/me", Ct)).StatusCode);
            client.DefaultRequestHeaders.Authorization = null;
            client.DefaultRequestHeaders.Remove("Cookie");
            var reader = await RegisterAsync(client);
            client.DefaultRequestHeaders.Add("Cookie", "admin_access_token=" + Access(reader));
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/admin/auth/me", Ct)).StatusCode);
            client.DefaultRequestHeaders.Remove("Cookie");
            client.DefaultRequestHeaders.Add("Cookie", cookie);
            await ExecAsync(target, "UPDATE users SET credentials_reset_at=clock_timestamp() WHERE id=@id", new { id });
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/admin/auth/me", Ct)).StatusCode);
        }
        AssertLegacyUntouched();
    }

    private static async ValueTask<NpgsqlConnection> OpenAsync(string target, CancellationToken ct)
    {
        var conn = new NpgsqlConnection(target);
        await conn.OpenAsync(ct);
        return conn;
    }

    private static Task ExecAsync(string target, string sql, object args) => TestSql.ExecAsync(ct => OpenAsync(target, ct), sql, args);

    public async ValueTask DisposeAsync()
    {
        foreach (var app in _apps) await app.DisposeAsync();
        await db.Databases.DropAsync(_prefix);
        var root = Path.Combine(Path.GetTempPath(), _prefix);
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }

    [Fact]
    public async Task Native_ExplainAndTranslate_AnswerWithTheV2BookGenreAndAnonymously()
    {
        // A public path resolves the site from legacy's catalog (read-only in v2 mode until M6): a migrated one.
        var (client, target) = await ApiAsync(migratedLegacy: true);
        using (client)
        {
            var account = await RegisterAsync(client);
            var book = Guid.NewGuid();
            await ExecAsync(target, "INSERT INTO books (id,user_id,title,genre,origin) VALUES (@book,@user,'Physics','Astrophysics','{\"kind\":\"upload\"}')",
                new { book, user = UserId(account) });

            // Anonymous: the reading loop's translate needs no account, in v2 mode as in legacy.
            var anonymous = await BodyAsync(await client.PostAsJsonAsync("/api/translate",
                new { text = "good morning", sourceLang = "en", targetLang = "uk" }, Ct));
            Assert.Equal("fake answer", anonymous.GetProperty("translatedText").GetString());

            Bearer(client, Access(account));
            await BodyAsync(await client.PostAsJsonAsync("/translate",
                new { text = "red shift", sourceLang = "en", targetLang = "uk", bookId = book.ToString() }, Ct));
            Assert.Contains(_llm.SystemPrompts, p => p.Contains("Domain hint: Astrophysics", StringComparison.Ordinal));

            var explained = await BodyAsync(await client.PostAsJsonAsync("/explain",
                new { word = "shift", sentence = "The red shift grew.", bookId = book.ToString() }, Ct));
            Assert.Equal("fake answer", explained.GetProperty("explanation").GetString());
            Assert.Equal(2, _llm.SystemPrompts.Count(p => p.Contains("Astrophysics", StringComparison.Ordinal)));
        }
    }

    [Fact]
    public async Task AnAssistantReadsAndAnnotatesAV2OnlyBookThroughMcp()
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            var account = await RegisterAsync(client);
            var (user, book, file) = (UserId(account), Guid.NewGuid(), Guid.NewGuid());
            await ExecAsync(target, """
                INSERT INTO books (id,user_id,title,author,origin) VALUES (@book,@user,'Cosmos','Sagan','{"kind":"upload"}');
                INSERT INTO book_files (id,user_id,book_id,sha256,byte_size,original_name,format)
                    VALUES (@file,@user,@book,repeat('a',64),10,'cosmos.epub','epub');
                INSERT INTO book_chapters (id,user_id,book_id,file_id,chapter_key,chapter_number,title,html,plain_text,created_at) VALUES
                    (gen_random_uuid(),@user,@book,@file,'c1',1,'Shores','<p>The cosmos is all that is.</p>','The cosmos is all that is.',now()),
                    (gen_random_uuid(),@user,@book,@file,'c2',2,'Harmony','<p>Worlds.</p>','Worlds.',now());
                """, new { user, book, file });

            using var http = _apps[^1].CreateClient();
            var options = new TextStack.Ai.Mcp.McpBridgeOptions { ApiBaseUrl = "http://localhost/", SiteHost = "localhost", McpToken = Access(account), V2 = true };
            var mcp = new TextStack.Ai.Mcp.Tools.McpToolCatalog(
                new TextStack.Ai.Mcp.Http.TextStackApiClient(http, options, new TextStack.Ai.Mcp.Auth.StaticEnvTokenProvider(options)));
            async Task<JsonElement> Call(string tool, object args)
            {
                var result = await mcp.CallAsync(tool, JsonSerializer.SerializeToElement(args), Ct);
                var text = ((ModelContextProtocol.Protocol.TextContentBlock)result.Content[0]).Text;
                Assert.False(result.IsError == true, $"{tool}: {text}");
                return JsonSerializer.Deserialize<JsonElement>(text);
            }

            Assert.Contains("Cosmos", (await Call("search_my_library", new { query = "sagan" })).GetRawText());
            var chapters = (await Call("get_my_book", new { bookId = book })).GetProperty("chapters");
            var shores = chapters[0].GetProperty("chapterId").GetGuid();
            Assert.Contains("all that is", (await Call("get_my_chapter", new { bookId = book, chapterSlug = "c1" })).GetProperty("text").GetString());

            await Call("save_my_highlight", new { bookId = book, chapterId = shores, selectedText = "all that is", noteText = "the opening line" });
            var marked = (await Call("list_my_book_highlights", new { bookId = book })).GetProperty("highlights");
            Assert.Equal(shores, Assert.Single(marked.EnumerateArray()).GetProperty("chapterId").GetGuid());

            await Call("set_book_progress", new { bookId = book, chapterSlug = "c1" });
            Assert.Equal("c2", (await Call("get_book_progress", new { bookId = book })).GetProperty("chapterSlug").GetString());
            Assert.Contains("Cosmos", (await Call("get_my_reading", new { })).GetProperty("reading").GetRawText());

            await Call("save_insight", new { bookId = book, chapterSlug = "c1", text = "Sagan opens with scale." });
            var insight = Assert.Single((await Call("get_my_insights", new { bookId = book })).GetProperty("insights").EnumerateArray());
            Assert.Equal("Shores", insight.GetProperty("chapterTitle").GetString());
        }
    }

    /// <summary>Both LLM seams (Translate's factory, Explain's gateway): a fixed answer, the system prompts kept.</summary>
    private sealed class FakeLlm : Domain.LLM.ILlmServiceFactory, Domain.LLM.ILlmService, TextStack.Ai.Core.ILlmService
    {
        public System.Collections.Concurrent.ConcurrentQueue<string> SystemPrompts { get; } = new();

        public Domain.LLM.ILlmService Get(string jobName) => this;

        public Task<string> CompleteAsync(string systemPrompt, string userPrompt, int maxOutputTokens, CancellationToken ct)
        {
            SystemPrompts.Enqueue(systemPrompt);
            return Task.FromResult("fake answer");
        }

        public Task<TextStack.Ai.Core.LlmResponse> CompleteAsync(TextStack.Ai.Core.LlmRequest request, CancellationToken ct)
        {
            SystemPrompts.Enqueue(request.SystemPrompt);
            return Task.FromResult(new TextStack.Ai.Core.LlmResponse("fake answer", [], new(1, 1, 0m), "fake", Guid.NewGuid()));
        }

        public IAsyncEnumerable<TextStack.Ai.Core.LlmDelta> StreamAsync(TextStack.Ai.Core.LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private sealed class Mail : IEmailService
    {
        public string? ResetToken;
        public Task SendPasswordResetEmailAsync(string toEmail, string resetToken, CancellationToken ct) { ResetToken = resetToken; return Task.CompletedTask; }
        public Task SendAdminAlertAsync(string subject, string htmlBody, CancellationToken ct) => Task.CompletedTask;
    }
}
