using Api.Endpoints;
using Application.Agents;
using Domain.Entities;

namespace TextStack.UnitTests;

/// <summary>
/// <c>TutorEndpoints.ShapeExercise</c> — the step #606 added so the calibrated exercise type becomes
/// the card the learner actually gets. Nothing covered it: the PR's own tests are
/// <c>McOptionsTests</c> (the option builder) and <c>TutorEndpointsReplanTests</c> (the re-plan
/// backstops), and neither touches this function.
///
/// <para>One test here is <b>characterization</b> of a defect, named for it. See its docblock.</para>
/// </summary>
public class TutorShapeExerciseTests
{
    private static VocabularyWord Word(
        string word = "latency",
        string language = "en",
        string? translation = null,
        string? definition = null,
        string? sentence = null,
        string? distractors = null) =>
        new()
        {
            Id = Guid.NewGuid(),
            UserId = Guid.NewGuid(),
            SiteId = Guid.NewGuid(),
            Word = word,
            Language = language,
            Translation = translation,
            Definition = definition,
            Sentence = sentence,
            Distractors = distractors,
        };

    [Fact]
    public void ShapeExercise_Recall_CarriesNoOptions_SoTheLearnerGradesThemselves()
    {
        var card = Word(translation: "затримка", sentence: "The latency was unbearable.");

        var (options, correctIndex, blank) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseRecall, card, [card]);

        Assert.Null(options);
        Assert.Null(correctIndex);
        Assert.Null(blank);
    }

    [Fact]
    public void ShapeExercise_Recognition_HasFourOptionsAndNoCloze()
    {
        var card = Word(translation: "затримка", sentence: "The latency was unbearable.");

        var (options, correctIndex, blank) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseRecognition, card, [card]);

        Assert.NotNull(options);
        Assert.Equal(4, options!.Count);
        Assert.Equal("latency", options[correctIndex!.Value]);
        // A recognition card is the definition/translation plus four choices — deliberately not the
        // sentence, which is what makes `context` a different exercise.
        Assert.Null(blank);
    }

    [Fact]
    public void ShapeExercise_Context_BlanksTheWordOutOfTheSavedSentence()
    {
        var card = Word(translation: "затримка", sentence: "The latency was unbearable.");

        var (options, _, blank) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseContext, card, [card]);

        Assert.NotNull(options);
        Assert.NotNull(blank);
        Assert.DoesNotContain("latency", blank!, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The documented degradation: <c>CalibrateForStage</c> is supposed to make this unreachable, but
    /// if a context exercise arrives without a sentence it must become a plain four-option card
    /// rather than a cloze with nothing in it.
    /// </summary>
    [Fact]
    public void ShapeExercise_ContextWithNoSentence_DegradesToAPlainFourOptionCard()
    {
        var card = Word(translation: "затримка", sentence: null);

        var (options, correctIndex, blank) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseContext, card, [card]);

        Assert.NotNull(options);
        Assert.Equal(4, options!.Count);
        Assert.Equal("latency", options[correctIndex!.Value]);
        Assert.Null(blank);
    }

    /// <summary>
    /// The session's other words are the distractor pool, and the card itself is excluded from it —
    /// otherwise the answer could be offered twice.
    /// </summary>
    [Fact]
    public void ShapeExercise_UsesTheOtherSessionWordsAsDistractors_AndNeverTheCardItself()
    {
        var card = Word();
        var others = new[]
        {
            Word("throughput"), Word("backpressure"), Word("jitter"),
        };
        var session = new List<VocabularyWord> { card };
        session.AddRange(others);

        var (options, correctIndex, _) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseRecognition, card, session);

        Assert.NotNull(options);
        Assert.Single(options!.Where(o => o.Equals("latency", StringComparison.OrdinalIgnoreCase)));
        Assert.Equal("latency", options[correctIndex!.Value]);
        // The learner's own words beat the hardcoded filler list.
        Assert.All(options.Where((_, i) => i != correctIndex.Value),
            o => Assert.Contains(o, new[] { "throughput", "backpressure", "jitter" }));
    }

    /// <summary>
    /// <b>DEFECT (characterized, not fixed).</b> A <c>recognition</c> card is four options and a
    /// prompt, and the prompt is built client-side as
    /// <c>blankSentence || definition || translation</c> (<c>MultipleChoiceCard.tsx</c>, both
    /// clients). <c>recognition</c> has no <c>blankSentence</c> by design. So a vocabulary row saved
    /// with neither a translation nor a definition — which the save endpoint permits; only
    /// <c>word</c>, <c>language</c> and <c>nativeLanguage</c> are required — reaches the learner as
    /// four words and <b>no question at all</b> on web, and as <b>the answer printed above its own
    /// options</b> on mobile, whose cascade has a fourth fallback of <c>card.word</c>.
    ///
    /// <para>Before #606 the Tutor always drew a <c>FlashCard</c>, which shows the word and asks the
    /// learner to grade themselves — so it had no prompt to lose. Routing the plan through the MC
    /// component is what exposed this.</para>
    ///
    /// <para>Reproduced live against a running API on 2026-09-12:
    /// <c>POST /me/vocabulary/words {"word":"perspicacious","language":"en","nativeLanguage":"uk"}</c>
    /// then <c>GET /me/vocabulary/review</c> returns
    /// <c>blankSentence:null, definition:null, translation:null, options:[…4…]</c>.</para>
    ///
    /// <para>When fixed — by refusing to shape an MC exercise with no prompt source and falling back
    /// to <c>recall</c> — this test should assert <c>Assert.Null(options)</c>.</para>
    /// </summary>
    [Fact]
    public void ShapeExercise_RecognitionWithNoTranslationOrDefinition_StillBuildsAPromptlessCard()
    {
        var card = Word(translation: null, definition: null, sentence: null);

        var (options, _, blank) =
            TutorEndpoints.ShapeExercise(TutorPlanItem.ExerciseRecognition, card, [card]);

        Assert.NotNull(options);
        Assert.Equal(4, options!.Count);

        // Everything a client could render as the question:
        Assert.Null(blank);
        Assert.Null(card.Definition);
        Assert.Null(card.Translation);
    }
}
