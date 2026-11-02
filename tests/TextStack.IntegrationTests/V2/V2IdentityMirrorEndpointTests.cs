using System.Net;
using static TextStack.IntegrationTests.V2.V2ApiFixture;

namespace TextStack.IntegrationTests.V2;

/// <summary>M2.5a: the legacy account delete and guest merge reach <c>textstack_v2</c> with <c>Features:V2Api</c> on.</summary>
public class V2IdentityMirrorEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    private static string NewEmail(string what) => $"v2-{what}-{Guid.NewGuid():N}@textstack.test";

    [Fact]
    public async Task DeleteAccount_FlagOn_V2RowsGone()
    {
        v2.Require();
        var email = NewEmail("delete");
        var (reader, _) = await v2.SignInAsync("/auth/test-login", new { email });
        await v2.ImportAsync(reader);

        var deleted = await v2.SendAsync(reader, HttpMethod.Delete, "/me/account");
        Assert.SkipWhen(deleted.Status == HttpStatusCode.TooManyRequests, "account-delete rate limit hit: raise ACCOUNT_DELETE_PERMIT_LIMIT on the api (CLAUDE.md)");

        // A new account under the same email: had the old V2 row survived, it would still hold the
        // email and /me/v2 would answer 503 for the new one; it starts empty instead.
        var (again, _) = await v2.SignInAsync("/auth/test-login", new { email });
        var library = await v2.SendAsync(again, HttpMethod.Get, "/me/v2/library/changes");
        Assert.Equal((HttpStatusCode.NoContent, HttpStatusCode.OK, 0), (deleted.Status, library.Status, library.Body.GetProperty("items").GetArrayLength()));
    }

    [Fact]
    public async Task GuestSignIn_FlagOn_GuestV2RowsOnTheAccountAndTheMergeMapInTheResponse()
    {
        v2.Require();
        var (email, password) = (NewEmail("merge"), "correct-horse-battery");
        var (account, _) = await v2.SignInAsync("/auth/register", new { email, password, name = "Merge" });
        var (accountBook, accountFile, sha256) = await v2.ImportAsync(account);
        var guest = await v2.NewGuestAsync();
        var (guestBook, guestFile) = (Guid.NewGuid(), Guid.NewGuid());
        Assert.Equal(HttpStatusCode.Created, (await v2.SendAsync(guest, HttpMethod.Put, $"/me/v2/books/{guestBook}", new { title = "Same bytes", file = File(guestFile, sha256) })).Status);
        var unmatched = (await v2.ImportAsync(guest)).Book;
        var word = (await v2.SendAsync(guest, HttpMethod.Put, "/me/v2/vocabulary/words", new { id = Guid.NewGuid(), language = "en", word = "quiver" + Guid.NewGuid().ToString("N")[..8] }))
            .Body.GetProperty("id").GetGuid();

        var (signedIn, response) = await v2.SignInAsync("/auth/login", new { email, password }, guest);

        var merge = response.Body.GetProperty("merge");
        Assert.Equal((accountBook, accountFile), (merge.GetProperty("books").GetProperty(guestBook.ToString()).GetGuid(), merge.GetProperty("files").GetProperty(guestFile.ToString()).GetGuid()));
        var library = await v2.SendAsync(signedIn, HttpMethod.Get, "/me/v2/library/changes");
        Assert.Equal(new[] { accountBook, unmatched }.Order(), library.Body.GetProperty("items").EnumerateArray().Select(b => b.GetProperty("id").GetGuid()).Order());
        Assert.Equal(HttpStatusCode.OK, (await v2.SendAsync(signedIn, HttpMethod.Get, $"/me/v2/vocabulary/words/{word}")).Status);
    }
}
