using Dapper;
using Domain.Vocabulary;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Vocabulary;

public class VocabularyFeedRepositoryTests(V2PostgresFixture db)
{
    private readonly VocabularyFeedRepository _feed = new(db.DataSource);
    private readonly VocabularyRepository _words = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // ListDueAsync reads the database clock; due times are set hours away from it, so the two clocks may drift.
    private static DateTimeOffset Now => DateTimeOffset.UtcNow;

    private async Task<VocabularyWord> SavedWordAsync(Guid userId, string key)
    {
        var word = new VocabularyWord { Id = Guid.NewGuid(), Language = "en", Word = key, WordKey = key };
        return (await _words.SaveWordAsync(userId, word, Ct)).Word!;
    }

    private async Task<VocabularyExample> AddAsync(VocabularyWord card, string sentence) =>
        (await _words.AddExampleAsync(card.UserId, new VocabularyExample
        {
            Id = Guid.NewGuid(),
            WordId = card.Id,
            Sentence = sentence,
            OperationId = Guid.NewGuid(),
            PayloadSha256 = PayloadSha256(sentence),
        }, Ct)).Row!;

    // Due times are the server's to set; the test pins them directly.
    private async Task<VocabularyWord> CardDueAtAsync(Guid user, string key, DateTimeOffset due)
    {
        var card = await SavedWordAsync(user, key);
        await using var conn = await db.DataSource.OpenConnectionAsync(Ct);
        await conn.ExecuteAsync(new CommandDefinition(
            "UPDATE vocabulary_words SET next_review_at = @due WHERE id = @Id", new { card.Id, due }, cancellationToken: Ct));
        return card;
    }

    [Fact]
    public async Task ListDueAsync_MixedCards_ReturnsLiveUnretiredDueCardsEarliestFirstUpToTheLimit()
    {
        var user = await db.NewReaderAsync();
        var later = await CardDueAtAsync(user, "later", Now.AddHours(-1));
        var earlier = await CardDueAtAsync(user, "earlier", Now.AddHours(-2));
        await CardDueAtAsync(user, "future", Now.AddHours(1));
        var deleted = await CardDueAtAsync(user, "deleted", Now.AddHours(-3));
        await _words.DeleteWordAsync(user, deleted.Id, Ct);
        var retired = await CardDueAtAsync(user, "retired", Now.AddHours(-4));
        await using (var conn = await db.DataSource.OpenConnectionAsync(Ct))
            await conn.ExecuteAsync(new CommandDefinition(
                "UPDATE vocabulary_words SET retired_at = now() WHERE id = @Id", new { retired.Id }, cancellationToken: Ct));

        Assert.Equal([earlier.Id, later.Id], (await _feed.ListDueAsync(user, 10, Ct)).Select(w => w.Id));
        Assert.Equal([earlier.Id], (await _feed.ListDueAsync(user, 1, Ct)).Select(w => w.Id));
    }

    [Fact]
    public async Task ListDueAsync_CardsWithExamples_CarriesEachCardsLiveExamplesOldestFirst()
    {
        var user = await db.NewReaderAsync();
        var first = await CardDueAtAsync(user, "first", Now.AddHours(-2));
        var second = await CardDueAtAsync(user, "second", Now.AddHours(-1));
        var a = await AddAsync(first, "A.");
        var b = await AddAsync(first, "B.");
        var c = await AddAsync(second, "C.");

        var due = await _feed.ListDueAsync(user, 10, Ct);

        Assert.Equal([[a.Id, b.Id], [c.Id]], due.Select(w => w.Examples.Select(e => e.Id).ToArray()));
    }

    [Fact]
    public async Task ListDueAsync_LimitOfZero_Throws()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _feed.ListDueAsync(Guid.NewGuid(), 0, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_LiveAndDeleted_ReturnsBothInUpdateOrderWithTheirExamples()
    {
        var user = await db.NewReaderAsync();
        var deleted = await SavedWordAsync(user, "deleted");
        var example = await AddAsync(deleted, "Kept with its tombstone.");
        var live = await SavedWordAsync(user, "live");
        await _words.DeleteWordAsync(user, deleted.Id, Ct); // now the later of the two

        var all = await _feed.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct);
        var after = await _feed.ListChangedAsync(user, all[0].UpdatedAt, all[0].Id, 10, Ct);

        Assert.Equal([live.Id, deleted.Id], all.Select(w => w.Id));
        Assert.Equal((true, example.Id), (all[1].DeletedAt is not null, Assert.Single(all[1].Examples).Id));
        Assert.Empty(all[0].Examples);
        Assert.Equal(deleted.Id, Assert.Single(after).Id);
        Assert.Single(await _feed.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 1, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_ExampleAddedToAnOldCard_MovesItToTheEndOfTheFeed()
    {
        var user = await db.NewReaderAsync();
        var old = await SavedWordAsync(user, "old");
        var newer = await SavedWordAsync(user, "newer");

        await AddAsync(old, "A second look.");

        Assert.Equal([newer.Id, old.Id], (await _feed.ListChangedAsync(user, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct)).Select(w => w.Id));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads her rows.

    [Fact]
    public async Task ListDueAsync_AlicesDueCardsAsBob_ReturnsEmpty()
    {
        await SavedWordAsync(await db.NewReaderAsync(), "hers"); // due at creation
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _feed.ListDueAsync(bob, 10, Ct));
    }

    [Fact]
    public async Task ListChangedAsync_AlicesCardsAsBob_ReturnsEmpty()
    {
        await SavedWordAsync(await db.NewReaderAsync(), "hers");
        var bob = await db.NewReaderAsync();

        Assert.Empty(await _feed.ListChangedAsync(bob, DateTimeOffset.UnixEpoch, Guid.Empty, 10, Ct));
    }
}
