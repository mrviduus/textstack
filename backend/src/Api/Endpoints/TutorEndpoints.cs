using Api.Extensions;
using Api.Sites;
using Application.Agents;
using Application.Auth;
using Application.Common.Interfaces;
using Application.Vocabulary;
using Contracts.Agents;
using Domain.Entities;
using Microsoft.EntityFrameworkCore;
using TextStack.Ai.Agents;
using TextStack.Ai.Core;
using TextStack.Vocabulary;
using TextStack.Vocabulary.Contracts;

namespace Api.Endpoints;

/// <summary>
/// Learning Tutor agent endpoints (AI-Agent-2). The tutor PLANS what to study next over the learner's real
/// SRS + reading state and hands off to the existing vocabulary-review flow; the plan is held server-side in a
/// <see cref="TutorSession"/> so the HITL re-plan turn survives across HTTP requests. JSON (SSE deferred).
/// Authenticated + rate-limited like the other <c>/me/*</c> agent endpoints (a turn is several LLM calls + DB
/// reads). Each planning turn is persisted as an <c>agent_run</c> (agent=<c>tutor</c>) for replay.
/// </summary>
public static class TutorEndpoints
{
    /// <summary>Default session size when the client doesn't ask for one — a sane, non-drilling session.</summary>
    public const int DefaultMaxItems = 5;

    /// <summary>
    /// Hard cap on re-plan turns (HITL). Each feedback turn increments <c>TurnCount</c>; once it reaches this,
    /// the session is completed (empty plan) instead of re-planning, so a persistently-wrong card (or an
    /// over-eager planner) can't re-surface forever. The client already treats an empty plan as "complete".
    /// </summary>
    public const int MaxTurns = 6;

    public static void MapTutorEndpoints(this WebApplication app)
    {
        // Whole group: every route here drives an agent turn. Paid inference — real account only
        // (Entitlements:Tiers:*:AiEnabled).
        var group = app.MapGroup("/me/tutor").WithTags("Agents")
            .RequireRateLimiting("tutor")
            .RequireAiAccount();
        group.MapPost("/session", StartSession);
        group.MapPost("/session/{id:guid}/answer", SubmitAnswer);
        group.MapPost("/session/{id:guid}/feedback", SubmitFeedback);
    }

    // POST /me/tutor/session — plan a new session over the learner's current state.
    private static async Task<IResult> StartSession(
        TutorStartRequest? request,
        HttpContext httpContext,
        AuthService authService,
        TutorAgent agent,
        IAppDbContext db,
        IAgentRunWriter writer,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId is null) return Results.Unauthorized();
        var siteId = httpContext.GetSiteId();

        var maxItems = Math.Clamp(request?.MaxItems ?? DefaultMaxItems, 1, TutorAgent.MaxPlanItems);
        var input = new TutorInput(maxItems);

        var (plan, runId, problem) = await RunTurnAsync(
            agent, input, userId.Value, httpContext.RequestServices, writer, "tutor session start", ct);
        if (problem is not null) return problem;

        var now = DateTimeOffset.UtcNow;
        var session = new TutorSession
        {
            Id = Guid.NewGuid(),
            UserId = userId.Value,
            SiteId = siteId,
            PlanJson = plan!.ToPlanJson(),
            Status = TutorSession.StatusActive,
            TurnCount = 1,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.TutorSessions.Add(session);
        await db.SaveChangesAsync(ct);

        var cards = await LoadPlanCardsAsync(db, plan, userId.Value, ct);
        return Results.Ok(ToResponse(session.Id, plan, cards, runId));
    }

    // POST /me/tutor/session/{id}/answer — record ONE answer, now.
    //
    // Feedback arrives only when the session ends, so until this existed a learner who left
    // mid-session lost the work they had already done — which mattered more, not less, once the
    // answers finally started counting at all. This writes through the same recorder and marks the
    // same applied-word set, so the closing /feedback call re-plans and writes nothing twice.
    // No planner, no LLM call: an answer must not wait on planning to be worth anything.
    private static async Task<IResult> SubmitAnswer(
        Guid id,
        TutorAnswerRequest? request,
        HttpContext httpContext,
        AuthService authService,
        IAppDbContext db,
        VocabularyReviewRecorder recorder,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId is null) return Results.Unauthorized();
        if (request is null) return Results.BadRequest(new { error = "An answer is required." });

        var session = await db.TutorSessions
            .FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId.Value, ct);
        if (session is null) return Results.NotFound();

        // Same trust rule as feedback: an id the session never showed is not an answer to it.
        if (!PriorPlanWordIds(session.PlanJson).Contains(request.WordId))
            return Results.Ok(new { applied = false });

        var item = new TutorFeedbackItem(request.WordId, request.Correct, Math.Max(0, request.ResponseTimeMs));
        await ApplyAnswersToSrsAsync(db, recorder, session, [item], userId.Value, httpContext.GetSiteId(), ct);
        await db.SaveChangesAsync(ct);

        return Results.Ok(new { applied = true });
    }

    // POST /me/tutor/session/{id}/feedback — re-plan the remainder given the learner's results.
    private static async Task<IResult> SubmitFeedback(
        Guid id,
        TutorFeedbackRequest? request,
        HttpContext httpContext,
        AuthService authService,
        TutorAgent agent,
        IAppDbContext db,
        IAgentRunWriter writer,
        VocabularyReviewRecorder recorder,
        CancellationToken ct)
    {
        var userId = httpContext.GetUserId(authService);
        if (userId is null) return Results.Unauthorized();
        var feedbackSiteId = httpContext.GetSiteId();

        var session = await db.TutorSessions
            .FirstOrDefaultAsync(s => s.Id == id && s.UserId == userId.Value, ct);
        if (session is null) return Results.NotFound();
        if (session.Status != TutorSession.StatusActive)
            return Results.BadRequest(new { error = "Session is already completed." });

        // Feedback is the learner's results for cards in the prior plan; an empty body re-plans from scratch.
        // Trust nothing the client sends verbatim: ignore any result whose wordId was NOT in the prior plan
        // (a client can't steer the re-plan with arbitrary ids it never saw).
        var priorPlanIds = PriorPlanWordIds(session.PlanJson);
        var feedback = (request?.Results ?? [])
            .Where(r => priorPlanIds.Contains(r.WordId))
            .Select(r => new TutorFeedbackItem(r.WordId, r.Correct, Math.Max(0, r.ResponseTimeMs)))
            .ToList();

        // These answers are the learner's real work, so they move spaced repetition — the same write
        // ordinary review performs, through the same recorder. Before this, Smart session read the
        // answers to plan the next turn and threw them away: the summary said "Accuracy 100%" while the
        // card's stage, interval and next-review date had not moved. It happens before the turn cap
        // returns, because the answers on the final turn count exactly as much as the earlier ones.
        await ApplyAnswersToSrsAsync(db, recorder, session, feedback, userId.Value, feedbackSiteId, ct);

        // Turn cap: once the session has run MaxTurns re-plans, complete it instead of planning again so a
        // persistently-wrong card can't loop forever. Returns an empty plan (the client's "session complete"
        // signal) — short-circuits before any LLM call.
        if (ReachedTurnCap(session.TurnCount))
        {
            var done = TutorPlan.Empty("Session complete — you've reached the turn limit for this round. Keep reading.");
            session.PlanJson = done.ToPlanJson();
            session.Status = TutorSession.StatusCompleted;
            session.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            return Results.Ok(ToResponse(session.Id, done, [], Guid.Empty));
        }

        var maxItems = CountPlanItems(session.PlanJson, fallback: DefaultMaxItems);
        var input = new TutorInput(maxItems, feedback);

        var (plan, runId, problem) = await RunTurnAsync(
            agent, input, userId.Value, httpContext.RequestServices, writer, "tutor re-plan", ct);
        if (problem is not null) return problem;

        // Deterministic backstop (not LLM-trusted): drop any item the learner just answered correctly so a
        // just-passed card can never be re-surfaced this turn, regardless of what the model planned.
        plan = DropPassedCards(plan!, feedback);

        session.PlanJson = plan.ToPlanJson();
        session.TurnCount += 1;
        session.UpdatedAt = DateTimeOffset.UtcNow;
        // An empty re-plan means there's nothing left to study — the session is done.
        if (plan.Items.Count == 0)
            session.Status = TutorSession.StatusCompleted;
        await db.SaveChangesAsync(ct);

        var cards = await LoadPlanCardsAsync(db, plan, userId.Value, ct);
        return Results.Ok(ToResponse(session.Id, plan, cards, runId));
    }

    /// <summary>
    /// Runs one planning turn and persists it as an <c>agent_run</c> (best-effort telemetry). Returns the plan
    /// (null on failure), the run id, and a populated problem result when the turn could not complete.
    /// </summary>
    private static async Task<(TutorPlan? Plan, Guid RunId, IResult? Problem)> RunTurnAsync(
        TutorAgent agent, TutorInput input, Guid userId, IServiceProvider services, IAgentRunWriter writer,
        string goalLabel, CancellationToken ct)
    {
        var runId = Guid.NewGuid();
        // The agent's tools resolve scoped services (IAppDbContext, IRagService) from the request scope.
        var ctx = new AgentContext(userId, null, runId, services);

        TutorRun? outcome = null;
        AgentRunRecord record;
        try
        {
            outcome = await agent.RunAsync(input, ctx, ct);
            record = AgentRunRecordFactory.Completed(
                runId, TutorAgent.AgentName, userId, editionId: null, goalLabel, outcome.Run)
                with
            { ToolCallsCount = outcome.ToolCallsCount };
        }
        catch (AgentBudgetExhaustedException ex)
        {
            record = AgentRunRecordFactory.BudgetExhausted(
                runId, TutorAgent.AgentName, userId, editionId: null, goalLabel, ex);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            record = AgentRunRecordFactory.Failed(runId, TutorAgent.AgentName, userId, editionId: null, goalLabel, ex);
        }

        try { await writer.WriteAsync(record, ct); }
        catch { /* telemetry only */ }

        if (outcome is null)
            return (null, runId, Results.Problem("The tutor could not plan this session.", statusCode: 503));

        return (outcome.Plan, runId, null);
    }

    /// <summary>
    /// Loads the REAL <c>VocabularyWord</c> rows backing a plan, scoped to the caller. This is the render-field
    /// source for <see cref="EnrichPlanItems"/> and a natural anti-hallucination re-check: only the caller's
    /// own cards survive (the <c>UserId</c> filter), and any planned id that isn't one of them is later dropped.
    /// </summary>
    private static async Task<IReadOnlyList<VocabularyWord>> LoadPlanCardsAsync(
        IAppDbContext db, TutorPlan plan, Guid userId, CancellationToken ct)
    {
        var ids = plan.Items.Select(i => i.WordId).Distinct().ToList();
        if (ids.Count == 0) return [];
        return await db.VocabularyWords
            .Where(v => ids.Contains(v.Id) && v.UserId == userId)
            .ToListAsync(ct);
    }

    private static TutorSessionResponse ToResponse(
        Guid sessionId, TutorPlan plan, IReadOnlyList<VocabularyWord> cards, Guid runId) =>
        new(
            sessionId,
            EnrichPlanItems(plan, cards),
            plan.Rationale,
            plan.ReadingNudge,
            runId);

    /// <summary>
    /// Projects each plan item to its DTO, enriching the render fields from the caller's matching
    /// <c>VocabularyWord</c> row (keyed on the already-validated <see cref="TutorPlanItem.WordId"/>). An item
    /// with no matching row is DROPPED — the enrichment never introduces an unvalidated id and never emits a
    /// card with null render fields for a phantom id. Distractors are parsed from the same JSON array column
    /// the vocabulary-review flow reads (<c>["w1","w2",...]</c>); empty list when absent or malformed.
    /// </summary>
    internal static List<TutorPlanItemDto> EnrichPlanItems(TutorPlan plan, IReadOnlyList<VocabularyWord> cards)
    {
        var byId = cards.ToDictionary(c => c.Id);
        var result = new List<TutorPlanItemDto>(plan.Items.Count);
        foreach (var i in plan.Items)
        {
            if (!byId.TryGetValue(i.WordId, out var card))
                continue; // planned id isn't one of the caller's cards → drop (anti-hallucination re-check)
            var (options, correctIndex, blankSentence) = ShapeExercise(i.ExerciseType, card, cards);

            result.Add(new TutorPlanItemDto(
                i.WordId, i.Word, i.Stage, i.ExerciseType, i.Difficulty, i.Why,
                card.Translation, card.Definition, card.Sentence, card.BookTitle, card.Hint,
                ParseDistractors(card.Distractors),
                options, correctIndex, blankSentence));
        }
        return result;
    }

    /// <summary>
    /// Turns the calibrated exercise type into the card the learner actually gets.
    ///
    /// <para>This is the step that was missing. The type was computed from the card's SRS stage,
    /// carried all the way to the client, and then rendered as a badge over a flashcard that was the
    /// same for all three — so a calibration the server had reasoned about changed nothing at all.
    /// </para>
    ///
    /// <para>Options come from <see cref="McOptions"/>, the same builder the vocabulary-review flow
    /// uses, rather than a second implementation on each client. The distractor pool is the OTHER
    /// words in this session: the learner's own vocabulary, which is what the review flow falls back
    /// to as well, and better than a hardcoded list because a distractor they have met is a real
    /// choice rather than an obvious filler.</para>
    ///
    /// <para><c>context</c> without a sentence cannot happen — <c>CalibrateForStage</c> downgrades
    /// that case to <c>recall</c> before it reaches here — but if it ever did, the cloze would be a
    /// blank with nothing around it, so it degrades to a plain four-option card rather than a broken
    /// one.</para>
    /// </summary>
    internal static (IReadOnlyList<string>? Options, int? CorrectIndex, string? BlankSentence) ShapeExercise(
        string exerciseType, VocabularyWord card, IReadOnlyList<VocabularyWord> sessionCards)
    {
        // Recall is a flashcard: the learner says whether they knew it. Handing them four options
        // would make it a recognition exercise wearing a recall label.
        if (exerciseType == TutorPlanItem.ExerciseRecall) return (null, null, null);

        var pool = sessionCards
            .Where(c => c.Id != card.Id)
            .Select(c => new DistractorPoolEntry(c.Word, c.Language))
            .ToList();

        var (options, correctIndex) = McOptions.Build(card.Word, card.Language, card.Distractors, pool);

        var blank = exerciseType == TutorPlanItem.ExerciseContext && card.Sentence != null
            ? SentenceHelper.ReplaceWordInSentence(card.Sentence, card.Word)
            : null;

        return (options, correctIndex, blank);
    }

    /// <summary>
    /// Parses the <c>VocabularyWord.Distractors</c> JSON array (<c>["w1","w2",...]</c>) into a list, mirroring
    /// the review flow's tolerance: missing/empty/malformed → empty list. (Kept minimal — the MC-option
    /// shuffling/filtering lives in the review card builder; the tutor hands raw distractors to the client.)
    /// </summary>
    internal static IReadOnlyList<string> ParseDistractors(string? json)
    {
        if (string.IsNullOrEmpty(json)) return [];
        try
        {
            var list = System.Text.Json.JsonSerializer.Deserialize<List<string>>(json);
            return list?.Where(w => !string.IsNullOrWhiteSpace(w)).ToList() ?? [];
        }
        catch { return []; }
    }

    /// <summary>
    /// Deterministic backstop (not LLM-trusted): removes any plan item whose card the learner just answered
    /// <c>correct:true</c> in this feedback turn, so a just-passed card can never be re-surfaced regardless of
    /// what the model planned.
    /// </summary>
    internal static TutorPlan DropPassedCards(TutorPlan plan, IReadOnlyList<TutorFeedbackItem> feedback)
    {
        var justPassed = feedback.Where(f => f.Correct).Select(f => f.WordId).ToHashSet();
        if (justPassed.Count == 0) return plan;
        return plan with { Items = plan.Items.Where(i => !justPassed.Contains(i.WordId)).ToList() };
    }

    /// <summary>
    /// Write each not-yet-applied answer to spaced repetition and remember which words were applied.
    ///
    /// The remembering is not optional. Both clients accumulate their results in a ref that is never
    /// cleared (<c>useTutorSession</c>), so a five-card session that re-plans once sends turn one's
    /// answers again with turn two's — without this set, a single "Knew" would advance the card twice
    /// and skip it a day further ahead than the learner earned. The set lives on the session row rather
    /// than in the request because it is a fact about what the server already did.
    /// </summary>
    private static async Task ApplyAnswersToSrsAsync(
        IAppDbContext db,
        VocabularyReviewRecorder recorder,
        TutorSession session,
        IReadOnlyList<TutorFeedbackItem> feedback,
        Guid userId,
        Guid siteId,
        CancellationToken ct)
    {
        if (feedback.Count == 0) return;

        var applied = AppliedWordIds(session.AppliedWordIdsJson);
        var wrote = false;

        foreach (var item in feedback)
        {
            if (!applied.Add(item.WordId)) continue;
            // A missing word (deleted mid-session) returns null and is simply skipped; it stays in the
            // applied set so a retry does not keep looking for it.
            await recorder.RecordAsync(userId, siteId, item.WordId, item.Correct, item.ResponseTimeMs, isPractice: false, ct);
            wrote = true;
        }

        if (!wrote) return;
        session.AppliedWordIdsJson = System.Text.Json.JsonSerializer.Serialize(applied);
        // The caller saves; the recorder has already saved each word and its review row.
    }

    /// <summary>Parse <see cref="TutorSession.AppliedWordIdsJson"/>; anything unreadable means "none applied yet".</summary>
    internal static HashSet<Guid> AppliedWordIds(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return System.Text.Json.JsonSerializer.Deserialize<HashSet<Guid>>(json) ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>
    /// The set of wordIds in a persisted plan — feedback for any id NOT here is dropped (a client can't feed
    /// the re-plan arbitrary ids it was never shown). Reads the camelCase "items"/"wordId" Web-serialized shape.
    /// </summary>
    internal static HashSet<Guid> PriorPlanWordIds(string planJson)
    {
        var ids = new HashSet<Guid>();
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(planJson);
            if (doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                foreach (var item in items.EnumerateArray())
                {
                    if (item.ValueKind == System.Text.Json.JsonValueKind.Object
                        && item.TryGetProperty("wordId", out var w)
                        && w.ValueKind == System.Text.Json.JsonValueKind.String
                        && Guid.TryParse(w.GetString(), out var id))
                        ids.Add(id);
                }
            }
        }
        catch { /* malformed persisted plan → no trusted prior ids */ }
        return ids;
    }

    /// <summary>
    /// True once a session has reached the re-plan turn cap (FIX 2) — the feedback path then completes the
    /// session with an empty plan instead of planning again, so a persistently-wrong card can't loop forever.
    /// </summary>
    internal static bool ReachedTurnCap(int turnCount) => turnCount >= MaxTurns;

    /// <summary>Counts the items in a persisted plan (the prior session size) to keep re-plan turns the same length.</summary>
    internal static int CountPlanItems(string planJson, int fallback)
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(planJson);
            // ToPlanJson serializes with Web defaults (camelCase) → the property is "items", and
            // TryGetProperty is case-sensitive. Matching "Items" here silently never hit → re-plan always fell
            // back to the default length regardless of the session's original maxItems.
            if (doc.RootElement.TryGetProperty("items", out var items) && items.ValueKind == System.Text.Json.JsonValueKind.Array)
                return Math.Clamp(items.GetArrayLength(), 1, TutorAgent.MaxPlanItems);
        }
        catch { /* fall through */ }
        return fallback;
    }
}
