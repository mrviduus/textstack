using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Security.Cryptography;
using System.Text;
using Api;
using Application.Identity;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using Npgsql;
using TextStack.UnitTests;

namespace TextStack.Persistence.Tests.Identity;

/// <summary>The real HTTP pipeline and real V2 repositories.</summary>
public sealed class NativeIdentityApiTests(PostgresFixture db) : IAsyncDisposable
{
    private readonly string _prefix = "native_" + Guid.NewGuid().ToString("N")[..12];
    private readonly List<WebApplicationFactory<ApiMarker>> _apps = [];
    private readonly Mail _mail = new();
    private readonly FakeLlm _llm = new();
    private const string Password = "correct horse battery";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>The Api on a scratch V2 database.</summary>
    private async Task<(HttpClient Client, string Target)> ApiAsync()
    {
        var target = await db.Databases.NewV2Async(_prefix + "_" + _apps.Count);
        var root = Path.Combine(Path.GetTempPath(), _prefix);
        Directory.CreateDirectory(Path.Combine(root, "library"));
        var app = new WebApplicationFactory<ApiMarker>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Test");
            b.UseSetting("Maintenance:WriteFreeze", "false");
            b.UseSetting("ConnectionStrings:Default", target);
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
    public async Task Native_LoginRefreshResetAndLogout_ResetRevokesLiveJwt()
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
    }

    [Fact]
    public async Task Native_HealthIsReadyOnV2_AndPortedRoutesServeFromV2()
    {
        var (client, _) = await ApiAsync();
        using (client)
        {
            var body = await BodyAsync(await client.GetAsync("/health/ready", Ct));
            Assert.Equal("ready", body.GetProperty("status").GetString());
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health", Ct)).StatusCode);
            var account = await RegisterAsync(client);
            Bearer(client, Access(account));
            // Ported (CompatEndpoints): the legacy path answers from V2, the legacy shape.
            var highlights = await BodyAsync(await client.GetAsync("/me/highlights/all?limit=5", Ct));
            Assert.Equal(0, highlights.GetProperty("totalCount").GetInt32());
        }
    }

    [Fact]
    public async Task Native_OAuthConsentAndToken_Work()
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
    public async Task AReaderTranslatesAndExplainsOnV2_AndTheDaysAiSpendIsCountedFromV2()
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            var account = await RegisterAsync(client);
            var book = Guid.NewGuid();
            await ExecAsync(target, "INSERT INTO books (id,user_id,title,genre,origin) VALUES (@book,@user,'Physics','Astrophysics','{\"kind\":\"upload\"}')",
                new { book, user = UserId(account) });
            // Spend earlier today (before a restart) and yesterday's, in V2's traces where v2 mode writes them.
            await ExecAsync(target, """
                INSERT INTO llm_traces (id, feature_tag, model_id, prompt_hash, messages_json, tokens_in, tokens_out, cost_usd, latency_ms, created_at) VALUES
                    (gen_random_uuid(), 'explain', 'm', 'h', '[]', 1, 1, 0.05, 1, now()),
                    (gen_random_uuid(), 'explain', 'm', 'h', '[]', 1, 1, 9, 1, now() - interval '2 days')
                """, new { });

            // Anonymous: the reading loop's translate needs no account.
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

            // The daily budget starts from today's V2 traces (scaled up by the sample rate), never legacy's.
            var services = _apps[^1].Services;
            var rate = (decimal)services.GetRequiredService<TextStack.Ai.Llm.TracingOptions>().RateFor("explain");
            // The tracker keeps whole micro-dollars; .NET 11 converts the double rate to decimal exactly.
            Assert.Equal(Math.Round(0.05m / rate, 6, MidpointRounding.AwayFromZero), services.GetRequiredService<TextStack.Ai.Core.ISpendTracker>().SpentTodayUsd("explain"));
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
                INSERT INTO book_files (id,user_id,book_id,sha256,byte_size,original_name,format,toc)
                    VALUES (@file,@user,@book,repeat('a',64),10,'cosmos.epub','epub',
                        '[{"key":"c1","title":"Shores","depth":0,"fraction":0},{"key":"c2","title":"Harmony","depth":0,"fraction":0.5}]');
                """, new { user, book, file });

            using var http = _apps[^1].CreateClient();
            var options = new TextStack.Ai.Mcp.McpBridgeOptions { ApiBaseUrl = "http://localhost/", SiteHost = "localhost", McpToken = Access(account) };
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

    [Fact]
    public async Task AClipFromTheBrowserExtensionBecomesAV2BookToRead()
    {
        var (client, target) = await ApiAsync();
        using (client)
        {
            Bearer(client, Access(await RegisterAsync(client)));
            const string html = "<html><body><h1>Tides</h1><p>The moon pulls the sea.</p></body></html>";

            // The extension's own request (apps/browser-extension/lib/api.js clip), unchanged.
            var clipped = await BodyAsync(await client.PostAsJsonAsync("/me/books/clip",
                new { Title = "Tides", Author = "A. Writer", SourceUrl = "https://example.test/tides", Html = html, Language = "en" }, Ct));
            var bookId = clipped.GetProperty("userBookId").GetGuid();

            var feed = await BodyAsync(await client.GetAsync("/me/v2/library/changes", Ct));
            var book = feed.GetProperty("items").EnumerateArray().Single(b => b.GetProperty("id").GetGuid() == bookId);
            var file = book.GetProperty("currentFile");
            Assert.Equal(("Tides", "html", true), (book.GetProperty("title").GetString(), file.GetProperty("format").GetString(), file.GetProperty("hasContent").GetBoolean()));
            Assert.Equal("https://example.test/tides", await TestSql.ScalarAsync<string>(ct => OpenAsync(target, ct),
                "SELECT origin->>'sourceUrl' FROM books WHERE id=@bookId AND origin->>'kind'='clip'", new { bookId }));

            var bytes = await client.GetStringAsync($"/me/v2/books/{bookId}/files/{file.GetProperty("id").GetGuid()}/content", Ct);
            Assert.Equal(html, bytes);
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
