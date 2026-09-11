using TextStack.Vocabulary;
using TextStack.Vocabulary.Contracts;

namespace TextStack.UnitTests;

/// <summary>
/// The four choices on a multiple-choice card.
///
/// <para>This lived twice inside <c>ReviewCardBuilder</c> — once for <c>multiple_choice</c>, once for
/// <c>context</c> — and had no tests at all. It now has one home and three callers (review, context
/// cloze, and the Tutor), which is exactly when a rule about what a learner is shown needs pinning
/// down.</para>
/// </summary>
public class McOptionsTests
{
    private static readonly string[] Llm = ["quorum", "replica", "partition", "consensus"];
    private static string Json(params string[] words) => System.Text.Json.JsonSerializer.Serialize(words);

    [Fact]
    public void Build_AlwaysOffersFour_WithTheAnswerAmongThem()
    {
        var (options, correct) = McOptions.Build("latency", "en", Json(Llm), []);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("latency", options[correct]);
    }

    [Fact]
    public void Build_NeverRepeatsTheAnswerAsADistractor()
    {
        // A duplicate makes one option provably right without knowing the word — and on a card that
        // shows the answer twice, the learner has been told.
        var (options, _) = McOptions.Build("quorum", "en", Json("quorum", "QUORUM", "replica", "partition"), []);

        Assert.Single(options.Where(o => o.Equals("quorum", StringComparison.OrdinalIgnoreCase)));
    }

    [Fact]
    public void Build_FallsBackToTheLearnersOwnWords_WhenTheLlmGaveTooFew()
    {
        // A distractor the learner has actually met is a real choice; a hardcoded filler is a
        // giveaway. So their own vocabulary comes before the built-in list.
        var pool = new List<DistractorPoolEntry>
        {
            new("replication", "en"), new("sharding", "en"), new("consensus", "en"),
            new("Wasser", "de"),
        };

        var (options, correct) = McOptions.Build("latency", "en", Json("only-one"), pool);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("latency", options[correct]);
        // The German word is in the pool but not in this card's language.
        Assert.DoesNotContain("Wasser", options);
    }

    [Fact]
    public void Build_StillProducesFour_WithNoDistractorsAnywhere()
    {
        // The last resort exists so a card is never short of options: three choices would itself
        // tell the learner something.
        var (options, correct) = McOptions.Build("latency", "en", null, []);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("latency", options[correct]);
    }

    [Fact]
    public void ParseDistractors_DropsGenerationNoise()
    {
        // A single letter or a string with no letters reads as a bug on screen, not as a wrong answer.
        var parsed = McOptions.ParseDistractors(Json("a", "42", "!!", "replica"));

        Assert.Equal(["replica"], parsed);
    }

    [Fact]
    public void ParseDistractors_MalformedJson_IsNotAnError()
    {
        // The column is written by an LLM at save time. It failing must cost the card its distractors,
        // never the review.
        Assert.Null(McOptions.ParseDistractors("{not json"));
        Assert.Null(McOptions.ParseDistractors(null));
    }
}
