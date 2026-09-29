using System.Text.Json;
using Application.ChapterReview;
using Contracts.ChapterReview;

namespace TextStack.UnitTests.ChapterReview;

public class ChapterReviewValidatorTests
{
    private static readonly Guid TargetHighlight = Guid.NewGuid();
    private static readonly Guid EarlierHighlight = Guid.NewGuid();
    private static readonly Guid LaterHighlight = Guid.NewGuid();
    private static readonly Guid UnplacedHighlight = Guid.NewGuid();

    private static ReviewValidationContext Ctx(bool chapterHasHighlights = true, params OpenThreadDto[] open) => new(
        TargetChapterNumber: 5,
        BookHighlights: new Dictionary<Guid, int?>
        {
            [TargetHighlight] = 5, [EarlierHighlight] = 2, [LaterHighlight] = 7, [UnplacedHighlight] = null,
        },
        TargetHighlightIds: chapterHasHighlights ? new HashSet<Guid> { TargetHighlight } : new HashSet<Guid>(),
        OpenThreads: open);

    private static ReviewBlockInput Block(int i, params string?[] highlightIds) => new(
        $"Idea {i}", $"A concrete problem {i}", $"Root cause {i}", $"Rule {i}",
        highlightIds, new ReviewQuestionInput($"Question {i}?", $"Answer {i}"));

    private static ChapterReviewInput Valid(string? recall = null) => new(
        recall,
        [Block(0, TargetHighlight.ToString()), Block(1), Block(2, EarlierHighlight.ToString())],
        ["At work"],
        [new ReviewThreadInput("What about leaderless?")],
        []);

    private static List<string> Codes(IReadOnlyList<ReviewFieldErrorDto> errors) => errors.Select(e => e.Code).ToList();

    [Fact]
    public void Validate_ValidReview_NoErrors()
    {
        Assert.Empty(ChapterReviewValidator.Validate(Valid(), Ctx()));
    }

    [Fact]
    public void Validate_ManyProblems_ReturnsEveryOneWithItsPath()
    {
        // The point of the validator: one refusal lists everything, so the model fixes it in one retry.
        var review = new ChapterReviewInput(
            null,
            [
                new ReviewBlockInput("", "p", "line one\nline two", "r", [], new ReviewQuestionInput("Q?", "A")),
                Block(1, Guid.NewGuid().ToString()),
            ],
            [],
            null,
            ["t_nope"]);

        var errors = ChapterReviewValidator.Validate(review, Ctx());

        Assert.Contains(errors, e => e is { Path: "blocks", Code: "count" });
        Assert.Contains(errors, e => e is { Path: "blocks[0].title", Code: "required" });
        Assert.Contains(errors, e => e is { Path: "blocks[0].rootCause", Code: "multiline" });
        Assert.Contains(errors, e => e is { Path: "blocks[1].highlightIds[0]", Code: "unknown_highlight" });
        Assert.Contains(errors, e => e is { Path: "blocks", Code: "highlight_required" });
        Assert.Contains(errors, e => e is { Path: "applications", Code: "count" });
        Assert.Contains(errors, e => e is { Path: "closedThreadIds[0]", Code: "unknown_thread" });
        Assert.Equal(7, errors.Count);
    }

    [Fact]
    public void Validate_MissingCollections_Required()
    {
        var errors = ChapterReviewValidator.Validate(new ChapterReviewInput(null, null, null, null, null), Ctx());

        Assert.Contains(errors, e => e is { Path: "blocks", Code: "required" });
        Assert.Contains(errors, e => e is { Path: "applications", Code: "required" });
    }

    [Theory]
    [InlineData(2)]
    [InlineData(7)]
    public void Validate_BlockCountOutOfRange_Count(int n)
    {
        var blocks = Enumerable.Range(0, n).Select(i => Block(i, TargetHighlight.ToString())).ToList();
        var errors = ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx());

        Assert.Equal(["count"], Codes(errors));
    }

    [Fact]
    public void Validate_FieldTooLong_TooLong()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[1] = blocks[1]! with { Problem = new string('x', 1201) };

        var errors = ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx());

        Assert.Equal("blocks[1].problem", Assert.Single(errors).Path);
        Assert.Equal("too_long", errors[0].Code);
    }

    [Fact]
    public void Validate_RuleMultiline_Multiline()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[2] = blocks[2]! with { Rule = "first\nsecond" };

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx()));

        Assert.Equal(("blocks[2].rule", "multiline"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_HighlightInLaterChapter_HighlightBeyondChapter()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[1] = Block(1, LaterHighlight.ToString());

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx()));

        Assert.Equal(("blocks[1].highlightIds[0]", "highlight_beyond_chapter"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_UnplaceableAndMalformedHighlightIds_UnplacedAllowedMalformedUnknown()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[1] = Block(1, UnplacedHighlight.ToString(), "not-a-guid");

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx()));

        Assert.Equal(("blocks[1].highlightIds[1]", "unknown_highlight"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_ChapterHasHighlightsButOnlyEarlierOnesUsed_HighlightRequired()
    {
        var blocks = new List<ReviewBlockInput?> { Block(0, EarlierHighlight.ToString()), Block(1), Block(2) };

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx()));

        Assert.Equal(("blocks", "highlight_required"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_NoHighlightsInChapterAndNoRecall_RecallRequired()
    {
        var error = Assert.Single(ChapterReviewValidator.Validate(Valid(recall: null), Ctx(chapterHasHighlights: false)));

        Assert.Equal(("recall", "recall_required"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_NoHighlightsInChapterShortRecall_TooShort()
    {
        var error = Assert.Single(ChapterReviewValidator.Validate(Valid(recall: "leaders"), Ctx(chapterHasHighlights: false)));

        Assert.Equal(("recall", "too_short"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_NoHighlightsInChapterWithRecall_NoHighlightRequirement()
    {
        var recall = "I remember that followers apply the leader's log in the same order.";
        var blocks = new List<ReviewBlockInput?> { Block(0), Block(1), Block(2) };

        Assert.Empty(ChapterReviewValidator.Validate(new ChapterReviewInput(recall, blocks, ["x"], null, null), Ctx(chapterHasHighlights: false)));
    }

    [Fact]
    public void Validate_DuplicatePromptIgnoringCaseAndSpace_DuplicateQuestion()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[2] = blocks[2]! with { Question = new ReviewQuestionInput("  question   0? ", "x") };

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx()));

        Assert.Equal(("blocks[2].question.prompt", "duplicate_question"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_ClosingAnOpenThread_Accepted_UnknownOneListsTheValidIds()
    {
        var open = new OpenThreadDto("t_1234abcd", "why quorums?", "Replication");
        var ok = Valid() with { ClosedThreadIds = ["t_1234abcd"] };
        var bad = Valid() with { ClosedThreadIds = ["t_00000000"] };

        Assert.Empty(ChapterReviewValidator.Validate(ok, Ctx(true, open)));
        var error = Assert.Single(ChapterReviewValidator.Validate(bad, Ctx(true, open)));
        Assert.Equal("unknown_thread", error.Code);
        Assert.Contains("t_1234abcd", error.Message);
    }

    [Fact]
    public void Validate_TooManyThreads_Count()
    {
        var threads = Enumerable.Range(0, 11).Select(i => (ReviewThreadInput?)new ReviewThreadInput($"t{i}")).ToList();

        var error = Assert.Single(ChapterReviewValidator.Validate(Valid() with { OpenThreads = threads }, Ctx()));

        Assert.Equal(("openThreads", "count"), (error.Path, error.Code));
    }

    [Fact]
    public void Validate_SerializedOver40k_TooLarge()
    {
        var blocks = Valid().Blocks!.ToList();
        blocks[1] = blocks[1]! with { Problem = new string('p', 45_000) };

        var errors = ChapterReviewValidator.Validate(Valid() with { Blocks = blocks }, Ctx());

        Assert.Contains(errors, e => e is { Path: "review", Code: "too_large" });
    }

    [Fact]
    public void Validate_NonLatinTextAtEveryLimit_NotTooLarge()
    {
        // Measured unescaped: a Cyrillic review must not count six characters per letter.
        var blocks = Enumerable.Range(0, 6)
            .Select(i => (ReviewBlockInput?)new ReviewBlockInput(
                new string('т', 120), new string('п', 1200), new string('к', 300), new string('п', 300),
                [TargetHighlight.ToString()], new ReviewQuestionInput(i + new string('в', 499), new string('о', 1500))))
            .ToList();
        var review = new ChapterReviewInput(new string('з', 3000), blocks,
            Enumerable.Range(0, 5).Select(_ => (string?)new string('д', 400)).ToList(), null, null);

        Assert.Empty(ChapterReviewValidator.Validate(review, Ctx()));
    }

    [Fact]
    public void Parse_UnknownProperty_UnknownPropertyAtItsPath()
    {
        var json = JsonDocument.Parse("""{ "blocks": [ { "title": "x", "summary": "y" } ], "applications": [] }""").RootElement;

        var (input, error) = ChapterReviewValidator.Parse(json);

        Assert.Null(input);
        Assert.Equal("unknown_property", error!.Code);
        Assert.StartsWith("review.blocks[0]", error.Path);
    }

    [Fact]
    public void Parse_WrongType_InvalidJson()
    {
        var json = JsonDocument.Parse("""{ "blocks": "three", "applications": [] }""").RootElement;

        var (_, error) = ChapterReviewValidator.Parse(json);

        Assert.Equal("invalid_json", error!.Code);
        Assert.Equal("review.blocks", error.Path);
    }

    [Fact]
    public void Parse_Missing_Required()
    {
        var (_, error) = ChapterReviewValidator.Parse(default);

        Assert.Equal(("review", "required"), (error!.Path, error.Code));
    }

    [Fact]
    public void Parse_CamelCase_Deserializes()
    {
        var json = JsonDocument.Parse(
            """{ "recall": "r", "blocks": [ { "title": "t", "rootCause": "c", "highlightIds": ["a"], "question": { "prompt": "p", "answer": "a" } } ], "applications": ["x"], "closedThreadIds": [] }""")
            .RootElement;

        var (input, error) = ChapterReviewValidator.Parse(json);

        Assert.Null(error);
        Assert.Equal("c", input!.Blocks![0]!.RootCause);
        Assert.Equal("p", input.Blocks[0]!.Question!.Prompt);
    }
}
