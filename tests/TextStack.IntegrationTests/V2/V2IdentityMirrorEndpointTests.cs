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
        var (guestBook, guestFile, _) = await v2.ImportAsync(guest, sha256);
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

    [Fact]
    public async Task GuestSignIn_GuestWithoutV2Rows_NoMergeFieldAtAll()
    {
        v2.Require();
        var (email, password) = (NewEmail("nomerge"), "correct-horse-battery");
        await v2.SignInAsync("/auth/register", new { email, password, name = "x" });
        var guest = await v2.NewGuestAsync();

        var (_, response) = await v2.SignInAsync("/auth/login", new { email, password }, guest);

        Assert.False(response.Body.TryGetProperty("merge", out _), response.Body.ToString());
    }

    [Fact]
    public async Task GuestSignIn_MatchedBookAndWord_AppendsReplayUnderTheAccountIds()
    {
        v2.Require();
        var (email, password) = (NewEmail("replay"), "correct-horse-battery");
        var (account, _) = await v2.SignInAsync("/auth/register", new { email, password, name = "x" });
        var (accountBook, accountFile, sha256) = await v2.ImportAsync(account);
        var key = "quiver" + Guid.NewGuid().ToString("N")[..8];
        var accountWord = (await v2.SendAsync(account, HttpMethod.Put, "/me/v2/vocabulary/words", new { id = Guid.NewGuid(), language = "en", word = key })).Body.GetProperty("id").GetGuid();
        var guest = await v2.NewGuestAsync();
        var (guestBook, guestFile, _) = await v2.ImportAsync(guest, sha256);
        var guestWord = (await v2.SendAsync(guest, HttpMethod.Put, "/me/v2/vocabulary/words", new { id = Guid.NewGuid(), language = "en", word = key })).Body.GetProperty("id").GetGuid();
        var review = new { operationId = Guid.NewGuid(), wordId = guestWord, reviewMode = "flashcard", isCorrect = true, responseTimeMs = 1200, clientRecordedAt = DateTimeOffset.UtcNow.AddMinutes(-1) };
        var example = new { operationId = Guid.NewGuid(), sentence = "A quiver of arrows.", bookId = guestBook, fileId = guestFile, chapterKey = "ch-1" };
        var share = new { operationId = Guid.NewGuid(), fileId = guestFile, chapterKey = "ch-1", chapterTitle = "One", chapterText = "It was a dark night.", notes = Array.Empty<object>(), language = "en" };
        Assert.Equal(HttpStatusCode.Created, (await v2.SendAsync(guest, HttpMethod.Post, "/me/v2/vocabulary/reviews", review)).Status);
        Assert.Equal(HttpStatusCode.Created, (await v2.SendAsync(guest, HttpMethod.Post, $"/me/v2/vocabulary/words/{guestWord}/examples", example)).Status);
        Assert.Equal(HttpStatusCode.Created, (await v2.SendAsync(guest, HttpMethod.Post, $"/me/v2/books/{guestBook}/shares", share)).Status);

        var (signedIn, response) = await v2.SignInAsync("/auth/login", new { email, password }, guest);

        Assert.Equal(accountWord, response.Body.GetProperty("merge").GetProperty("words").GetProperty(guestWord.ToString()).GetGuid());
        // The client rewrote its outbox by the map: the same operation is a replay, not operation_conflict.
        var replays = new[]
        {
            await v2.SendAsync(signedIn, HttpMethod.Post, "/me/v2/vocabulary/reviews", review with { wordId = accountWord }),
            await v2.SendAsync(signedIn, HttpMethod.Post, $"/me/v2/vocabulary/words/{accountWord}/examples", example with { bookId = accountBook, fileId = accountFile }),
            await v2.SendAsync(signedIn, HttpMethod.Post, $"/me/v2/books/{accountBook}/shares", share with { fileId = accountFile }),
        };
        Assert.All(replays, r => Assert.Equal(HttpStatusCode.OK, r.Status));
        Assert.Equal(HttpStatusCode.Unauthorized, (await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/library/changes")).Status);
    }

    [Fact]
    public async Task Register_GuestPromotedInPlace_ALaterGuestMergesIntoIt()
    {
        v2.Require();
        var (email, password) = (NewEmail("promoted"), "correct-horse-battery");
        var first = await v2.NewGuestAsync();
        var (kept, _, _) = await v2.ImportAsync(first);
        var (promoted, _) = await v2.SignInAsync("/auth/register", new { email, password, name = "x" }, first);
        Assert.Equal(HttpStatusCode.OK, (await v2.SendAsync(promoted, HttpMethod.Get, "/me/v2/library/changes")).Status);

        var second = await v2.NewGuestAsync();
        var (moved, _, _) = await v2.ImportAsync(second);
        var (signedIn, _) = await v2.SignInAsync("/auth/login", new { email, password }, second);

        var library = await v2.SendAsync(signedIn, HttpMethod.Get, "/me/v2/library/changes");
        Assert.Equal(new[] { kept, moved }.Order(), library.Body.GetProperty("items").EnumerateArray().Select(b => b.GetProperty("id").GetGuid()).Order());
    }
}
