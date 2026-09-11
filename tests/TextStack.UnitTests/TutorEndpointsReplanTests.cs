using Api.Endpoints;
using Application.Agents;
using Domain.Entities;

namespace TextStack.UnitTests;

/// <summary>
/// AI-Agent-2 re-plan correctness backstops (the pure, deterministic parts of <c>SubmitFeedback</c>, not
/// LLM-trusted):
/// <list type="bullet">
/// <item><b>CountPlanItems</b> — reads the Web-serialized camelCase "items" so the re-plan keeps the session's
///   original size (the casing bug made it silently fall back to the default 5).</item>
/// <item><b>PriorPlanWordIds</b> — feedback for an id NOT in the prior plan is ignored (a client can't steer
///   the re-plan with ids it was never shown).</item>
/// <item><b>DropPassedCards</b> — a card the learner just answered correctly can never re-surface this turn,
///   regardless of what the model planned.</item>
/// </list>
/// </summary>
public class TutorEndpointsReplanTests
{
    private static readonly Guid A = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid B = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly Guid C = Guid.Parse("33333333-3333-3333-3333-333333333333");

    private static TutorPlanItem Item(Guid id) =>
        new(id, "w", Stage: 1, TutorPlanItem.ExerciseRecognition, TutorPlanItem.DifficultyEasy, "why");

    private static TutorPlan PlanOf(params Guid[] ids) =>
        new(ids.Select(Item).ToList(), "rationale", "keep reading");

    // ---- FIX 2: CountPlanItems reads camelCase "items" ----------------------------------------------

    [Fact]
    public void CountPlanItems_WebSerializedThreeItemPlan_ReturnsThreeNotFallback()
    {
        // A 3-item plan serialized exactly as the endpoint persists it (Web defaults → "items").
        var json = PlanOf(A, B, C).ToPlanJson();

        var count = TutorEndpoints.CountPlanItems(json, fallback: 5);

        Assert.Equal(3, count); // not the default 5 — the casing bug used to make this always fall back
    }

    [Fact]
    public void CountPlanItems_MalformedJson_ReturnsFallback()
    {
        Assert.Equal(5, TutorEndpoints.CountPlanItems("not json", fallback: 5));
    }

    // ---- FIX 3b: feedback for an id not in the prior plan is dropped --------------------------------

    [Fact]
    public void PriorPlanWordIds_WebSerializedPlan_ExtractsItemIds()
    {
        var ids = TutorEndpoints.PriorPlanWordIds(PlanOf(A, B).ToPlanJson());

        Assert.Equal(new HashSet<Guid> { A, B }, ids);
    }

    [Fact]
    public void PriorPlanWordIds_FeedbackFilteredToPriorPlan_DropsUnknownId()
    {
        var prior = TutorEndpoints.PriorPlanWordIds(PlanOf(A, B).ToPlanJson());

        // Client submits feedback for A (in plan) and C (never shown) — only A survives the filter.
        var raw = new[]
        {
            new TutorFeedbackItem(A, Correct: true, 800),
            new TutorFeedbackItem(C, Correct: false, 5000), // arbitrary id, not in prior plan
        };
        var kept = raw.Where(f => prior.Contains(f.WordId)).ToList();

        var item = Assert.Single(kept);
        Assert.Equal(A, item.WordId);
    }

    // ---- FIX 3a: a just-passed card never re-surfaces in the re-plan --------------------------------

    [Fact]
    public void DropPassedCards_ItemAnsweredCorrectly_IsRemovedFromReplan()
    {
        // The model re-planned A (which the learner just PASSED) and B — A must be dropped.
        var replanned = PlanOf(A, B);
        var feedback = new[] { new TutorFeedbackItem(A, Correct: true, 800) };

        var result = TutorEndpoints.DropPassedCards(replanned, feedback);

        var item = Assert.Single(result.Items);
        Assert.Equal(B, item.WordId); // A dropped; the missed/other card stays
    }

    [Fact]
    public void DropPassedCards_MissedCard_IsKept()
    {
        var replanned = PlanOf(A);
        var feedback = new[] { new TutorFeedbackItem(A, Correct: false, 5000) };

        var result = TutorEndpoints.DropPassedCards(replanned, feedback);

        Assert.Single(result.Items); // a missed card is allowed to re-surface
    }

    // ---- FIX 1: enrich plan items from the caller's REAL vocab rows ---------------------------------

    private static VocabularyWord Card(Guid id, string? distractorsJson = null) => new()
    {
        Id = id,
        UserId = Guid.NewGuid(),
        SiteId = Guid.NewGuid(),
        Word = "alacrity",
        Language = "en",
        Translation = "жвавість",
        Definition = "brisk and cheerful readiness",
        Sentence = "She accepted with alacrity.",
        BookTitle = "Pride and Prejudice",
        Hint = "eager willingness",
        Distractors = distractorsJson,
    };

    [Fact]
    public void EnrichPlanItems_MatchingCard_PopulatesRenderFieldsFromRow()
    {
        var plan = PlanOf(A);
        var rows = new[] { Card(A, "[\"sloth\",\"reluctance\",\"delay\"]") };

        var dtos = TutorEndpoints.EnrichPlanItems(plan, rows);

        var dto = Assert.Single(dtos);
        Assert.Equal(A, dto.WordId);
        Assert.Equal("жвавість", dto.Translation);
        Assert.Equal("brisk and cheerful readiness", dto.Definition);
        Assert.Equal("She accepted with alacrity.", dto.Sentence);
        Assert.Equal("Pride and Prejudice", dto.BookTitle);
        Assert.Equal("eager willingness", dto.Hint);
        Assert.Equal(new[] { "sloth", "reluctance", "delay" }, dto.Distractors);
        // The planning fields are preserved alongside the render fields.
        Assert.Equal(TutorPlanItem.ExerciseRecognition, dto.ExerciseType);
        Assert.Equal("why", dto.Why);
    }

    [Fact]
    public void EnrichPlanItems_PlanIdNotInCallerCards_IsDroppedNotNullEnriched()
    {
        // Plan has A and B; only A is one of the caller's real cards. B must be DROPPED, not emitted with nulls.
        var plan = PlanOf(A, B);
        var rows = new[] { Card(A) };

        var dtos = TutorEndpoints.EnrichPlanItems(plan, rows);

        var dto = Assert.Single(dtos);
        Assert.Equal(A, dto.WordId);
        Assert.DoesNotContain(dtos, d => d.WordId == B); // anti-hallucination re-check holds
    }

    [Fact]
    public void EnrichPlanItems_NoMatchingCards_ReturnsEmpty()
    {
        var dtos = TutorEndpoints.EnrichPlanItems(PlanOf(A), cards: []);
        Assert.Empty(dtos);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void ParseDistractors_MissingOrMalformed_ReturnsEmptyList(string? json)
    {
        Assert.Empty(TutorEndpoints.ParseDistractors(json));
    }

    [Fact]
    public void ParseDistractors_ValidArray_DropsBlankEntries()
    {
        var result = TutorEndpoints.ParseDistractors("[\"a\",\"\",\"  \",\"b\"]");
        Assert.Equal(new[] { "a", "b" }, result);
    }

    // ---- FIX 2: re-plan turns are capped so a session can't loop forever ----------------------------

    [Fact]
    public void ReachedTurnCap_BelowCap_IsFalse()
    {
        Assert.False(TutorEndpoints.ReachedTurnCap(TutorEndpoints.MaxTurns - 1));
    }

    [Fact]
    public void ReachedTurnCap_AtCap_IsTrue()
    {
        // At MaxTurns the feedback path completes the session (empty plan) instead of re-planning.
        Assert.True(TutorEndpoints.ReachedTurnCap(TutorEndpoints.MaxTurns));
        Assert.True(TutorEndpoints.ReachedTurnCap(TutorEndpoints.MaxTurns + 1));
    }

    // ---- the exercise type has to change the card, not just the badge ------------------------------

    private static TutorPlan PlanWith(string exerciseType, Guid id) =>
        new([new TutorPlanItem(id, "alacrity", 3, exerciseType, TutorPlanItem.DifficultyHard, "why")],
            "rationale", "keep reading");

    [Fact]
    public void EnrichPlanItems_Recognition_GivesFourOptionsAndNoSentencePrompt()
    {
        // "Which word means this" — options, but no cloze. The sentence still travels (the card can
        // show it after the answer); what must be absent is the BLANKED one, which would turn a
        // recognition exercise into a context one.
        var dtos = TutorEndpoints.EnrichPlanItems(
            PlanWith(TutorPlanItem.ExerciseRecognition, A),
            [Card(A, "[\"sloth\",\"reluctance\",\"delay\"]")]);

        var dto = Assert.Single(dtos);
        Assert.NotNull(dto.Options);
        Assert.Equal(4, dto.Options!.Count);
        Assert.Equal("alacrity", dto.Options[dto.CorrectOptionIndex!.Value]);
        Assert.Null(dto.BlankSentence);
    }

    [Fact]
    public void EnrichPlanItems_Recall_HasNoOptionsAtAll()
    {
        // Recall is a flashcard the learner grades themselves. Four options would make it a
        // recognition exercise wearing a recall label — easier, and mis-scored against the stage.
        var dtos = TutorEndpoints.EnrichPlanItems(
            PlanWith(TutorPlanItem.ExerciseRecall, A),
            [Card(A, "[\"sloth\",\"reluctance\",\"delay\"]")]);

        var dto = Assert.Single(dtos);
        Assert.Null(dto.Options);
        Assert.Null(dto.CorrectOptionIndex);
        Assert.Null(dto.BlankSentence);
    }

    [Fact]
    public void EnrichPlanItems_Context_BlanksTheWordOutOfItsOwnSentence()
    {
        var dtos = TutorEndpoints.EnrichPlanItems(
            PlanWith(TutorPlanItem.ExerciseContext, A),
            [Card(A, "[\"sloth\",\"reluctance\",\"delay\"]")]);

        var dto = Assert.Single(dtos);
        Assert.NotNull(dto.Options);
        Assert.Equal("alacrity", dto.Options![dto.CorrectOptionIndex!.Value]);
        Assert.NotNull(dto.BlankSentence);
        // The answer must not survive inside the prompt that asks for it.
        Assert.DoesNotContain("alacrity", dto.BlankSentence!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EnrichPlanItems_ContextWithNoSentence_DegradesToPlainOptions_NotAnEmptyCloze()
    {
        // CalibrateForStage downgrades this case to recall before it reaches here, so it should be
        // unreachable — but an empty blank with nothing around it is the one outcome that would be
        // worse than a plain card, so it is pinned rather than trusted.
        var noSentence = Card(A, "[\"sloth\",\"reluctance\",\"delay\"]");
        noSentence.Sentence = null;

        var dtos = TutorEndpoints.EnrichPlanItems(PlanWith(TutorPlanItem.ExerciseContext, A), [noSentence]);

        var dto = Assert.Single(dtos);
        Assert.NotNull(dto.Options);
        Assert.Null(dto.BlankSentence);
    }

    [Fact]
    public void EnrichPlanItems_DistractorsComeFromTheOtherCardsInTheSession()
    {
        // A distractor the learner has actually met is a real choice; a hardcoded filler is a
        // giveaway. With no LLM distractors on the row, the session's own words are the pool.
        var target = Card(A);
        var other = Card(B);
        other.Word = "sloth";

        var dtos = TutorEndpoints.EnrichPlanItems(PlanWith(TutorPlanItem.ExerciseRecognition, A), [target, other]);

        var dto = Assert.Single(dtos);
        Assert.Contains("sloth", dto.Options!);
    }
}

