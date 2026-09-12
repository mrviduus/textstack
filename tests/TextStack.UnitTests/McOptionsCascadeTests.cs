using TextStack.Vocabulary;
using TextStack.Vocabulary.Contracts;

namespace TextStack.UnitTests;

/// <summary>
/// Adversarial coverage for <see cref="McOptions"/> — the edges the extraction in #606 did not pin.
///
/// <para><c>McOptionsTests</c> covers the happy cascade (LLM → learner's own words → hardcoded list)
/// and that four options always come back with the answer among them. What it does not cover is what
/// the LAST resort actually contains, and that is where the card stops being a question.</para>
///
/// <para>Two tests here are <b>characterization</b>: they assert what the code does today, and they
/// are named for the fact that what it does today is wrong. Inverting them is part of the fix, not a
/// separate chore. They are written this way rather than as red tests so the suite stays honest about
/// its own state — see the docblock on each.</para>
/// </summary>
public class McOptionsCascadeTests
{
    private static string Json(params string[] words) => System.Text.Json.JsonSerializer.Serialize(words);

    /// <summary>
    /// <b>DEFECT (characterized, not fixed).</b> <c>DistractorWords.ForLanguage</c> has entries for
    /// en/de/fr/es and returns <b>English</b> for everything else. So a learner saving a Ukrainian,
    /// Italian or Polish word — with no LLM distractors yet (they are generated fire-and-forget
    /// AFTER the save) and an empty personal pool (their first words) — is shown their word next to
    /// three English nouns. The answer is the only option in the right alphabet: the card can be
    /// passed without knowing the word, and passing it advances the SRS stage.
    ///
    /// <para>#606 widened the blast radius: the Tutor now builds its <c>recognition</c> and
    /// <c>context</c> options through this same method, so a tutor session inherits it.</para>
    ///
    /// <para>When fixed — by returning an empty list for an unknown language and letting the caller
    /// decide, or by refusing to build an MC card at all — this assertion should become
    /// <c>Assert.DoesNotContain</c>.</para>
    /// </summary>
    [Fact]
    public void Build_LanguageWithNoDistractorList_FillsWithEnglish_SoTheAnswerIsTheOnlyNonEnglishOption()
    {
        var (options, correct) = McOptions.Build("осяжний", "uk", distractorsJson: null, pool: []);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("осяжний", options[correct]);

        var fillers = options.Where((_, i) => i != correct).ToList();
        Assert.All(fillers, f => Assert.Contains(f, DistractorWords.English));
    }

    /// <summary>
    /// The same shape stated as the property that actually matters, so the fix has something to aim
    /// at: every option should be in the card's language. Characterized as FALSE today.
    /// </summary>
    [Fact]
    public void Build_LanguageWithNoDistractorList_DoesNotProduceASameLanguageCard()
    {
        var (options, correct) = McOptions.Build("ubiquitario", "it", distractorsJson: null, pool: []);

        // Every distractor is drawn from the English list; none of them is Italian.
        var distractors = options.Where((_, i) => i != correct);
        Assert.All(distractors, d => Assert.Contains(d, DistractorWords.English));
    }

    /// <summary>
    /// The LLM gate is <c>Count &gt;= 3</c>, and the answer-filter runs AFTER it. Three distractors
    /// that are all the answer in different cases pass the gate and contribute nothing — the cascade
    /// must still fill the card rather than emit a two- or three-option one.
    /// </summary>
    [Fact]
    public void Build_LlmDistractorsAreAllTheAnswer_StillReturnsFourOptions()
    {
        var (options, correct) = McOptions.Build(
            "latency", "en", Json("latency", "LATENCY", "Latency"), pool: []);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("latency", options[correct]);
        Assert.Single(options.Where(o => o.Equals("latency", StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// A personal pool that is mostly duplicates of one word must not collapse the card. The dedupe
    /// is case-insensitive, so "Replica"/"replica" is one distractor, and the hardcoded list has to
    /// make up the difference.
    /// </summary>
    [Fact]
    public void Build_PoolIsDuplicatesOfOneWord_FillsTheRestAndRepeatsNothing()
    {
        var pool = new List<DistractorPoolEntry>
        {
            new("replica", "en"), new("Replica", "en"), new("REPLICA", "en"),
        };

        var (options, correct) = McOptions.Build("latency", "en", distractorsJson: null, pool);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("latency", options[correct]);
        Assert.Equal(options.Count, options.Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }

    /// <summary>
    /// The answer is never also a filler, even when the hardcoded list contains it verbatim. "river"
    /// is in <see cref="DistractorWords.English"/>; saving it as a vocabulary word is ordinary.
    /// </summary>
    [Fact]
    public void Build_AnswerIsItselfAHardcodedFiller_IsNotOfferedTwice()
    {
        var (options, correct) = McOptions.Build("river", "en", distractorsJson: null, pool: []);

        Assert.Equal(McOptions.Choices, options.Count);
        Assert.Equal("river", options[correct]);
        Assert.Single(options.Where(o => o.Equals("river", StringComparison.OrdinalIgnoreCase)));
    }

    /// <summary>
    /// <c>CorrectIndex</c> must index the list that is returned. Run repeatedly because the order is
    /// randomised — a single run can pass by luck on a two-element shuffle.
    /// </summary>
    [Fact]
    public void Build_CorrectIndexAlwaysPointsAtTheAnswer_AcrossManyShuffles()
    {
        for (var i = 0; i < 200; i++)
        {
            var (options, correct) = McOptions.Build(
                "latency", "en", Json("quorum", "replica", "partition", "consensus"), pool: []);

            Assert.InRange(correct, 0, options.Count - 1);
            Assert.Equal("latency", options[correct]);
        }
    }

    /// <summary>
    /// An empty-string word is not a legal vocabulary row (the save endpoint rejects it), but the
    /// builder is now called from three places and should not produce a card whose answer index is
    /// -1 if one ever reaches it.
    /// </summary>
    [Fact]
    public void Build_BlankWord_DoesNotReturnAnUnfindableCorrectIndex()
    {
        var (options, correct) = McOptions.Build("", "en", distractorsJson: null, pool: []);

        Assert.InRange(correct, 0, options.Count - 1);
        Assert.Equal("", options[correct]);
    }
}
