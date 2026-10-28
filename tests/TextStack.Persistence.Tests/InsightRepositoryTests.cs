using Domain;
using Domain.Entities;
using Infrastructure.Persistence.Repositories;

namespace TextStack.Persistence.Tests;

public class InsightRepositoryTests(PostgresFixture db)
{
    private readonly InsightRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static BookInsight Insight(Guid userId, Guid? userBookId, string? slug, string text = "text",
        Guid? editionId = null, string? reviewJson = null)
    {
        var now = DateTimeOffset.UtcNow;
        return new BookInsight
        {
            Id = Guid.NewGuid(),
            UserId = userId,
            SiteId = SiteConstants.DefaultSiteId,
            UserBookId = userBookId,
            EditionId = editionId,
            ChapterSlug = slug,
            Text = text,
            Question = "q",
            ReviewJson = reviewJson,
            CreatedAt = now,
            UpdatedAt = now,
        };
    }

    [Fact]
    public async Task SaveAsync_EmptySlot_InsertsAndReadsBack()
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        var insight = Insight(user, book, "1-intro");

        var saved = await _repo.SaveAsync(insight, Ct);

        Assert.NotNull(saved);
        Assert.Equal(insight.Id, saved.Id);
        var row = Assert.Single(await _repo.ListForBookAsync(user, book, null, Ct));
        Assert.Equal(("1-intro", "text", "q", "mcp", user, SiteConstants.DefaultSiteId),
            (row.ChapterSlug, row.Text, row.Question, row.Source, row.UserId, row.SiteId));
        Assert.Equal(insight.CreatedAt.ToUnixTimeMilliseconds(), row.CreatedAt.ToUnixTimeMilliseconds());
    }

    [Theory]
    [InlineData("1-intro")]
    [InlineData(null)] // the book-level row: NULLS NOT DISTINCT keeps it one row too
    public async Task SaveAsync_TakenSlot_ReplacesTextKeepsIdAndCreatedAt(string? slug)
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        var first = (await _repo.SaveAsync(Insight(user, book, slug, "old"), Ct))!;

        var second = await _repo.SaveAsync(Insight(user, book, slug, "new"), Ct);

        Assert.NotNull(second);
        Assert.Equal(first.Id, second.Id);
        Assert.Equal(first.CreatedAt, second.CreatedAt);
        var row = Assert.Single(await _repo.ListForBookAsync(user, book, null, Ct));
        Assert.Equal("new", row.Text);
    }

    [Fact]
    public async Task SaveAsync_EditionTarget_UpsertsOnTheEditionKey()
    {
        var (user, _) = await db.NewReaderWithBookAsync();
        var edition = await db.AnyEditionAsync();
        var first = (await _repo.SaveAsync(Insight(user, null, "1-intro", "old", edition), Ct))!;

        var second = await _repo.SaveAsync(Insight(user, null, "1-intro", "new", edition), Ct);

        Assert.Equal(first.Id, second!.Id);
        Assert.Equal("new", Assert.Single(await _repo.ListForBookAsync(user, null, edition, Ct)).Text);
    }

    [Fact]
    public async Task SaveAsync_SlotHoldsReview_ReturnsNullAndKeepsReview()
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        await using var ef = db.NewDbContext();
        await using (var tx = await ef.BeginTransactionAsync(Ct))
        {
            await _repo.SaveReviewAsync(Insight(user, book, "1-intro", "review md", reviewJson: """{"v":1}"""), tx, Ct);
            await tx.CommitAsync(Ct);
        }

        var saved = await _repo.SaveAsync(Insight(user, book, "1-intro", "plain"), Ct);

        Assert.Null(saved);
        var row = Assert.Single(await _repo.ListForBookAsync(user, book, null, Ct));
        Assert.Equal(("review md", """{"v": 1}"""), (row.Text, row.ReviewJson));
    }

    [Fact]
    public async Task ListReviewsForBookAsync_ReturnsReviewsOnly()
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        await _repo.SaveAsync(Insight(user, book, "1-intro", "plain"), Ct);
        await _repo.SaveAsync(Insight(user, book, null, "book-level"), Ct);
        await using var ef = db.NewDbContext();
        await using (var tx = await ef.BeginTransactionAsync(Ct))
        {
            await _repo.SaveReviewAsync(Insight(user, book, "2-next", "review", reviewJson: "{}"), tx, Ct);
            await tx.CommitAsync(Ct);
        }

        var reviews = await _repo.ListReviewsForBookAsync(user, book, null, Ct);

        Assert.Equal("2-next", Assert.Single(reviews).ChapterSlug);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task ListForBookAsync_NotExactlyOneBook_Throws(bool userBook, bool edition)
    {
        await Assert.ThrowsAsync<ArgumentException>(() => _repo.ListForBookAsync(
            Guid.NewGuid(), userBook ? Guid.NewGuid() : null, edition ? Guid.NewGuid() : null, Ct));
    }

    [Fact]
    public async Task SaveReviewAsync_OverPlainInsight_ReplacesInPlace_AndRollsBackWithTheTransaction()
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        var plain = (await _repo.SaveAsync(Insight(user, book, "1-intro", "plain"), Ct))!;
        await using var ef = db.NewDbContext();

        await using (var tx = await ef.BeginTransactionAsync(Ct))
        {
            var review = await _repo.SaveReviewAsync(Insight(user, book, "1-intro", "review", reviewJson: "{}"), tx, Ct);
            Assert.Equal(plain.Id, review.Id);
            await tx.RollbackAsync(Ct);
        }
        Assert.Equal("plain", Assert.Single(await _repo.ListForBookAsync(user, book, null, Ct)).Text);

        await using (var tx = await ef.BeginTransactionAsync(Ct))
        {
            await _repo.SaveReviewAsync(Insight(user, book, "1-intro", "review", reviewJson: "{}"), tx, Ct);
            await tx.CommitAsync(Ct);
        }
        var row = Assert.Single(await _repo.ListForBookAsync(user, book, null, Ct));
        Assert.Equal((plain.Id, "review", "{}"), (row.Id, row.Text, row.ReviewJson));
    }

    [Fact]
    public async Task OtherReader_CannotReadChangeOrDelete()
    {
        var (alice, book) = await db.NewReaderWithBookAsync();
        var (bob, _) = await db.NewReaderWithBookAsync();
        var mine = (await _repo.SaveAsync(Insight(alice, book, "1-intro", "alice's"), Ct))!;

        Assert.Empty(await _repo.ListForBookAsync(bob, book, null, Ct));
        Assert.Empty(await _repo.ListByIdsAsync(bob, [mine.Id], Ct));
        Assert.False(await _repo.DeleteAsync(bob, mine.Id, Ct));
        // Bob saving into the same (book, chapter) gets his own row; Alice's is untouched.
        var bobs = await _repo.SaveAsync(Insight(bob, book, "1-intro", "bob's"), Ct);
        Assert.NotEqual(mine.Id, bobs!.Id);

        Assert.Equal("alice's", Assert.Single(await _repo.ListForBookAsync(alice, book, null, Ct)).Text);
        Assert.Equal(mine.Id, Assert.Single(await _repo.ListByIdsAsync(alice, [mine.Id, bobs.Id], Ct)).Id);
    }

    [Fact]
    public async Task NotFound_IsEmptyOrFalse_NeverAnException()
    {
        var (user, book) = await db.NewReaderWithBookAsync();

        Assert.Empty(await _repo.ListForBookAsync(user, book, null, Ct));
        Assert.Empty(await _repo.ListByIdsAsync(user, [Guid.NewGuid()], Ct));
        Assert.Empty(await _repo.ListByIdsAsync(user, [], Ct));
        Assert.False(await _repo.DeleteAsync(user, Guid.NewGuid(), Ct));
    }

    [Fact]
    public async Task DeleteAsync_OwnInsight_RemovesIt()
    {
        var (user, book) = await db.NewReaderWithBookAsync();
        var saved = (await _repo.SaveAsync(Insight(user, book, null), Ct))!;

        Assert.True(await _repo.DeleteAsync(user, saved.Id, Ct));
        Assert.Empty(await _repo.ListForBookAsync(user, book, null, Ct));
    }

    [Fact]
    public async Task MoveChapterSlugsAsync_SwapsSlugs_AcrossReaders_InTheTransaction()
    {
        var (alice, book) = await db.NewReaderWithBookAsync();
        var (bob, _) = await db.NewReaderWithBookAsync();
        var a1 = (await _repo.SaveAsync(Insight(alice, book, "1-a"), Ct))!;
        var a2 = (await _repo.SaveAsync(Insight(alice, book, "2-b"), Ct))!;
        await _repo.SaveAsync(Insight(bob, book, "1-a"), Ct);
        await _repo.SaveAsync(Insight(bob, book, null), Ct); // book-level: not a chapter insight
        await using var ef = db.NewDbContext();

        await using var tx = await ef.BeginTransactionAsync(Ct);
        var all = await _repo.ListAllReadersChapterInsightsAsync(book, null, tx, Ct);
        Assert.Equal(3, all.Count);
        // A swap: without parking, the first UPDATE row would hit the unique key.
        await _repo.MoveChapterSlugsAsync([(a1.Id, "2-b"), (a2.Id, "1-a")], tx, Ct);
        await tx.CommitAsync(Ct);

        var slugs = (await _repo.ListForBookAsync(alice, book, null, Ct)).ToDictionary(i => i.Id, i => i.ChapterSlug);
        Assert.Equal("2-b", slugs[a1.Id]);
        Assert.Equal("1-a", slugs[a2.Id]);
    }
}
