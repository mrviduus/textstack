using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// The merge on a table that carries a UNIQUE index but is re-parented with a blind bulk UPDATE.
///
/// <c>AuthService.MergeGuestAsync</c> splits its work in two: unique-keyed tables go through
/// <c>ReparentDropOnConflictAsync</c>, everything else through
/// <c>ExecuteUpdateAsync(SetProperty(x =&gt; x.UserId, realUserId))</c> under the header comment
/// "Plain re-parent (no unique conflict on UserId)". <c>ReadingSessions</c> is in the second group
/// and the header is wrong about it — <c>AppDbContext.Reading.cs</c> declares
/// <c>(UserId, EditionId, StartedAt)</c> and <c>(UserId, UserBookId, StartedAt)</c> as unique
/// (partial, filtered on the nullable column).
///
/// <c>StartedAt</c> is not a server clock: it comes off the request body
/// (<c>SubmitSessionRequest.StartedAt</c>, accepted up to 7 days old) and is the de-facto
/// idempotency key for the client's offline session queue. So "guest and account hold a session
/// with the same key" is not a microsecond collision — it is one queued session flushed under two
/// identities, which is exactly what the queue is built to retry through.
///
/// When it happens the UPDATE raises 23505, the whole merge transaction rolls back, and the
/// <c>/auth/login</c> handler answers 500. Nothing is merged, and the client re-presents the same
/// guest token on every retry, so the user cannot sign in at all — verified: three consecutive
/// attempts, three 500s.
/// </summary>
public class GuestMergeConflictTests(LiveApiFixture fixture) : IClassFixture<LiveApiFixture>
{
    private const string AccountPassword = "correct-horse-battery";

    private HttpRequestMessage Req(HttpMethod method, string path, string? token = null)
    {
        var req = fixture.CreateRequest(method, path);
        req.Headers.Add("X-Client", "mobile");
        if (token != null) req.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        return req;
    }

    private async Task<JsonElement> SendOkAsync(HttpRequestMessage req, CancellationToken ct)
    {
        var resp = await fixture.Client.SendAsync(req, ct);
        Assert.SkipWhen(IntegrationSkip.Unavailable(resp), $"{req.RequestUri} unavailable");
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "rate limited");
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<JsonElement>(ct);
    }

    /// <summary>Any published edition; the assertion does not care which book.</summary>
    private async Task<Guid> AnyEditionIdAsync(CancellationToken ct)
    {
        var books = await SendOkAsync(Req(HttpMethod.Get, "/books?limit=1"), ct);
        var items = books.GetProperty("items");
        Assert.SkipWhen(items.GetArrayLength() == 0, "no published editions in this database");
        return Guid.Parse(items[0].GetProperty("id").GetString()!);
    }

    private async Task SubmitSessionAsync(
        string token, Guid editionId, DateTimeOffset startedAt, CancellationToken ct)
    {
        var req = Req(HttpMethod.Post, "/me/reading/sessions", token);
        req.Content = JsonContent.Create(new
        {
            editionId,
            userBookId = (Guid?)null,
            startedAt,
            endedAt = startedAt.AddMinutes(5),
            durationSeconds = 300,
            wordsRead = 100,
            startPercent = 0.0,
            endPercent = 0.1,
        });
        await SendOkAsync(req, ct);
    }

    [Fact]
    public async Task Login_GuestAndAccountShareReadingSessionKey_MergesInsteadOfFailing()
    {
        var ct = TestContext.Current.CancellationToken;
        var editionId = await AnyEditionIdAsync(ct);

        // A key both identities can plausibly submit: the same reading session, flushed twice.
        var startedAt = DateTimeOffset.UtcNow.AddHours(-1);

        var email = $"merge-conflict-{Guid.NewGuid():N}@textstack.test";
        var register = Req(HttpMethod.Post, "/auth/register");
        register.Content = JsonContent.Create(new { email, password = AccountPassword, name = "Conflict" });
        var account = await SendOkAsync(register, ct);
        await SubmitSessionAsync(account.GetProperty("accessToken").GetString()!, editionId, startedAt, ct);

        var guest = await SendOkAsync(Req(HttpMethod.Post, "/auth/guest"), ct);
        var guestToken = guest.GetProperty("accessToken").GetString()!;
        await SubmitSessionAsync(guestToken, editionId, startedAt, ct);

        var login = Req(HttpMethod.Post, "/auth/login", guestToken);
        login.Content = JsonContent.Create(new { email, password = AccountPassword });
        var resp = await fixture.Client.SendAsync(login, ct);
        // NOT guarded with IntegrationSkip.Unavailable: it treats 500 as "endpoint not deployed"
        // and skips, and 500 is precisely the defect under test. A guard that swallows the failure
        // it was written to catch is how this suite would report green on a broken merge.
        Assert.SkipWhen(resp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");

        // Deliberately asserted as "sign-in works", not as "one session or two". Which row wins is
        // a product call (LWW like ReadingProgress, or drop-the-guest like VocabularyWords); locking
        // the user out of their own account is not.
        Assert.True(
            resp.StatusCode == HttpStatusCode.OK,
            $"login with a guest token returned {(int)resp.StatusCode}: the merge hit the "
            + "(UserId, EditionId, StartedAt) unique index on reading_sessions and rolled back. "
            + "The user cannot sign in — every retry re-presents the same guest token.");
    }

    private async Task<(Guid EditionId, Guid ChapterId)> AnyEditionChapterAsync(CancellationToken ct)
    {
        var books = await SendOkAsync(Req(HttpMethod.Get, "/books?limit=1"), ct);
        var items = books.GetProperty("items");
        Assert.SkipWhen(items.GetArrayLength() == 0, "no published editions in this database");
        var book = await SendOkAsync(Req(HttpMethod.Get, $"/books/{items[0].GetProperty("slug").GetString()}"), ct);
        var chapters = book.GetProperty("chapters");
        Assert.SkipWhen(chapters.GetArrayLength() == 0, "edition has no chapters");
        return (book.GetProperty("id").GetGuid(), chapters[0].GetProperty("id").GetGuid());
    }

    private async Task PutProgressAsync(
        string token, Guid editionId, Guid chapterId, string locator, DateTimeOffset readAt, CancellationToken ct)
    {
        var req = Req(HttpMethod.Put, $"/me/progress/{editionId}", token);
        req.Content = JsonContent.Create(new { chapterId, locator, percent = (double?)null, updatedAt = readAt });
        await SendOkAsync(req, ct);
    }

    [Fact]
    public async Task Login_GuestProgressReadEarlierButSentLater_AccountPositionWins()
    {
        // #942: the guest's position was READ an hour before the account's, but reached the server
        // after it (an offline flush). The merge must keep the reading that happened last.
        var ct = TestContext.Current.CancellationToken;
        var (editionId, chapterId) = await AnyEditionChapterAsync(ct);
        var now = DateTimeOffset.UtcNow;

        var email = $"merge-clock-{Guid.NewGuid():N}@textstack.test";
        var register = Req(HttpMethod.Post, "/auth/register");
        register.Content = JsonContent.Create(new { email, password = AccountPassword, name = "Clock" });
        var account = await SendOkAsync(register, ct);
        var accountToken = account.GetProperty("accessToken").GetString()!;
        await PutProgressAsync(accountToken, editionId, chapterId, "account-read-last", now.AddHours(-1), ct);

        var guest = await SendOkAsync(Req(HttpMethod.Post, "/auth/guest"), ct);
        var guestToken = guest.GetProperty("accessToken").GetString()!;
        await PutProgressAsync(guestToken, editionId, chapterId, "guest-read-first", now.AddHours(-2), ct);

        var login = Req(HttpMethod.Post, "/auth/login", guestToken);
        login.Content = JsonContent.Create(new { email, password = AccountPassword });
        var loginResp = await fixture.Client.SendAsync(login, ct);
        Assert.SkipWhen(loginResp.StatusCode == HttpStatusCode.TooManyRequests, "user-login rate limit hit");
        Assert.Equal(HttpStatusCode.OK, loginResp.StatusCode);
        var merged = await loginResp.Content.ReadFromJsonAsync<JsonElement>(ct);

        var progress = await SendOkAsync(
            Req(HttpMethod.Get, $"/me/progress/{editionId}", merged.GetProperty("accessToken").GetString()), ct);
        Assert.Equal("account-read-last", progress.GetProperty("locator").GetString());
    }
}
