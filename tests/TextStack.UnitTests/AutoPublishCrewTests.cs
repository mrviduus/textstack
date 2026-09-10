using System.Collections.Concurrent;
using Application.Agents;
using Microsoft.Extensions.DependencyInjection;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;

namespace TextStack.UnitTests;

/// <summary>
/// AI-042 — the in-process <see cref="AutoPublishCrew"/>, driven end-to-end by a deterministic fake
/// <see cref="ILlmService"/> (routed per FeatureTag) and a recording <see cref="IAgentRunWriter"/>. No network,
/// no DB. Verifies: a clean critic → not flagged + edited text returned; a critic blocker or an unparseable
/// critic → fail-closed review; the run persists once through the agent_run path as <c>crew.autopublish</c> with
/// the sub-agent transcript; and the per-field cost cap halts the crew (budget_exhausted → flagged). The
/// needsReview gate is also unit-tested directly as a pure decision.
/// </summary>
public class AutoPublishCrewTests
{
    // ---- Fakes -------------------------------------------------------------------------------------

    /// <summary>
    /// Routes a canned completion per crew FeatureTag (crew.researcher/drafter/critic/editor), so one fake drives
    /// all four specialists deterministically. An optional cost is attached to every response (for the cap test).
    /// </summary>
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

    private static AutoPublishCrew Build(ILlmService llm, IAgentRunWriter writer) =>
        new(new FieldCrew(
            new CrewOrchestrator(),
            new ResearcherAgent(llm),
            new DrafterAgent(llm),
            new CriticAgent(llm),
            new EditorAgent(llm),
            writer));

    // No tools registered — keep this assembly free of ITool so the tool-set assertions in StarterToolsTests are unaffected.
    private static AgentContext Ctx(Guid? editionId = null, Guid? userId = null) =>
        new(userId, editionId, Guid.NewGuid(), new ServiceCollection().BuildServiceProvider());

    private static ContentBrief DescBrief => AutoPublishBriefs.Description("English");

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    // ---- 1. Clean draft → not flagged --------------------------------------------------------------

    // Editor output that clears the Description MinLength floor (800 chars) so a clean run is not gated on length.
    private static readonly string CleanEditedText =
        "An edited factual encyclopedic summary of the work. " + new string('x', AutoPublishBriefs.DescriptionMin);

    [Fact]
    public async Task RunField_CleanDraft_NotFlagged()
    {
        var llm = new FakeLlmService(
            research: "- born 1900\n- wrote three novels",
            draft: "A factual encyclopedic summary of the work.",
            critic: CleanCritic,
            editor: CleanEditedText);
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(DescBrief, "Born 1900. Wrote novels.", Ctx(), Ct);

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
            editor: "A revised draft.");
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

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
            editor: "An edited draft.");
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

        Assert.True(result.NeedsReview);
        Assert.NotNull(result.Critique);
        Assert.True(result.Critique!.ParseFailed); // fail-closed: unparseable critic never reads as a clean pass
    }

    // ---- 4. Persistence ----------------------------------------------------------------------------

    [Fact]
    public async Task RunField_PersistsAgentRun()
    {
        var editionId = Guid.NewGuid();
        var llm = new FakeLlmService("- notes", "A draft.", CleanCritic, "An edited draft.");
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(editionId), Ct);

        var record = Assert.Single(writer.Records);
        Assert.Equal("crew.autopublish", record.Agent);
        Assert.Equal(editionId, record.EditionId);
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

    // ---- 5. Cost cap halts -------------------------------------------------------------------------

    [Fact]
    public async Task RunField_CostCapExceeded_Halts()
    {
        // Each call reports cost above the per-field cap, so the orchestrator halts after the first stage.
        var llm = new FakeLlmService(
            "- notes", "A draft.", CleanCritic, "An edited draft.",
            costEach: AutoPublishCrew.CostCapUsd + 0.01m);
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Status);
        Assert.True(result.NeedsReview);     // not completed → flagged
        Assert.Null(result.EditedText);      // never reached the edit stage
        Assert.Null(result.Critique);        // halted after research, before critique

        // The partial run is still persisted (the budget-exhausted run is the one worth inspecting).
        var record = Assert.Single(writer.Records);
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, record.Status);
        Assert.Single(record.Steps); // only the research stage ran before the cap tripped
    }

    // ---- 6. NeedsReview gate as a pure decision ----------------------------------------------------

    // A body of text comfortably above any brief's MinLength, so the length floor never falsely gates these cases.
    private static string LongText => new('x', AutoPublishBriefs.DescriptionMin + 50);

    [Fact]
    public void NeedsReview_CompletedWithCleanCritique_False()
    {
        var clean = new CritiqueResult(5, 5, 5, 5, [], ParseFailed: false);
        Assert.False(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, LongText, AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_NonCompletedStatus_True()
    {
        var clean = new CritiqueResult(5, 5, 5, 5, [], ParseFailed: false);
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusBudgetExhausted, clean, LongText, AutoPublishBriefs.DescriptionMin));
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusError, clean, LongText, AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_NullOrParseFailedCritique_True()
    {
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, null, LongText, AutoPublishBriefs.DescriptionMin));
        var failed = new CritiqueResult(1, 1, 1, 1,
            [new CritiqueIssue("output", "blocker", "unparseable")], ParseFailed: true);
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, failed, LongText, AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_BlockerIssue_True()
    {
        var blocked = new CritiqueResult(4, 4, 4, 4,
            [new CritiqueIssue("intro", "blocker", "fix")], ParseFailed: false);
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, blocked, LongText, AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_OnlyMinorAndMajorIssues_False()
    {
        // Non-blocker issues alone do not gate — the editor already addressed them; only blockers fail closed.
        var minor = new CritiqueResult(4, 4, 4, 4,
            [new CritiqueIssue("a", "minor", "x"), new CritiqueIssue("b", "major", "y")], ParseFailed: false);
        Assert.False(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, minor, LongText, AutoPublishBriefs.DescriptionMin));
    }

    // ---- 6b. NeedsReview length floor (AI-042 P1 gate cases) ---------------------------------------

    [Fact]
    public void NeedsReview_NullOrWhitespaceEditedText_True()
    {
        var clean = new CritiqueResult(5, 5, 5, 5, [], ParseFailed: false);
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, null, AutoPublishBriefs.DescriptionMin));
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, "", AutoPublishBriefs.DescriptionMin));
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, "   \n\t ", AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_EditedTextBelowMinLength_True()
    {
        // Present, clean critic, but a few chars short of the floor → still flagged.
        var clean = new CritiqueResult(5, 5, 5, 5, [], ParseFailed: false);
        var tooShort = new string('x', AutoPublishBriefs.DescriptionMin - 1);
        Assert.True(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, tooShort, AutoPublishBriefs.DescriptionMin));
    }

    [Fact]
    public void NeedsReview_EditedTextAtMinLengthAndCleanCritic_False()
    {
        // Exactly at the floor + clean critic → not flagged (boundary is inclusive: length >= MinLength passes).
        var clean = new CritiqueResult(5, 5, 5, 5, [], ParseFailed: false);
        var atFloor = new string('x', AutoPublishBriefs.DescriptionMin);
        Assert.False(AutoPublishCrew.NeedsReview(
            CrewRunRecordFactory.StatusCompleted, clean, atFloor, AutoPublishBriefs.DescriptionMin));
    }

    // ---- 7. P1 fix: empty/whitespace/short editor output IS gated --------------------------------------
    // The editor (EditorAgent.Parse → new(text.Trim())) does no length/empty validation. The gate now enforces
    // the brief's MinLength floor, so an LLM that returns empty/whitespace/short text yields NeedsReview == true
    // and the endpoint writes NOTHING — a real Description / SeoRelevanceText can never be clobbered.

    [Fact]
    public async Task RunField_EmptyEditorOutput_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- born 1900\n- wrote three novels",
            draft: "A factual encyclopedic summary of the work.",
            critic: CleanCritic,
            editor: ""); // editor produced nothing — must NOT be auto-applied
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(DescBrief, "Born 1900.", Ctx(), Ct);

        Assert.Equal(string.Empty, result.EditedText);
        Assert.True(result.NeedsReview); // empty edited field → flagged, nothing applied
    }

    [Fact]
    public async Task RunField_WhitespaceEditorOutput_FlagsForReview()
    {
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft.",
            critic: CleanCritic,
            editor: "   \n\t  "); // whitespace only — Trim() collapses it to ""
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

        Assert.Equal(string.Empty, result.EditedText);
        Assert.True(result.NeedsReview); // flagged — nothing to apply
    }

    [Fact]
    public async Task RunField_EditorOutputBelowMinLength_FlagsForReview()
    {
        // Present, clean critic, but a handful of chars — far under the 800-char Description floor → flagged.
        var llm = new FakeLlmService(
            research: "- notes",
            draft: "A draft.",
            critic: CleanCritic,
            editor: "Too short to publish.");
        var crew = Build(llm, new RecordingAgentRunWriter());

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

        Assert.Equal("Too short to publish.", result.EditedText);
        Assert.True(result.NeedsReview); // below MinLength → flagged
    }

    // ---- 8. Cost cap binds only at STAGE boundaries (single runaway stage overshoots) ------------------
    // Documents that CrewOptions(CostCapUsd, 1) is checked AFTER each stage, not mid-call. A single sub-agent
    // whose one call already exceeds the cap still completes that call before the crew halts. With 4
    // single-call stages the max overshoot is one call — acceptable, but pinned so the granularity is explicit.

    [Fact]
    public async Task RunField_SingleStageExceedsCap_StillRunsThatStageThenHalts()
    {
        var llm = new FakeLlmService(
            "- notes", "A draft.", CleanCritic, "An edited draft.",
            costEach: AutoPublishCrew.CostCapUsd + 0.01m); // first call alone busts the cap
        var writer = new RecordingAgentRunWriter();
        var crew = Build(llm, writer);

        var result = await crew.RunFieldAsync(DescBrief, "source", Ctx(), Ct);

        // The research call ran (and overshot) before the cap was checked at the stage boundary.
        Assert.Equal(CrewRunRecordFactory.StatusBudgetExhausted, result.Status);
        Assert.True(result.NeedsReview);
        var record = Assert.Single(writer.Records);
        Assert.Single(record.Steps); // exactly one stage executed despite the overshoot
    }
}

/// <summary>
/// AI-042 P2 — the manual-source write-block decision (<c>AdminAutoPublishEndpoints.IsManualProtected</c>),
/// extracted as a pure helper so the "don't clobber hand-written Manual content" contract is unit-reachable
/// without spinning up HTTP. Mirrors the legacy SeoCoverageAnalyzer "Manual flag protects filled content".
/// </summary>
public class AutoPublishManualProtectionTests
{
    [Fact]
    public void IsManualProtected_ManualWithDescription_True()
    {
        Assert.True(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Manual, "hand-written description", null));
    }

    [Fact]
    public void IsManualProtected_ManualWithRelevance_True()
    {
        Assert.True(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Manual, null, "hand-written relevance"));
    }

    [Fact]
    public void IsManualProtected_ManualButBothFieldsEmpty_False()
    {
        // Empty Manual fields are fair game for first-time generation — only filled content is protected.
        Assert.False(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Manual, null, null));
        Assert.False(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Manual, "", "   "));
    }

    [Fact]
    public void IsManualProtected_AutoOrHybridWithContent_False()
    {
        // Non-Manual provenance is always overwritable, even with existing content.
        Assert.False(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Auto, "auto description", "auto relevance"));
        Assert.False(Api.Endpoints.AdminAutoPublishEndpoints.IsManualProtected(
            Domain.Enums.SeoSource.Hybrid, "hybrid description", null));
    }
}
