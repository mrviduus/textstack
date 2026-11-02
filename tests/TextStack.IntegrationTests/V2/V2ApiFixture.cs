using System.IO.Compression;
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
    private static HttpClient NewClient() => new(new HttpClientHandler { UseCookies = false })
    {
        BaseAddress = new Uri(Environment.GetEnvironmentVariable("API_URL") ?? "http://localhost:8080"),
        Timeout = TimeSpan.FromSeconds(30),
    };

    private readonly HttpClient _client = NewClient();

    private bool _enabled;
    private string? _failure;

    public V2Session Alice { get; private set; } = null!;
    public V2Session Bob { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        _enabled = Environment.GetEnvironmentVariable("V2_API_TESTS") == "1";
        if (!_enabled) return;
        (Alice, Bob, _failure) = await Setup.Value;
    }

    /// <summary>Skips without <c>V2_API_TESTS=1</c>; fails when it is set and V2 is not there.</summary>
    public void Require()
    {
        Assert.SkipUnless(_enabled, "V2 API tests are opt-in: set V2_API_TESTS=1 against a stack with Features__V2Api=true and `make migrate-v2` run");
        if (_failure is not null) Assert.Fail(_failure);
    }

    // One login per user and one probe per run, shared by every class: concurrent first test-logins
    // of one email race on ix_users_email in the legacy database and answer 500.
    private static readonly Lazy<Task<(V2Session, V2Session, string?)>> Setup = new(async () =>
    {
        using var client = NewClient();
        try
        {
            var alice = await LoginAsync(client, "v2-alice@textstack.app");
            var bob = await LoginAsync(client, "v2-bob@textstack.app");
            using var probe = Request(HttpMethod.Get, "/me/v2/status", alice);
            using var status = await client.SendAsync(probe);
            return (alice, bob, status.StatusCode == HttpStatusCode.OK ? null
                : $"V2_API_TESTS=1 but GET /me/v2/status answered {(int)status.StatusCode}: run `make migrate-v2` and recreate the api with Features__V2Api=true");
        }
        catch (Exception e) when (e is HttpRequestException or InvalidOperationException)
        {
            return (null!, null!, $"V2 fixture setup failed: {e.Message}");
        }
    });

    private static async Task<V2Session> LoginAsync(HttpClient client, string email)
    {
        using var request = Request(HttpMethod.Post, "/auth/test-login", body: new { email });
        using var response = await client.SendAsync(request);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"test-login answered {(int)response.StatusCode} (ENABLE_TEST_AUTH=true?)");
        return new V2Session(Cookie(response));
    }

    /// <summary>A fresh guest: an empty library, so a feed holds exactly what the test wrote.</summary>
    public async Task<V2Session> NewGuestAsync()
    {
        using var request = Request(HttpMethod.Post, "/auth/guest");
        using var response = await _client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(response.StatusCode == HttpStatusCode.TooManyRequests,
            "guest-session rate limit hit: raise GUEST_SESSION_PERMIT_LIMIT on the api (CLAUDE.md)");
        response.EnsureSuccessStatusCode();
        return new V2Session(Cookie(response));
    }

    /// <summary>A web sign-in (<paramref name="path"/> under /auth), carrying <paramref name="guest"/>'s session when given: the new session and the answer.</summary>
    public async Task<(V2Session Session, V2Response Response)> SignInAsync(string path, object body, V2Session? guest = null)
    {
        using var request = Request(HttpMethod.Post, path, guest, body);
        using var response = await _client.SendAsync(request, TestContext.Current.CancellationToken);
        Assert.SkipWhen(response.StatusCode == HttpStatusCode.TooManyRequests, $"{path} rate limit hit: raise USER_LOGIN_PERMIT_LIMIT on the api (CLAUDE.md)");
        response.EnsureSuccessStatusCode();
        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        return (new V2Session(Cookie(response)), new V2Response(response.StatusCode, JsonSerializer.Deserialize<JsonElement>(text)));
    }

    /// <summary>A request to the test host, with <paramref name="who"/>'s session and a JSON body when given.</summary>
    private static HttpRequestMessage Request(HttpMethod method, string path, V2Session? who = null, object? body = null)
    {
        var request = new HttpRequestMessage(method, path) { Content = body is null ? null : JsonContent.Create(body) };
        request.Headers.Host = LiveApiFixture.TestHost;
        if (who is not null) request.Headers.Add("Cookie", who.Cookie);
        return request;
    }

    private static string Cookie(HttpResponseMessage response) =>
        AuthenticatedApiFixture.CookieHeader(response) is { Length: > 0 } cookie ? cookie : throw new InvalidOperationException("no session cookie");

    public async Task<V2Response> SendAsync(V2Session who, HttpMethod method, string path, object? body = null)
    {
        using var request = Request(method, path, who, body);
        using var response = await _client.SendAsync(request, TestContext.Current.CancellationToken);
        var text = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        return new V2Response(response.StatusCode, text.Length == 0 ? default : JsonSerializer.Deserialize<JsonElement>(text));
    }

    /// <summary>A request with a raw body (bytes routes); <paramref name="configure"/> sets its headers. The caller disposes the answer.</summary>
    public async Task<HttpResponseMessage> SendRawAsync(V2Session who, HttpMethod method, string path, HttpContent? content = null, Action<HttpRequestMessage>? configure = null)
    {
        using var request = Request(method, path, who);
        request.Content = content;
        configure?.Invoke(request);
        return await _client.SendAsync(request, TestContext.Current.CancellationToken);
    }

    /// <summary>Imports a new book whose one file is exactly <paramref name="bytes"/> (its sha256 and size); returns its ids.</summary>
    public async Task<(Guid Book, Guid File)> ImportBytesAsync(V2Session who, byte[] bytes, string format = "epub")
    {
        var (bookId, fileId) = (Guid.NewGuid(), Guid.NewGuid());
        var file = new { id = fileId, sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes)), byteSize = bytes.Length, originalName = "book." + format, format };
        var created = await SendAsync(who, HttpMethod.Put, $"/me/v2/books/{bookId}", new { title = "Bytes", file });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        return (bookId, fileId);
    }

    public static string NewSha256() => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Guid.NewGuid().ToString())));

    public static object File(Guid id, string? sha256 = null) =>
        new { id, sha256 = sha256 ?? NewSha256(), byteSize = 1024, originalName = "book.epub", format = "epub" };

    /// <summary>Imports a new book with one file, its bytes <paramref name="sha256"/> when given; returns its ids.</summary>
    public async Task<(Guid Book, Guid File, string Sha256)> ImportAsync(V2Session who, string? sha256 = null)
    {
        var (bookId, fileId) = (Guid.NewGuid(), Guid.NewGuid());
        sha256 ??= NewSha256();
        var created = await SendAsync(who, HttpMethod.Put, $"/me/v2/books/{bookId}", new { title = "A V2 book", file = File(fileId, sha256) });
        Assert.Equal(HttpStatusCode.Created, created.Status);
        return (bookId, fileId, sha256);
    }

    /// <summary>A replacement's body: a new file version, and the current one the client saw.</summary>
    public static object Replacement(Guid? replacesFileId, long byteSize = 2048) =>
        new { replacesFileId, file = new { sha256 = NewSha256(), byteSize, originalName = "v2.epub", format = "epub" } };

    public Task<V2Response> WriteStateAsync(V2Session who, Guid bookId, object state) =>
        SendAsync(who, HttpMethod.Put, $"/me/v2/books/{bookId}/reading-state", state);

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

    /// <summary>Imports an EPUB with one chapter per title and has it extracted (<see cref="UploadAndExtractAsync"/>); its ids and chapter keys.</summary>
    public async Task<(Guid Book, Guid File, IReadOnlyList<string> Keys)> ImportWithChaptersAsync(V2Session who, params string[] titles)
    {
        var bytes = Epub(titles);
        var (book, file) = await ImportBytesAsync(who, bytes);
        return (book, file, await UploadAndExtractAsync(who, book, file, bytes));
    }

    /// <summary>
    /// Uploads a file's bytes and waits for the transitional extraction (the worker must run against this api's
    /// storage root and V2 database); returns the file's chapter keys in order.
    /// </summary>
    public async Task<IReadOnlyList<string>> UploadAndExtractAsync(V2Session who, Guid book, Guid file, byte[] bytes)
    {
        var chapters = $"/me/v2/books/{book}/files/{file}/chapters";
        using var part = await SendRawAsync(who, HttpMethod.Put, $"/me/v2/books/{book}/files/{file}/parts/0", new ByteArrayContent(bytes));
        Assert.Equal(HttpStatusCode.OK, part.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await SendAsync(who, HttpMethod.Post, $"/me/v2/books/{book}/files/{file}/content", new { partCount = 1 })).Status);

        var toc = await SendAsync(who, HttpMethod.Get, chapters);
        for (var waited = 0; waited < 60_000 && toc.Body.GetProperty("ingestion").GetString() is "queued" or "processing"; waited += 500)
        {
            await Task.Delay(500, TestContext.Current.CancellationToken);
            toc = await SendAsync(who, HttpMethod.Get, chapters);
        }
        Assert.Equal("succeeded", toc.Body.GetProperty("ingestion").GetString());
        return toc.Body.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("chapterKey").GetString()!).ToList();
    }

    /// <summary>A valid EPUB 3 with one chapter per title, its bytes unique to this call.</summary>
    public static byte[] Epub(params string[] titles)
    {
        using var buffer = new MemoryStream();
        using (var zip = new ZipArchive(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string name, string text, CompressionLevel level = CompressionLevel.Optimal)
            {
                using var writer = new StreamWriter(zip.CreateEntry(name, level).Open());
                writer.Write(text);
            }
            Add("mimetype", "application/epub+zip", CompressionLevel.NoCompression);
            Add("META-INF/container.xml", """
                <?xml version="1.0" encoding="UTF-8"?>
                <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
                </container>
                """);
            var ids = titles.Select((_, i) => $"c{i + 1}").ToArray();
            Add("OEBPS/content.opf", $"""
                <?xml version="1.0" encoding="UTF-8"?>
                <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:identifier id="uid">{Guid.NewGuid()}</dc:identifier><dc:title>Three chapters</dc:title><dc:language>en</dc:language>
                    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
                  </metadata>
                  <manifest>
                    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                    {string.Concat(ids.Select(id => $"""<item id="{id}" href="{id}.xhtml" media-type="application/xhtml+xml"/>"""))}
                  </manifest>
                  <spine>{string.Concat(ids.Select(id => $"""<itemref idref="{id}"/>"""))}</spine>
                </package>
                """);
            Add("OEBPS/nav.xhtml", $"""
                <?xml version="1.0" encoding="UTF-8"?>
                <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head>
                <body><nav epub:type="toc"><ol>{string.Concat(titles.Select((t, i) => $"""<li><a href="{ids[i]}.xhtml">{t}</a></li>"""))}</ol></nav></body></html>
                """);
            for (var i = 0; i < titles.Length; i++)
                Add($"OEBPS/{ids[i]}.xhtml", $"""
                    <?xml version="1.0" encoding="UTF-8"?>
                    <html xmlns="http://www.w3.org/1999/xhtml"><head><title>{titles[i]}</title></head>
                    <body><h1>{titles[i]}</h1><p>The chapter called {titles[i]} has enough words in it to be read as real content.</p>
                    <p>A second paragraph keeps it from looking empty to the extractor.</p></body></html>
                    """);
        }
        return buffer.ToArray();
    }

    public ValueTask DisposeAsync()
    {
        _client.Dispose();
        return ValueTask.CompletedTask;
    }
}
