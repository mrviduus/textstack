using Application.ChapterReview;
using Domain.Entities;
using TextStack.Vocabulary;

namespace TextStack.UnitTests.ChapterReview;

public class ReviewQuestionAnswerTests
{
    private static readonly ISrsEngine Srs = new SrsEngine();
    private static readonly DateTimeOffset Now = new(2026, 9, 29, 12, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData("knew", true)]
    [InlineData("almost", false)]
    [InlineData("forgot", false)]
    public void IsCorrect_SelfAssessment_OnlyKnewIsCorrect(string assessment, bool expected)
    {
        Assert.Equal(expected, ReviewQuestionService.IsCorrect(assessment));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Knew")]
    [InlineData("easy")]
    public void IsCorrect_UnknownAssessment_Null(string? assessment)
    {
        Assert.Null(ReviewQuestionService.IsCorrect(assessment));
    }

    [Fact]
    public void Apply_NewQuestionKnew_AdvancesToStageOneDueTomorrow()
    {
        var q = new ReviewQuestion { NextReviewAt = Now };

        ReviewQuestionService.Apply(q, isCorrect: true, Srs, Now);

        Assert.Equal(1, q.Stage);
        Assert.Equal(Now.AddDays(1), q.NextReviewAt);
        Assert.Equal((1, 1), (q.TotalReviews, q.CorrectReviews));
        Assert.Equal(Now, q.LastReviewedAt);
        Assert.False(q.IsRetired);
    }

    [Fact]
    public void Apply_Forgot_DemotesAndRetriesSoon()
    {
        var q = new ReviewQuestion { Stage = 3, IntervalDays = 7, ConsecutiveCorrect = 1 };

        ReviewQuestionService.Apply(q, isCorrect: false, Srs, Now);

        Assert.Equal(2, q.Stage);
        Assert.Equal(Now.AddDays(1), q.NextReviewAt);
        Assert.Equal((1, 0), (q.TotalReviews, q.CorrectReviews));
    }

    [Fact]
    public void Apply_MasteredThirdCorrectAtLongInterval_Retires()
    {
        var q = new ReviewQuestion { Stage = 4, IntervalDays = 14, ConsecutiveCorrect = 2 };

        ReviewQuestionService.Apply(q, isCorrect: true, Srs, Now);

        Assert.Equal(4, q.Stage);
        Assert.Equal(28, q.IntervalDays);
        Assert.True(q.IsRetired);
    }
}
