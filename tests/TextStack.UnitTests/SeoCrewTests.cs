using System.Collections.Concurrent;
using Application.Agents;
using Application.Seo;
using Domain.Enums;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// AI-043 — the in-process <see cref="SeoCrew"/> (thin wrapper over the shared <see cref="FieldCrew"/> runner),
/// driven end-to-end by a deterministic fake <see cref="ILlmService"/> (routed per FeatureTag) and a recording
/// <see cref="IAgentRunWriter"/>. No network, no DB. Verifies the same fail-closed contract as AutoPublish:
/// clean critic → not flagged + edited text; blocker/unparseable critic → review; empty/below-floor editor
/// output → review; cost cap → budget_exhausted + flagged; and the run persists once through the agent_run path
/// as <c>crew.seo</c> with the editionId/authorId slot set and the 4 nested sub-agent steps.
/// </summary>
public class SeoCrewTests
{
    // ---- Fakes -------------------------------------------------------------------------------------

    private sealed class FakeLlmService(
        string research, string draft, string critic, string editor, decimal costEach = 0.001m) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            var text = request.FeatureTag switch
            {
                "crew.researcher" => research,
                "crew.drafter" => draft,
                "crew.critic" => critic,
                "crew.editor" => editor,
                _ => throw new InvalidOperationException($"Unexpected feature tag: {request.FeatureTag}"),
            };
            return Task.FromResult(new LlmResponse(
                text, [], new LlmUsage(40, 20, costEach), "fake", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    private sealed class RecordingAgentRunWriter : IAgentRunWriter
    {
        public ConcurrentBag<AgentRunRecord> Records { get; } = [];

        public Task WriteAsync(AgentRunRecord run, CancellationToken ct)
        {
            Records.Add(run);
            return Task.CompletedTask;
        }
    }

    // ---- Canned critic verdicts --------------------------------------------------------------------

    private const string CleanCritic =
        """{"scores":{"factual_accuracy":5,"tone":5,"length":5,"banned_phrases":5},"issues":[]}""";

    private const string BlockerCritic =
        """{"scores":{"factual_accuracy":2,"tone":4,"length":4,"banned_phrases":5},"issues":[{"location":"intro","severity":"blocker","fix":"remove the unsupported claim"}]}""";

    private const string GarbageCritic = "this is not json at all, sorry";

    // ---- Helpers -----------------------------------------------------------------------------------

    private static SeoCrew Build(ILlmService llm, IAgentRunWriter writer) =>
        new(new FieldCrew(
            new CrewOrchestrator(),
            new ResearcherAgent(llm),
            new DrafterAgent(llm),
            new CriticAgent(llm),
            new EditorAgent(llm),
            writer));

    // No tools registered — keep this assembly free of ITool so the tool-set assertions in StarterToolsTests are unaffected.
    private static AgentContext Ctx(Guid? entityId = null, Guid? userId = null) =>
        new(userId, entityId, Guid.NewGuid(), new ServiceCollection().BuildServiceProvider());

    // Edition.Description brief (800-char floor).
    private static ContentBrief EditionBrief => SeoBriefs.For("edition", "description", "English");

    // Author.Bio brief (600-char floor).
    private static ContentBrief AuthorBrief => SeoBriefs.For("author", "bio", "English");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // Editor output comfortably clearing both briefs' MinLength floors.
    private static readonly string CleanEditedText =
        "An edited factual encyclopedic summary. " + new string('x', SeoBriefs.EditionDescriptionMin);

    // ---- 1. Clean draft → not flagged --------------------------------------------------------------

    [Fact]
    public async Task RunField_CleanDraft_NotFlagged()
    {
        var llm = new FakeLlmService(
            research: "- born 1900\n- wrote three novels",
            draft: "A factual encyclopedic summary of the work.",
            critic: CleanCritic,
            editor: CleanEditedText);
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(EditionBrief, "Born 1900. Wrote novels.", Ctx(), Ct);

        Assert.False(result.NeedsReview);
        Assert.Equal(CleanEditedText, result.EditedText);
        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status);
        Assert.NotNull(result.Critique);
        Assert.False(result.Critique!.ParseFailed);
    }

    // ---- 2. Critic blocker → flagged ---------------------------------------------------------------

    [Fact]
    public async Task RunField_CriticBlocker_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft that overclaims.",
            critic: BlockerCritic,
            editor: CleanEditedText);
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(), Ct);

        Assert.True(result.NeedsReview);
        Assert.Equal(CrewRunRecordFactory.StatusCompleted, result.Status); // crew completed; gate flagged it
        Assert.NotNull(result.Critique);
        Assert.Contains(result.Critique!.Issues, i => i.Severity == "blocker");
    }

    // ---- 3. Critic parse failure → flagged ---------------------------------------------------------

    [Fact]
    public async Task RunField_CriticParseFailed_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft.",
            critic: GarbageCritic,
            editor: CleanEditedText);
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(), Ct);

        Assert.True(result.NeedsReview);
        Assert.NotNull(result.Critique);
        Assert.True(result.Critique!.ParseFailed); // fail-closed: unparseable critic never reads as a clean pass
    }

    // ---- 4. Empty / below-floor editor output → flagged --------------------------------------------

    [Fact]
    public async Task RunField_EmptyEditorOutput_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft.",
            critic: CleanCritic,
            editor: ""); // editor produced nothing — must NOT be auto-applied
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(), Ct);

        Assert.Equal(string.Empty, result.EditedText);
        Assert.True(result.NeedsReview);
    }

    [Fact]
    public async Task RunField_EditorOutputBelowMinLength_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft.",
            critic: CleanCritic,
            editor: "Too short to publish.");
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(), Ct);

        Assert.Equal("Too short to publish.", result.EditedText);
        Assert.True(result.NeedsReview); // below the 800-char Description floor → flagged
    }

    // ---- 5. Persistence (edition entity slot) ------------------------------------------------------

    [Fact]
    public async Task RunField_Edition_PersistsCrewSeoAgentRun()
    {
        var editionId = Guid.NewGuid();
        var llm = new FakeLlmService("- notes", "A draft.", CleanCritic, "An edited draft.");
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(editionId), Ct);

        var record = Assert.Single(writer.Records);
        Assert.Equal("crew.seo", record.Agent);
        Assert.Equal(editionId, record.EditionId); // the entity slot is set for the edition run
        Assert.Equal(result.RunId, record.Id);
        Assert.Equal("edition.description", record.Goal);
        Assert.Equal("An edited draft.", record.Output);
        Assert.Equal(CrewRunRecordFactory.StatusCompleted, record.Status);

        // The four sub-agent invocations are present as nested steps for replay.
        Assert.Equal(4, record.Steps.Count);
        Assert.All(record.Steps, s => Assert.Equal(CrewRunRecordFactory.SubAgentStepKind, s.Kind));
        Assert.Equal(["research", "draft", "critique", "edit"],
            record.Steps.Select(s => s.Payload.GetProperty("stage").GetString()));
    }

    [Fact]
    public async Task RunField_Author_PersistsCrewSeoAgentRunWithEntityId()
    {
        // The author run threads the author id through the same entity slot; goal reflects author.bio.
        var authorId = Guid.NewGuid();
        var llm = new FakeLlmService("- notes", "A draft.", CleanCritic, "An edited bio.");
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        await crew.RunFieldAsync(AuthorBrief, "source", Ctx(authorId), Ct);

        var record = Assert.Single(writer.Records);
        Assert.Equal("crew.seo", record.Agent);
        Assert.Equal(authorId, record.EditionId); // entity slot carries the author id for an author run
        Assert.Equal("author.bio", record.Goal);
    }

    // ---- 6. Cost cap halts -------------------------------------------------------------------------

    [Fact]
    public async Task RunField_CostCapExceeded_Halts()
    {
        var llm = new FakeLlmService(
            "- notes", "A draft.", CleanCritic, "An edited draft.",
            costEach: SeoCrew.CostCapUsd + 0.01m);
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(EditionBrief, "source", Ctx(), Ct);

        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Status);
        Assert.True(result.NeedsReview);     // not completed → flagged
        Assert.Null(result.EditedText);      // never reached the edit stage
        Assert.Null(result.Critique);        // halted after research, before critique

        var record = Assert.Single(writer.Records);
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, record.Status);
        Assert.Single(record.Steps); // only the research stage ran before the cap tripped
    }
}

/// <summary>
/// AI-043 — the crew apply decision in <see cref="SeoJobProcessor"/>, extracted as pure helpers so the
/// strictest-wins trust rule and the fail-closed crew-flag override are unit-reachable without a DB fixture.
/// </summary>
public class SeoJobProcessorCrewDecisionTests
{
    [Fact]
    public void EffectiveTrust_Empty_DefaultsToReview()
    {
        Assert.Equal(SeoTrustLevel.Review, SeoJobProcessor.EffectiveTrust([]));
    }

    [Fact]
    public void EffectiveTrust_StrictestWins()
    {
        Assert.Equal(SeoTrustLevel.Manual,
            SeoJobProcessor.EffectiveTrust([SeoTrustLevel.Auto, SeoTrustLevel.Manual, SeoTrustLevel.Review]));
        Assert.Equal(SeoTrustLevel.Review,
            SeoJobProcessor.EffectiveTrust([SeoTrustLevel.Auto, SeoTrustLevel.Review]));
        Assert.Equal(SeoTrustLevel.Auto,
            SeoJobProcessor.EffectiveTrust([SeoTrustLevel.Auto, SeoTrustLevel.Auto]));
    }

    [Fact]
    public void CrewResultRequiresReview_CrewFlag_OverridesAutoTrust()
    {
        // anyNeedsReview is fail-closed: even Auto trust + no requireReview → NeedsReview.
        Assert.True(SeoJobProcessor.CrewResultRequiresReview(
            requiresReview: false, SeoTrustLevel.Auto, anyNeedsReview: true));
    }

    [Fact]
    public void CrewResultRequiresReview_CleanAutoTrust_False()
    {
        Assert.False(SeoJobProcessor.CrewResultRequiresReview(
            requiresReview: false, SeoTrustLevel.Auto, anyNeedsReview: false));
    }

    [Fact]
    public void CrewResultRequiresReview_NonAutoTrustOrRequireReview_True()
    {
        Assert.True(SeoJobProcessor.CrewResultRequiresReview(false, SeoTrustLevel.Review, false));
        Assert.True(SeoJobProcessor.CrewResultRequiresReview(false, SeoTrustLevel.Manual, false));
        Assert.True(SeoJobProcessor.CrewResultRequiresReview(true, SeoTrustLevel.Auto, false));
    }

    // ---- AI-043 P1#2 — manual-source protection ----------------------------------------------------

    [Fact]
    public void IsManualProtected_ManualWithFilledField_Protected()
    {
        Assert.True(SeoJobProcessor.IsManualProtected(SeoSource.Manual, "hand-written description"));
    }

    [Fact]
    public void IsManualProtected_ManualWithEmptyField_Eligible()
    {
        Assert.False(SeoJobProcessor.IsManualProtected(SeoSource.Manual, null));
        Assert.False(SeoJobProcessor.IsManualProtected(SeoSource.Manual, ""));
        Assert.False(SeoJobProcessor.IsManualProtected(SeoSource.Manual, "   "));
    }

    [Fact]
    public void IsManualProtected_AutoOrHybridWithContent_Eligible()
    {
        Assert.False(SeoJobProcessor.IsManualProtected(SeoSource.Auto, "auto content"));
        Assert.False(SeoJobProcessor.IsManualProtected(SeoSource.Hybrid, "hybrid content"));
    }

    // ---- AI-043 P2 — source-material floor ---------------------------------------------------------

    [Fact]
    public void IsSourceMaterialInsufficient_EmptyOrWhitespace_True()
    {
        Assert.True(SeoJobProcessor.IsSourceMaterialInsufficient(null));
        Assert.True(SeoJobProcessor.IsSourceMaterialInsufficient(""));
        Assert.True(SeoJobProcessor.IsSourceMaterialInsufficient("   \n  "));
    }

    [Fact]
    public void IsSourceMaterialInsufficient_BelowThreshold_True()
    {
        var shortSource = new string('x', SeoJobProcessor.MinSourceMaterialChars - 1);
        Assert.True(SeoJobProcessor.IsSourceMaterialInsufficient(shortSource));
    }

    [Fact]
    public void IsSourceMaterialInsufficient_AtOrAboveThreshold_False()
    {
        var atFloor = new string('x', SeoJobProcessor.MinSourceMaterialChars);
        var aboveFloor = new string('x', SeoJobProcessor.MinSourceMaterialChars + 500);
        Assert.False(SeoJobProcessor.IsSourceMaterialInsufficient(atFloor));
        Assert.False(SeoJobProcessor.IsSourceMaterialInsufficient(aboveFloor));
    }
}
