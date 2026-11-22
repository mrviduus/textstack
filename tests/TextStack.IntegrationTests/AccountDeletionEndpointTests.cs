using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// GDPR / Google-Play hard-delete contract for <c>DELETE /me/account</c>.
///
/// Each test provisions its OWN throwaway user (unique test-login email) so the
/// destructive delete never touches the shared <see cref="AuthenticatedApiFixture"/>
/// user. The throwaway user authenticates with a Bearer access token (returned in
/// the body when the request advertises <c>X-Client: mobile</c>), populates
/// representative dependent rows on <c>/me/v2</c> (book, highlight, reading session,
/// vocabulary word), then deletes the account and verifies everything is gone.
///
/// Requires: docker compose up with ENABLE_TEST_AUTH=true.
/// </summary>
public class AccountDeletionEndpointTests : IClassFixture<LiveApiFixture>
{
    private readonly LiveApiFixture _fixture;
    private const string TestHost = "localhost";

    public AccountDeletionEndpointTests(LiveApiFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task DeleteAccount_WithoutAuth_Returns401()
    {
        var req = _fixture.CreateRequest(HttpMethod.Delete, "/me/account");
        var resp = await _fixture.Client.SendAsync(req, TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task DeleteAccount_RemovesUserAndAllData_TokenNoLongerWorks()
    {
        var ct = TestContext.Current.CancellationToken;

        // 1. Provision an isolated throwaway user → Bearer token.
        var token = await CreateThrowawayUserAsync(ct);
        Assert.SkipWhen(token is null, "test auth unavailable");

        // 2. Populate representative dependent rows (V2): a book with a file, a highlight in it,
        // a reading session and a vocabulary word.
        var (bookId, fileId) = (Guid.NewGuid(), Guid.NewGuid());
        var bookResp = await SendAsync(HttpMethod.Put, $"/me/v2/books/{bookId}", token!, new
        {
            title = "Deletion test book",
            file = new { id = fileId, sha256 = Sync.SyncApiFixture.NewSha256(), byteSize = 1024, originalName = "book.epub", format = "epub" },
        }, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(bookResp), "/me/v2 unavailable");
        Assert.Equal(HttpStatusCode.Created, bookResp.StatusCode);

        var highlightId = Guid.NewGuid();
        var highlightResp = await SendAsync(HttpMethod.Put, $"/me/v2/annotations/{highlightId}", token!, new
        {
            bookId,
            fileId,
            selectedText = "It was a bright cold day",
            locator = new { version = 1, scheme = "epub-cfi", value = "epubcfi(/6/4!/4/2/1:0)", quote = "bright", prefix = "It was a ", suffix = " cold day" },
        }, ct);
        Assert.True(highlightResp.IsSuccessStatusCode, $"create highlight failed: {highlightResp.StatusCode}");

        var now = DateTimeOffset.UtcNow;
        var sessionResp = await SendAsync(HttpMethod.Put, $"/me/v2/reading/sessions/{Guid.NewGuid()}", token!, new
        {
            bookId,
            startedAt = now.AddMinutes(-5),
            endedAt = now,
            durationSeconds = 300,
            wordsRead = 100,
            startPercent = 0.0m,
            endPercent = 0.5m,
        }, ct);
        Assert.True(sessionResp.IsSuccessStatusCode, $"session failed: {sessionResp.StatusCode}");

        var wordId = Guid.NewGuid();
        var vocabResp = await SendAsync(HttpMethod.Put, "/me/v2/vocabulary/words", token!,
            new { id = wordId, language = "de", word = $"w{Guid.NewGuid():N}"[..12], translation = "x" }, ct);
        Assert.True(vocabResp.IsSuccessStatusCode, $"save word failed: {vocabResp.StatusCode}");

        // 3. Sanity: the data is actually visible before deletion.
        Assert.Contains(bookId.ToString(), await ReadAsync("/me/v2/library/changes", token!, ct));
        Assert.Contains(highlightId.ToString(), await ReadAsync("/me/v2/annotations/changes", token!, ct));
        Assert.Contains(wordId.ToString(), await ReadAsync("/me/v2/vocabulary/changes", token!, ct));

        // 4. Delete the account.
        var delResp = await SendAsync(HttpMethod.Delete, "/me/account", token!, null, ct);
        Assert.Equal(HttpStatusCode.NoContent, delResp.StatusCode);

        // 5. The old access token is still signature-valid (60-min TTL) but the user
        // row is gone. Endpoints that load the user must treat it as unauthenticated
        // rather than acting on a dangling userId. /me/profile loads the user →
        // expect 401. A repeat DELETE (also loads the user) must likewise be a clean
        // 401, not a 500 from operating on a missing row.
        var profileResp = await SendAsync(HttpMethod.Get, "/me/profile", token!, null, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, profileResp.StatusCode);

        var repeatDelResp = await SendAsync(HttpMethod.Delete, "/me/account", token!, null, ct);
        Assert.Equal(HttpStatusCode.Unauthorized, repeatDelResp.StatusCode);

        // 6. Representative dependent rows are gone (read via a FRESH login on the
        // same email — re-creates an empty user, proving the data didn't survive).
        var freshToken = await TestLoginAsync(_lastEmail!, ct);
        Assert.False(string.IsNullOrEmpty(freshToken), "re-login failed");

        Assert.DoesNotContain(bookId.ToString(), await ReadAsync("/me/v2/library/changes", freshToken!, ct));
        Assert.DoesNotContain(highlightId.ToString(), await ReadAsync("/me/v2/annotations/changes", freshToken!, ct));
        Assert.DoesNotContain(wordId.ToString(), await ReadAsync("/me/v2/vocabulary/changes", freshToken!, ct));

        // Cleanup the re-created empty user so we don't leak rows.
        await SendAsync(HttpMethod.Delete, "/me/account", freshToken!, null, ct);
    }

    // --- helpers ---

    private string? _lastEmail;

    private async Task<string?> CreateThrowawayUserAsync(CancellationToken ct)
    {
        _lastEmail = $"acct-delete-{Guid.NewGuid():N}@textstack.test";
        return await TestLoginAsync(_lastEmail, ct);
    }

    private async Task<string?> TestLoginAsync(string email, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/auth/test-login");
        req.Headers.Host = TestHost;
        req.Headers.Add("X-Client", "mobile"); // → access token returned in body
        req.Content = JsonContent.Create(new { email });
        var resp = await _fixture.Client.SendAsync(req, ct);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null; // test auth disabled
        if (!resp.IsSuccessStatusCode) return null;
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: ct);
        return body.TryGetProperty("accessToken", out var t) ? t.GetString() : null;
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method, string path, string token, object? body, CancellationToken ct)
    {
        var req = new HttpRequestMessage(method, path);
        req.Headers.Host = TestHost;
        req.Headers.Add("Authorization", $"Bearer {token}");
        if (body != null) req.Content = JsonContent.Create(body);
        return await _fixture.Client.SendAsync(req, ct);
    }

    /// <summary>A V2 changes feed as text (ids are matched in it); fails on a non-success answer.</summary>
    private async Task<string> ReadAsync(string path, string token, CancellationToken ct)
    {
        var resp = await SendAsync(HttpMethod.Get, path, token, null, ct);
        Assert.True(resp.IsSuccessStatusCode, $"GET {path} failed: {resp.StatusCode}");
        return await resp.Content.ReadAsStringAsync(ct);
    }
}
