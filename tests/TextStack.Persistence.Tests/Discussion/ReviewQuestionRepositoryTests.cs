using Application.Discussion;
using Domain.Discussion;
using Infrastructure.Persistence.Repositories;
using static TextStack.Persistence.Tests.V2PostgresFixture;

namespace TextStack.Persistence.Tests.Discussion;

public class ReviewQuestionRepositoryTests(V2PostgresFixture db)
{
    private readonly ReviewQuestionRepository _repo = new(db.DataSource);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DateTimeOffset Now = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);

    /// <summary>A fresh user's chapter review: the insight the questions hang on.</summary>
    private async Task<BookInsight> ReviewAsync()
    {
        var book = await db.NewReaderWithBookAsync();
        return await new V2InsightRepository(db.DataSource).SaveReviewAsync(NewInsight(book, "ch-1", "review", "{}"), Ct);
    }

    /// <summary>A new question, due <paramref name="dueInDays"/> from <see cref="Now"/>.</summary>
    private static ReviewQuestion Question(string hash, string prompt = "Why?", int block = 0, double dueInDays = 0) => new()
    {
        Id = Guid.NewGuid(),
        BlockIndex = block,
        Prompt = prompt,
        Answer = "Because.",
        PromptHash = hash,
        NextReviewAt = Now.AddDays(dueInDays),
    };

    private static ReviewSchedule Answered(int stage, bool retired = false) =>
        new(stage, 4, 2, Now.AddDays(4), Now, 3, 2, retired);

    [Fact]
    public async Task ReplaceForInsightAsync_NewQuestions_InsertsThemUnderTheInsightWithNoAnswersYet()
    {
        var insight = await ReviewAsync();
        var question = Question("aaaa", dueInDays: -1);

        Assert.True(await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [question], Ct));

        var stored = (await _repo.GetAsync(insight.UserId, question.Id, Ct))!;
        Assert.Equal((insight.UserId, insight.Id, "Why?", "Because.", "aaaa", Now.AddDays(-1)),
            (stored.UserId, stored.BookInsightId, stored.Prompt, stored.Answer, stored.PromptHash, stored.NextReviewAt));
        Assert.Equal((0, 0, (DateTimeOffset?)null, false),
            (stored.TotalReviews, stored.CorrectReviews, stored.LastReviewedAt, stored.IsRetired));
    }

    [Fact]
    public async Task ReplaceForInsightAsync_OneUnchangedOneNewOneGone_KeepsTheUnchangedSchedule()
    {
        var insight = await ReviewAsync();
        var kept = Question("kept");
        var gone = Question("gone");
        await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [kept, gone], Ct);
        await _repo.RecordAnswerAsync(insight.UserId, kept.Id, Answered(stage: 3), Ct);
        var added = Question("new", block: 0);

        await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id,
            [added, Question("kept", prompt: "Why, exactly?", block: 1)], Ct);

        var stored = (await _repo.GetAsync(insight.UserId, kept.Id, Ct))!;
        Assert.Equal(("Why, exactly?", 1), (stored.Prompt, stored.BlockIndex));
        Assert.Equal((3, Now.AddDays(4), 3), (stored.Stage, stored.NextReviewAt, stored.TotalReviews));
        Assert.Null(await _repo.GetAsync(insight.UserId, gone.Id, Ct));
        Assert.NotNull(await _repo.GetAsync(insight.UserId, added.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForInsightAsync_EmptySet_DeletesThemAll()
    {
        var insight = await ReviewAsync();
        var question = Question("aaaa");
        await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [question], Ct);

        Assert.True(await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [], Ct));

        Assert.Null(await _repo.GetAsync(insight.UserId, question.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForInsightAsync_OneOfTwoReviews_LeavesTheOtherReviewsQuestions()
    {
        var one = await ReviewAsync();
        var two = await new V2InsightRepository(db.DataSource).SaveReviewAsync(new BookInsight
        {
            Id = Guid.NewGuid(),
            UserId = one.UserId,
            BookId = one.BookId,
            ChapterSlug = "ch-2",
            Text = "review",
            ReviewJson = "{}",
        }, Ct);
        var ones = Question("aaaa");
        await _repo.ReplaceForInsightAsync(one.UserId, one.Id, [ones], Ct);

        await _repo.ReplaceForInsightAsync(two.UserId, two.Id, [Question("bbbb")], Ct);

        Assert.NotNull(await _repo.GetAsync(one.UserId, ones.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForInsightAsync_TwoAtOnceWithSharedHashesInOppositeOrder_BothSucceedAndOneSetWins()
    {
        // Unserialized, these deadlock (40P01) on the two shared hashes, or leave the union of both sets.
        for (var i = 0; i < 4; i++)
        {
            var insight = await ReviewAsync();
            string[] first = ["aaaa", "bbbb", "xxxx"], second = ["bbbb", "aaaa", "yyyy"];

            var results = await Task.WhenAll(
                Task.Run(() => _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, first.Select(h => Question(h)).ToList(), Ct), Ct),
                Task.Run(() => _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, second.Select(h => Question(h)).ToList(), Ct), Ct));

            Assert.Equal([true, true], results);
            var stored = (await _repo.ListDueAsync(insight.UserId, Now.AddDays(1), 10, Ct)).Questions
                .Select(q => q.PromptHash).Order().ToArray();
            Assert.True(stored.SequenceEqual(first.Order()) || stored.SequenceEqual(second.Order()), string.Join(",", stored));
        }
    }

    [Fact]
    public async Task ListDueAsync_LimitBelowOne_Throws()
    {
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => _repo.ListDueAsync(Guid.NewGuid(), Now, 0, Ct));
    }

    [Fact]
    public async Task ListDueAsync_MixedQuestions_ReturnsDueNotRetiredMostOverdueFirstAndTheTotal()
    {
        var insight = await ReviewAsync();
        var overdue = Question("a", dueInDays: -3);
        var due = Question("b", dueInDays: -1);
        var alsoDue = Question("c", dueInDays: 0);
        var retired = Question("d", dueInDays: -5);
        var later = Question("e", dueInDays: 1);
        await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [due, later, alsoDue, retired, overdue], Ct);
        // Retired, but due: the schedule stays in the past.
        await _repo.RecordAnswerAsync(insight.UserId, retired.Id, Answered(stage: 6, retired: true) with { NextReviewAt = Now.AddDays(-5) }, Ct);

        var page = await _repo.ListDueAsync(insight.UserId, Now, 2, Ct);

        Assert.Equal(3, page.Total);
        Assert.Equal([overdue.Id, due.Id], page.Questions.Select(q => q.Id));
    }

    [Fact]
    public async Task RecordAnswerAsync_OwnQuestion_StoresTheScheduleAndReturnsIt()
    {
        var insight = await ReviewAsync();
        var question = Question("aaaa");
        await _repo.ReplaceForInsightAsync(insight.UserId, insight.Id, [question], Ct);

        var answered = (await _repo.RecordAnswerAsync(insight.UserId, question.Id, Answered(stage: 2, retired: true), Ct))!;

        Assert.Equal((2, 4.0, 2, Now.AddDays(4), (DateTimeOffset?)Now, 3, 2, true),
            (answered.Stage, answered.IntervalDays, answered.ConsecutiveCorrect, answered.NextReviewAt,
                answered.LastReviewedAt, answered.TotalReviews, answered.CorrectReviews, answered.IsRetired));
        Assert.Equal(answered.Stage, (await _repo.GetAsync(insight.UserId, question.Id, Ct))!.Stage);
    }

    // Owner isolation, one test per method: bob, holding alice's ids, never reads, changes or deletes her rows.

    [Fact]
    public async Task ListDueAsync_AsBob_SeesNoneOfAlicesQuestions()
    {
        var alices = await ReviewAsync();
        var bob = await db.NewReaderAsync();
        await _repo.ReplaceForInsightAsync(alices.UserId, alices.Id, [Question("aaaa", dueInDays: -1)], Ct);

        var page = await _repo.ListDueAsync(bob, Now, 10, Ct);

        Assert.Equal((0, 0), (page.Total, page.Questions.Count));
    }

    [Fact]
    public async Task GetAsync_AlicesQuestionAsBob_ReturnsNull()
    {
        var alices = await ReviewAsync();
        var bob = await db.NewReaderAsync();
        var hers = Question("aaaa");
        await _repo.ReplaceForInsightAsync(alices.UserId, alices.Id, [hers], Ct);

        Assert.Null(await _repo.GetAsync(bob, hers.Id, Ct));
    }

    [Fact]
    public async Task ReplaceForInsightAsync_AlicesInsightAsBob_ReturnsFalseAndLeavesHerQuestions()
    {
        var alices = await ReviewAsync();
        var bob = await db.NewReaderAsync();
        var hers = Question("aaaa");
        await _repo.ReplaceForInsightAsync(alices.UserId, alices.Id, [hers], Ct);

        // The same prompt hash: past the FK, it would take the ON CONFLICT update path into her row.
        Assert.False(await _repo.ReplaceForInsightAsync(bob, alices.Id, [Question("aaaa", prompt: "bob's")], Ct));

        Assert.Equal("Why?", (await _repo.GetAsync(alices.UserId, hers.Id, Ct))!.Prompt);
    }

    [Fact]
    public async Task RecordAnswerAsync_AlicesQuestionAsBob_ReturnsNullAndChangesNothing()
    {
        var alices = await ReviewAsync();
        var bob = await db.NewReaderAsync();
        var hers = Question("aaaa");
        await _repo.ReplaceForInsightAsync(alices.UserId, alices.Id, [hers], Ct);

        Assert.Null(await _repo.RecordAnswerAsync(bob, hers.Id, Answered(stage: 5), Ct));
        Assert.Equal(0, (await _repo.GetAsync(alices.UserId, hers.Id, Ct))!.Stage);
    }
}
