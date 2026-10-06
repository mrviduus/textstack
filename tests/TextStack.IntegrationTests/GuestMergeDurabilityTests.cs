using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace TextStack.IntegrationTests;

/// <summary>
/// The companion to <c>GuestMergeConflictTests</c>, and the reason that test keeps its teeth.
///
/// <c>MergeGuestAsync</c> now swallows integrity-constraint violations so a conflicting row can
/// never turn sign-in into a permanent 500 loop (see the catch in <c>AuthService</c> for why that
/// class and only that class). That guard has a cost: it makes "login returns 200" true whether the
/// merge succeeded or rolled back entirely — so on its own it would have turned the D3 red test
/// green WITHOUT the ReadingSession conflict actually being fixed.
///
/// This test closes that hole. Same collision as the D3 test — guest and account holding a reading
/// session with the same client-supplied <c>StartedAt</c>, which is one queued offline session
/// flushed under two identities — but it asserts on DATA rather than on status: a shelf the guest
/// built before signing in must be on the account afterwards. A rolled-back merge fails here even
/// though the login answered 200.
/// </summary>
public class GuestMergeDurabilityTests(LiveApiFixture fixture) : IClassFixture<LiveApiFixture>
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
    public async Task Login_ReadingSessionKeyCollides_GuestDataStillMerges()
    {
        var ct = TestContext.Current.CancellationToken;
        var editionId = await AnyEditionIdAsync(ct);
        var startedAt = DateTimeOffset.UtcNow.AddHours(-2);

        var email = $"merge-durable-{Guid.NewGuid():N}@textstack.test";
        var register = Req(HttpMethod.Post, "/auth/register");
        register.Content = JsonContent.Create(new { email, password = AccountPassword, name = "Durable" });
        var account = await SendOkAsync(register, ct);
        await SubmitSessionAsync(account.GetProperty("accessToken").GetString()!, editionId, startedAt, ct);

        var guest = await SendOkAsync(Req(HttpMethod.Post, "/auth/guest"), ct);
        var guestToken = guest.GetProperty("accessToken").GetString()!;
        await SubmitSessionAsync(guestToken, editionId, startedAt, ct);

        // The payload whose survival proves the transaction committed. Collections carry no unique
        // key beyond Id, so they are re-parented unconditionally — if this one is missing afterwards
        // it is because the WHOLE merge rolled back, not because of a conflict of its own.
        var name = $"Guest shelf {Guid.NewGuid():N}"[..24];
        var createReq = Req(HttpMethod.Post, "/me/library/collections", guestToken);
        createReq.Content = JsonContent.Create(new { name, color = "default" });
        var collectionId = (await SendOkAsync(createReq, ct)).GetProperty("id").GetString();

        var login = Req(HttpMethod.Post, "/auth/login", guestToken);
        login.Content = JsonContent.Create(new { email, password = AccountPassword });
        var accountToken = (await SendOkAsync(login, ct)).GetProperty("accessToken").GetString()!;

        var list = await SendOkAsync(Req(HttpMethod.Get, "/me/library/collections", accountToken), ct);

        Assert.True(
            list.EnumerateArray().Any(c => c.GetProperty("id").GetString() == collectionId),
            "sign-in succeeded but the guest's collection did not move to the account: the merge "
            + "transaction rolled back on the (UserId, EditionId, StartedAt) reading_sessions "
            + "conflict and the constraint-violation guard hid the 500. Fix the conflict, not the "
            + "guard.");
    }

    private async Task<string> ClipAsync(string token, string title, CancellationToken ct)
    {
        var req = Req(HttpMethod.Post, "/me/books/clip", token);
        req.Content = JsonContent.Create(new { title, html = "<p>Same title, same slug.</p>", language = "en" });
        return (await SendOkAsync(req, ct)).GetProperty("userBookId").GetString()!;
    }

    [Fact]
    public async Task Login_GuestUploadSlugCollides_UploadKeptUnderNewSlug()
    {
        var ct = TestContext.Current.CancellationToken;
        var title = $"Merge Slug {Guid.NewGuid():N}"[..24];

        var email = $"merge-slug-{Guid.NewGuid():N}@textstack.test";
        var register = Req(HttpMethod.Post, "/auth/register");
        register.Content = JsonContent.Create(new { email, password = AccountPassword, name = "Slug" });
        var account = await SendOkAsync(register, ct);
        await ClipAsync(account.GetProperty("accessToken").GetString()!, title, ct);

        var guestToken = (await SendOkAsync(Req(HttpMethod.Post, "/auth/guest"), ct))
            .GetProperty("accessToken").GetString()!;
        var guestBookId = await ClipAsync(guestToken, title, ct);

        var createReq = Req(HttpMethod.Post, "/me/library/collections", guestToken);
        createReq.Content = JsonContent.Create(new { name = "Guest shelf", color = "default" });
        var collectionId = (await SendOkAsync(createReq, ct)).GetProperty("id").GetString();
        var addReq = Req(HttpMethod.Post, $"/me/library/collections/{collectionId}/books", guestToken);
        addReq.Content = JsonContent.Create(new { bookId = guestBookId, bookType = "userbook" });
        var addResp = await fixture.Client.SendAsync(addReq, ct);
        Assert.SkipWhen(addResp.StatusCode == HttpStatusCode.TooManyRequests, "rate limited");
        addResp.EnsureSuccessStatusCode();

        // Same title -> same slug: the guest's upload is renamed and moves, never dropped (M1).
        var login = Req(HttpMethod.Post, "/auth/login", guestToken);
        login.Content = JsonContent.Create(new { email, password = AccountPassword });
        var accountToken = (await SendOkAsync(login, ct)).GetProperty("accessToken").GetString()!;

        var ids = await SendOkAsync(
            Req(HttpMethod.Get, $"/me/library/collections/{collectionId}/books?bookType=userbook", accountToken), ct);

        Assert.Contains(guestBookId, ids.EnumerateArray().Select(e => e.GetString()));
        var book = await SendOkAsync(Req(HttpMethod.Get, $"/me/books/{guestBookId}", accountToken), ct);
        Assert.EndsWith("-" + Guid.Parse(guestBookId).ToString("N")[..8], book.GetProperty("slug").GetString());
    }
}
