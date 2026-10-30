using Infrastructure.Persistence.Repositories;
using Npgsql;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

public class V2InsightRepositoryTests(V2PostgresFixture db)
{
    private readonly V2InsightRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task SaveAsync_EmptySlot_InsertsAndReadsBack()
    {
        var book = await db.NewReaderWithBookAsync();
        var insight = NewInsight(book, "ch-1");

        var saved = await _repo.SaveAsync(insight, Ct);

        Assert.Equal(insight.Id, saved!.Id);
        var row = Assert.Single(await _repo.ListForBookAsync(book.UserId, book.Id, Ct));
        Assert.Equal(("ch-1", "text", "q", "mcp", book.UserId, book.Id, (string?)null),
            (row.ChapterSlug, row.Text, row.Question, row.Source, row.UserId, row.BookId, row.ReviewJson));
    }

    [Theory]
    [InlineData("ch-1")]
    [InlineData(null)] // the book-level row: NULLS NOT DISTINCT keeps it one row too
    public async Task SaveAsync_TakenSlot_ReplacesTextKeepsIdAndCreatedAt(string? slug)
    {
        var book = await db.NewReaderWithBookAsync();
        var first = (await _repo.SaveAsync(NewInsight(book, slug, "old"), Ct))!;

        var second = (await _repo.SaveAsync(NewInsight(book, slug, "new"), Ct))!;

        Assert.Equal((first.Id, first.CreatedAt), (second.Id, second.CreatedAt));
        Assert.True(second.UpdatedAt > first.UpdatedAt);
        Assert.Equal("new", Assert.Single(await _repo.ListForBookAsync(book.UserId, book.Id, Ct)).Text);
    }

    [Fact]
    public async Task SaveAsync_TakenSlot_ReplacesTheQuestion()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.SaveAsync(NewInsight(book, "ch-1"), Ct);
        var again = NewInsight(book, "ch-1");
        again.Question = "a new question";

        Assert.Equal("a new question", (await _repo.SaveAsync(again, Ct))!.Question);
    }

    [Fact]
    public async Task SaveAsync_SlotHoldsReview_ReturnsNullAndKeepsTheReview()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.SaveReviewAsync(NewInsight(book, "ch-1", "review md", """{"v":1}"""), Ct);

        Assert.Null(await _repo.SaveAsync(NewInsight(book, "ch-1", "plain"), Ct));

        var row = Assert.Single(await _repo.ListForBookAsync(book.UserId, book.Id, Ct));
        Assert.Equal(("review md", """{"v": 1}"""), (row.Text, row.ReviewJson));
    }

    [Fact]
    public async Task SaveReviewAsync_OverPlainInsight_ReplacesItInPlace()
    {
        var book = await db.NewReaderWithBookAsync();
        var plain = (await _repo.SaveAsync(NewInsight(book, "ch-1", "plain"), Ct))!;

        var review = await _repo.SaveReviewAsync(NewInsight(book, "ch-1", "review", "{}"), Ct);

        Assert.Equal(plain.Id, review.Id);
        var row = Assert.Single(await _repo.ListForBookAsync(book.UserId, book.Id, Ct));
        Assert.Equal((plain.Id, "review", "{}"), (row.Id, row.Text, row.ReviewJson));
    }

    [Fact]
    public async Task SaveReviewAsync_NoReviewJson_ThrowsAndKeepsTheReview()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.SaveReviewAsync(NewInsight(book, "ch-1", "review", "{}"), Ct);

        await Assert.ThrowsAsync<ArgumentNullException>(() => _repo.SaveReviewAsync(NewInsight(book, "ch-1", "plain"), Ct));

        Assert.Single(await _repo.ListReviewsForBookAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task SaveReviewAsync_BookLevelSlot_ThrowsAndStoresNothing()
    {
        var book = await db.NewReaderWithBookAsync();

        await Assert.ThrowsAsync<ArgumentException>(() => _repo.SaveReviewAsync(NewInsight(book, null, "review", "{}"), Ct));

        Assert.Empty(await _repo.ListForBookAsync(book.UserId, book.Id, Ct));
    }

    [Fact]
    public async Task ListReviewsForBookAsync_MixedRows_ReturnsChapterReviewsOnly()
    {
        var book = await db.NewReaderWithBookAsync();
        await _repo.SaveAsync(NewInsight(book, "ch-1", "plain"), Ct);
        await _repo.SaveAsync(NewInsight(book, null, "book-level"), Ct);
        await _repo.SaveReviewAsync(NewInsight(book, "ch-2", "review", "{}"), Ct);

        var reviews = await _repo.ListReviewsForBookAsync(book.UserId, book.Id, Ct);

        Assert.Equal("ch-2", Assert.Single(reviews).ChapterSlug);
    }

    [Fact]
    public async Task ListByIdsAsync_OwnIdsAndUnknownOnes_ReturnsTheOwnOnes()
    {
        var book = await db.NewReaderWithBookAsync();
        var saved = (await _repo.SaveAsync(NewInsight(book, "ch-1"), Ct))!;

        Assert.Equal(saved.Id, Assert.Single(await _repo.ListByIdsAsync(book.UserId, [saved.Id, Guid.NewGuid()], Ct)).Id);
        Assert.Empty(await _repo.ListByIdsAsync(book.UserId, [], Ct));
    }

    [Fact]
    public async Task DeleteAsync_OwnInsight_RemovesIt()
    {
        var book = await db.NewReaderWithBookAsync();
        var saved = (await _repo.SaveAsync(NewInsight(book, null), Ct))!;

        Assert.True(await _repo.DeleteAsync(book.UserId, saved.Id, Ct));
        Assert.Empty(await _repo.ListForBookAsync(book.UserId, book.Id, Ct));
        Assert.False(await _repo.DeleteAsync(book.UserId, saved.Id, Ct));
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ListForBookAsync_AlicesBookAsBob_ReturnsNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.SaveAsync(NewInsight(alices, "ch-1"), Ct);

        Assert.Empty(await _repo.ListForBookAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task ListReviewsForBookAsync_AlicesBookAsBob_ReturnsNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.SaveReviewAsync(NewInsight(alices, "ch-1", "review", "{}"), Ct);

        Assert.Empty(await _repo.ListReviewsForBookAsync(bob, alices.Id, Ct));
    }

    [Fact]
    public async Task ListByIdsAsync_AlicesIdsAsBob_ReturnsNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var hers = (await _repo.SaveAsync(NewInsight(alices, "ch-1"), Ct))!;

        Assert.Empty(await _repo.ListByIdsAsync(bob, [hers.Id], Ct));
    }

    [Fact]
    public async Task SaveAsync_IntoAlicesBookAsBob_IsRefusedAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.SaveAsync(NewInsight(alices, "ch-1", "alice's"), Ct);
        var his = NewInsight(alices, "ch-1", "bob's");
        his.UserId = bob;

        // The slot key includes user_id, so bob's row could only be his own, and the book is not his.
        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveAsync(his, Ct));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        Assert.Equal("alice's", Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct)).Text);
    }

    [Fact]
    public async Task SaveReviewAsync_IntoAlicesBookAsBob_IsRefusedAndChangesNothing()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        await _repo.SaveReviewAsync(NewInsight(alices, "ch-1", "alice's", "{}"), Ct);
        var his = NewInsight(alices, "ch-1", "bob's", "{}");
        his.UserId = bob;

        var error = await Assert.ThrowsAsync<PostgresException>(() => _repo.SaveReviewAsync(his, Ct));

        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, error.SqlState);
        Assert.Equal("alice's", Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct)).Text);
    }

    [Fact]
    public async Task DeleteAsync_AlicesInsightAsBob_ReturnsFalseAndKeepsIt()
    {
        var alices = await db.NewReaderWithBookAsync();
        var bob = await db.NewReaderAsync();
        var hers = (await _repo.SaveAsync(NewInsight(alices, "ch-1"), Ct))!;

        Assert.False(await _repo.DeleteAsync(bob, hers.Id, Ct));
        Assert.Single(await _repo.ListForBookAsync(alices.UserId, alices.Id, Ct));
    }
}
