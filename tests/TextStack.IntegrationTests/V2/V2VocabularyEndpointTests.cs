using System.Net;
using System.Text.Json;

namespace TextStack.IntegrationTests.V2;

/// <summary>The vocabulary rows of v2-sync-protocol.md "Endpoints" (M2.3), against the running stack.</summary>
public class V2VocabularyEndpointTests(V2ApiFixture v2) : IClassFixture<V2ApiFixture>
{
    private const string Words = "/me/v2/vocabulary/words";

    // A fresh key per test: Alice's cards outlive a run, and a key is one card per user.
    private static string NewWord() => "quiver" + Guid.NewGuid().ToString("N")[..8];

    private static object Word(string word, object? example = null, Guid? id = null) =>
        new { id = id ?? Guid.NewGuid(), language = "en", word, translation = "колчан", example };

    private static object Example(Guid operationId, string sentence = "Her voice began to quiver.", Guid? bookId = null, Guid? fileId = null) =>
        new { operationId, sentence, bookId, fileId, bookTitle = "A V2 book" };

    private static object Answer(Guid wordId, Guid? operationId = null, bool isCorrect = true) =>
        new { operationId = operationId ?? Guid.NewGuid(), wordId, reviewMode = "multiple_choice", isCorrect, responseTimeMs = 900, clientRecordedAt = DateTimeOffset.UtcNow };

    private Task<V2Response> SaveAsync(V2Session who, object body) => v2.SendAsync(who, HttpMethod.Put, Words, body);

    private Task<V2Response> ReviewAsync(V2Session who, object body) => v2.SendAsync(who, HttpMethod.Post, "/me/v2/vocabulary/reviews", body);

    private static Guid Id(V2Response r) => r.Body.GetProperty("id").GetGuid();

    private static long Revision(V2Response r) => r.Body.GetProperty("revision").GetInt64();

    [Fact]
    public async Task Put_NewWordThenTheSameWordInAnotherCase_Is201Then200WithTheFirstCardUnchanged()
    {
        v2.Require();
        var word = NewWord();
        var created = await SaveAsync(v2.Alice, Word(word));
        await ReviewAsync(v2.Alice, Answer(Id(created)));

        var again = await SaveAsync(v2.Alice, Word(" " + word.ToUpperInvariant()));

        Assert.Equal(HttpStatusCode.Created, created.Status);
        Assert.Equal((HttpStatusCode.OK, Id(created), 1, word), (again.Status, Id(again), again.Body.GetProperty("stage").GetInt32(), again.Body.GetProperty("word").GetString()));
        Assert.False(again.Body.TryGetProperty("wordKey", out _));
    }

    [Fact]
    public async Task Put_WithAnExample_IsAddedThenReplayedThenAConflictUnderTheSameOperation()
    {
        v2.Require();
        var (word, operationId) = (NewWord(), Guid.NewGuid());

        var added = await SaveAsync(v2.Alice, Word(word, Example(operationId)));
        var replayed = await SaveAsync(v2.Alice, Word(word, Example(operationId)));
        var conflict = await SaveAsync(v2.Alice, Word(word, Example(operationId, "Another sentence.")));

        Assert.Equal((HttpStatusCode.Created, "added"), (added.Status, added.Body.GetProperty("example").GetString()));
        Assert.Equal((HttpStatusCode.OK, "replayed", 1), (replayed.Status, replayed.Body.GetProperty("example").GetString(), replayed.Body.GetProperty("examples").GetArrayLength()));
        Assert.Equal((HttpStatusCode.Conflict, "operation_conflict"), (conflict.Status, conflict.Code));
        Assert.Equal("Her voice began to quiver.", conflict.Body.GetProperty("current").GetProperty("sentence").GetString());
    }

    [Fact]
    public async Task Patch_StaleAndOwnRetry_AreStaleRevisionWithCurrentAnd200()
    {
        v2.Require();
        var id = Id(await SaveAsync(v2.Alice, Word(NewWord())));

        var edited = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"{Words}/{id}", new { expectedRevision = 1, translation = "сагайдак" });
        var stale = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"{Words}/{id}", new { expectedRevision = 1, definition = "another device" });
        var ownRetry = await v2.SendAsync(v2.Alice, HttpMethod.Patch, $"{Words}/{id}", new { expectedRevision = 1, translation = "сагайдак" });

        Assert.Equal((HttpStatusCode.OK, 2L), (edited.Status, Revision(edited)));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision", "сагайдак"),
            (stale.Status, stale.Code, stale.Body.GetProperty("current").GetProperty("translation").GetString()));
        Assert.Equal((HttpStatusCode.OK, 2L), (ownRetry.Status, Revision(ownRetry)));
    }

    [Fact]
    public async Task DeleteThenRestore_IsTheTombstoneThenGuardedByRevision()
    {
        v2.Require();
        var id = Id(await SaveAsync(v2.Alice, Word(NewWord())));

        var deleted = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"{Words}/{id}");
        var again = await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"{Words}/{id}");
        var stale = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{id}/restore", new { expectedRevision = 1 });
        var restored = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{id}/restore", new { expectedRevision = 2 });

        Assert.Equal((HttpStatusCode.OK, JsonValueKind.String, 2L), (deleted.Status, deleted.Body.GetProperty("deletedAt").ValueKind, Revision(deleted)));
        Assert.Equal((HttpStatusCode.OK, 2L), (again.Status, Revision(again)));
        Assert.Equal((HttpStatusCode.Conflict, "stale_revision", 2L), (stale.Status, stale.Code, stale.Body.GetProperty("revision").GetInt64()));
        Assert.Equal((HttpStatusCode.OK, JsonValueKind.Null, 3L), (restored.Status, restored.Body.GetProperty("deletedAt").ValueKind, Revision(restored)));
    }

    [Fact]
    public async Task PostExample_OnADeletedCardAnotherUsersBookAndAFileOfAnotherBook_AreDeletedBookNotFoundAndUnknownFile()
    {
        v2.Require();
        var (alicesBook, _, _) = await v2.ImportAsync(v2.Alice);
        var (otherBook, otherFile, _) = await v2.ImportAsync(v2.Alice);
        var (bobsBook, _, _) = await v2.ImportAsync(v2.Bob);
        var live = Id(await SaveAsync(v2.Alice, Word(NewWord())));
        var gone = Id(await SaveAsync(v2.Alice, Word(NewWord())));
        await v2.SendAsync(v2.Alice, HttpMethod.Delete, $"{Words}/{gone}");

        var onTombstone = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{gone}/examples", Example(Guid.NewGuid()));
        var bobsBookAsAlice = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{live}/examples", Example(Guid.NewGuid(), bookId: bobsBook));
        var foreignFile = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{live}/examples", Example(Guid.NewGuid(), bookId: alicesBook, fileId: otherFile));
        var fine = await v2.SendAsync(v2.Alice, HttpMethod.Post, $"{Words}/{live}/examples", Example(Guid.NewGuid(), bookId: otherBook, fileId: otherFile));

        Assert.Equal((HttpStatusCode.Conflict, "deleted"), (onTombstone.Status, onTombstone.Code));
        Assert.Equal((HttpStatusCode.NotFound, "book_not_found"), (bobsBookAsAlice.Status, bobsBookAsAlice.Code));
        Assert.Equal((HttpStatusCode.Conflict, "unknown_file"), (foreignFile.Status, foreignFile.Code));
        Assert.Equal(HttpStatusCode.Created, fine.Status);
    }

    [Fact]
    public async Task PostReview_CreatedReplayedAndReusedOperation_Are201_200_OperationConflict()
    {
        v2.Require();
        var id = Id(await SaveAsync(v2.Alice, Word(NewWord())));
        var answer = Answer(id);

        var created = await ReviewAsync(v2.Alice, answer);
        var replayed = await ReviewAsync(v2.Alice, answer);
        var conflict = await ReviewAsync(v2.Alice, Answer(id, created.Body.GetProperty("review").GetProperty("operationId").GetGuid(), isCorrect: false));

        var review = created.Body.GetProperty("review");
        Assert.Equal((HttpStatusCode.Created, 0, 1), (created.Status, review.GetProperty("stageBefore").GetInt32(), review.GetProperty("stageAfter").GetInt32()));
        Assert.Equal(1, created.Body.GetProperty("word").GetProperty("stage").GetInt32());
        Assert.Equal((HttpStatusCode.OK, review.GetProperty("id").GetGuid()), (replayed.Status, replayed.Body.GetProperty("review").GetProperty("id").GetGuid()));
        Assert.Equal((HttpStatusCode.Conflict, "operation_conflict"), (conflict.Status, conflict.Code));
    }

    // S3: each answer is applied to the locked card, so the second sees the first's result.
    [Fact]
    public async Task PostReview_TwoAnswersInFlight_AreBothApplied()
    {
        v2.Require();
        var id = Id(await SaveAsync(v2.Alice, Word(NewWord())));

        var answers = await Task.WhenAll(ReviewAsync(v2.Alice, Answer(id)), ReviewAsync(v2.Alice, Answer(id)));

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.Created, a.Status));
        Assert.Equal([0, 1], answers.Select(a => a.Body.GetProperty("review").GetProperty("stageBefore").GetInt32()).Order());
        var card = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"{Words}/{id}");
        // Stage 0 → 1 on the first correct answer; the second counts towards stage 2.
        Assert.Equal((1, 1), (card.Body.GetProperty("stage").GetInt32(), card.Body.GetProperty("consecutiveCorrect").GetInt32()));
    }

    // SrsEngine: 1 + 2 + 2 + 2 correct answers reach stage 4 (14 days); three more there retire the card.
    [Fact]
    public async Task PostReview_TenCorrectAnswers_RetireTheCardOutOfDueButStillInTheFeed()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var id = Id(await SaveAsync(guest, Word(NewWord())));

        V2Response last = null!;
        for (var i = 0; i < 10; i++)
            last = await ReviewAsync(guest, Answer(id));

        var word = last.Body.GetProperty("word");
        Assert.Equal((4, JsonValueKind.String, JsonValueKind.Null, 2L),
            (word.GetProperty("stage").GetInt32(), word.GetProperty("retiredAt").ValueKind, word.GetProperty("deletedAt").ValueKind, word.GetProperty("revision").GetInt64()));
        var due = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/vocabulary/due?limit=500");
        Assert.DoesNotContain(id, due.Body.EnumerateArray().Select(w => w.GetProperty("id").GetGuid()));
        var feed = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/vocabulary/changes");
        Assert.Equal(JsonValueKind.String, Assert.Single(feed.Body.GetProperty("items").EnumerateArray()).GetProperty("retiredAt").ValueKind);
    }

    [Fact]
    public async Task GetChanges_PagedByCursor_HasEveryCardOnceWithTombstonesAndExamples()
    {
        v2.Require();
        var guest = await v2.NewGuestAsync();
        var first = Id(await SaveAsync(guest, Word(NewWord(), Example(Guid.NewGuid()))));
        var second = Id(await SaveAsync(guest, Word(NewWord())));
        await v2.SendAsync(guest, HttpMethod.Delete, $"{Words}/{first}"); // now the later of the two

        var rows = new List<JsonElement>();
        string? cursor = null;
        do
        {
            var page = await v2.SendAsync(guest, HttpMethod.Get, "/me/v2/vocabulary/changes?limit=1" + (cursor is null ? "" : $"&cursor={cursor}"));
            Assert.Equal(HttpStatusCode.OK, page.Status);
            rows.AddRange(page.Body.GetProperty("items").EnumerateArray());
            cursor = page.Body.GetProperty("hasMore").GetBoolean() ? page.Body.GetProperty("cursor").GetString() : null;
        } while (cursor is not null && rows.Count < 10);

        Assert.Equal([second, first], rows.Select(r => r.GetProperty("id").GetGuid()));
        Assert.Equal(JsonValueKind.String, rows[1].GetProperty("deletedAt").ValueKind);
        Assert.Equal(1, rows[1].GetProperty("examples").GetArrayLength());
    }

    [Fact]
    public async Task AnotherUsersCard_IsNotFoundToEveryRouteAndAbsentFromHisFeed()
    {
        v2.Require();
        var alices = Id(await SaveAsync(v2.Alice, Word(NewWord())));
        var bob = await v2.NewGuestAsync();

        var get = await v2.SendAsync(bob, HttpMethod.Get, $"{Words}/{alices}");
        var patch = await v2.SendAsync(bob, HttpMethod.Patch, $"{Words}/{alices}", new { expectedRevision = 1, translation = "bob's" });
        var delete = await v2.SendAsync(bob, HttpMethod.Delete, $"{Words}/{alices}");
        var restore = await v2.SendAsync(bob, HttpMethod.Post, $"{Words}/{alices}/restore", new { expectedRevision = 1 });
        var example = await v2.SendAsync(bob, HttpMethod.Post, $"{Words}/{alices}/examples", Example(Guid.NewGuid()));
        var review = await ReviewAsync(bob, Answer(alices));
        var takeover = await SaveAsync(bob, Word(NewWord(), id: alices));
        var feed = await v2.SendAsync(bob, HttpMethod.Get, "/me/v2/vocabulary/changes");

        Assert.All([get, patch, delete, restore, example, review], r => Assert.Equal((HttpStatusCode.NotFound, "not_found"), (r.Status, r.Code)));
        Assert.Equal((HttpStatusCode.Conflict, "id_conflict"), (takeover.Status, takeover.Code));
        Assert.Equal(0, feed.Body.GetProperty("items").GetArrayLength());
        var still = await v2.SendAsync(v2.Alice, HttpMethod.Get, $"{Words}/{alices}");
        Assert.Equal((1L, "колчан", JsonValueKind.Null), (Revision(still), still.Body.GetProperty("translation").GetString(), still.Body.GetProperty("deletedAt").ValueKind));
    }
}
