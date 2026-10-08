namespace Contracts.Admin;

/// <summary>One day's total cost for a feature — drives the Summary sparkline.</summary>
public record DailyCostPoint(DateOnly Date, decimal CostUsd);

/// <summary>Per-feature observability rollup over the selected window (from llm_trace).</summary>
public record FeatureSummaryDto(
    string FeatureTag,
    long Calls,
    decimal CostUsd,
    decimal CostPerDay,
    int P50LatencyMs,
    int P95LatencyMs,
    double ErrorRate,
    long TokensIn,
    long TokensOut,
    IReadOnlyList<DailyCostPoint> DailyCost,
    decimal? LatestEvalScore);

/// <summary>The /ai-quality Summary tab payload: window + totals + per-feature cards.</summary>
public record AiQualitySummaryDto(
    DateTimeOffset From,
    DateTimeOffset To,
    long TotalCalls,
    decimal TotalCostUsd,
    IReadOnlyList<FeatureSummaryDto> Features);

/// <summary>One row in the Traces tab table (lightweight; no prompt/response bodies).</summary>
public record TraceListItemDto(
    Guid Id,
    string FeatureTag,
    string ModelId,
    int TokensIn,
    int TokensOut,
    decimal CostUsd,
    int LatencyMs,
    bool HasError,
    DateTimeOffset CreatedAt);

/// <summary>Paged trace list for the Traces tab.</summary>
public record TracesPageDto(long Total, IReadOnlyList<TraceListItemDto> Items);

/// <summary>Full trace for the Traces drill-in (prompt/messages/response/tool calls).</summary>
public record TraceDetailDto(
    Guid Id,
    string FeatureTag,
    string ModelId,
    string? SystemPrompt,
    string MessagesJson,
    string? ResponseText,
    string? ToolCallsJson,
    int TokensIn,
    int TokensOut,
    decimal CostUsd,
    int LatencyMs,
    string? Error,
    Guid? UserId,
    DateTimeOffset CreatedAt);

/// <summary>One row in the Agent Runs tab table (AI-045). Omits the heavy StepsJson + Output;
/// Goal is truncated for the list. HasError = the run recorded an error.</summary>
public record AgentRunListItemDto(
    Guid Id,
    string Agent,
    Guid? UserId,
    Guid? EditionId,
    string Status,
    string Goal,
    int Iterations,
    int TokensIn,
    int TokensOut,
    decimal CostUsd,
    int LatencyMs,
    bool HasError,
    DateTimeOffset CreatedAt);

/// <summary>Paged agent-run list for the Agent Runs tab.</summary>
public record AgentRunsPageDto(long Total, IReadOnlyList<AgentRunListItemDto> Items);

/// <summary>Full agent run for the transcript drill-in (AI-045). StepsJson is the RAW jsonb
/// string (crew runs carry nested sub_agent steps); the frontend parses it.</summary>
public record AgentRunDetailDto(
    Guid Id,
    string Agent,
    Guid? UserId,
    Guid? EditionId,
    string Status,
    string Goal,
    string? Output,
    string StepsJson,
    int Iterations,
    int TokensIn,
    int TokensOut,
    decimal CostUsd,
    int LatencyMs,
    string? Error,
    DateTimeOffset CreatedAt);

/// <summary>Request body for triggering an eval run from the admin panel.</summary>
public record RunEvalsRequest(string[]? Features, string? Judge);

/// <summary>State of the in-app eval runner (one run at a time).</summary>
public record EvalStatusDto(bool Running, DateTimeOffset? StartedAt, string? LastError);

/// <summary>One persisted eval run for the Evals tab history. <c>RunType</c> is
/// "manual" (admin-triggered) or "scheduled" (ContinuousEvalWorker).</summary>
public record EvalRunDto(
    Guid Id,
    string Feature,
    string ModelId,
    string JudgeModelId,
    decimal Score,
    int N,
    string? BreakdownJson,
    string? GitSha,
    string RunType,
    DateTimeOffset CreatedAt);

/// <summary>One point on the scheduled-eval trend (Evals tab). Only
/// <c>RunType='scheduled'</c> rows, newest-first.</summary>
public record ScheduledEvalPointDto(
    string Feature,
    string ModelId,
    double Score,
    int N,
    string GitSha,
    DateTimeOffset CreatedAt);

// ── Shadow-run comparison + models registry (Phase 12 RLOps) ──────────────────

/// <summary>One primary↔shadow pairing rolled up over the window (from shadow_runs).
/// Deltas are shadow − primary; the monthly projection scales the window's cost delta
/// to 30 days. Agreement metrics (exact/length/both-present) only count rows where BOTH
/// responses are present.</summary>
public record ShadowPairDto(
    string FeatureTag,
    string PrimaryModelId,
    string ShadowModelId,
    long Runs,
    int PrimaryP50LatencyMs,
    int ShadowP50LatencyMs,
    int LatencyDeltaMs,
    decimal PrimaryCostUsd,
    decimal ShadowCostUsd,
    decimal CostDeltaUsd,
    decimal ProjectedMonthlyCostDeltaUsd,
    long PrimaryTokensOut,
    long ShadowTokensOut,
    long TokensOutDelta,
    double ExactMatchRate,
    double AvgLengthRatio,
    double BothPresentRate,
    DateTimeOffset FirstSeen,
    DateTimeOffset LastSeen);

/// <summary>The shadow Summary payload: window + total runs + per-pair rollups.</summary>
public record ShadowSummaryDto(
    DateTimeOffset From,
    DateTimeOffset To,
    long TotalRuns,
    IReadOnlyList<ShadowPairDto> Pairs);

/// <summary>One redacted shadow sample (primary vs shadow side by side) for the drill-in.</summary>
public record ShadowSampleDto(
    Guid Id,
    string? PrimaryResponse,
    string? ShadowResponse,
    int PrimaryLatencyMs,
    int ShadowLatencyMs,
    decimal PrimaryCostUsd,
    decimal ShadowCostUsd,
    int PrimaryTokensOut,
    int ShadowTokensOut,
    bool ExactMatch,
    string PromptHash,
    Guid? PrimaryTraceId,
    Guid? ShadowTraceId,
    DateTimeOffset CreatedAt);

/// <summary>Paged shadow-sample list for one pair.</summary>
public record ShadowSamplesPageDto(long Total, IReadOnlyList<ShadowSampleDto> Items);

/// <summary>One row in the models registry (table <c>models</c>); Status is the string enum.</summary>
public record ModelRegistrationDto(
    Guid Id,
    string FeatureTag,
    string ProviderKey,
    string ModelId,
    string Status,
    DateTimeOffset CreatedAt);

/// <summary>The models registry payload (whole table; tiny).</summary>
public record ModelsRegistryDto(IReadOnlyList<ModelRegistrationDto> Models);

/// <summary>Per-feature budget status for the Budgets tab (Phase 12 RLOps slice 4). Spend is read
/// from the live in-memory tracker (NOT the sampled traces — those undercount). <c>PctUsed</c> is
/// 0 when the feature has no budget. <c>InFallback</c> is true only when the mode is fallback AND
/// today's spend is at/over the budget (i.e. calls are currently being rerouted to the cheaper
/// provider). Mode is the lowercased string: "off" | "fallback" | "hardstop".</summary>
public record BudgetStatusDto(
    string FeatureTag,
    decimal TodaySpendUsd,
    decimal? DailyBudgetUsd,
    double PctUsed,
    string Mode,
    string? FallbackKey,
    bool InFallback);

/// <summary>Result of a promote/rollback: the new Primary, the model demoted to Shadow
/// (null if there was none), the audited action ("Promote"/"Rollback") + admin + time.</summary>
public record ModelPromotionResultDto(
    string FeatureTag,
    ModelRegistrationDto NewPrimary,
    ModelRegistrationDto? DemotedToShadow,
    string Action,
    Guid? AdminUserId,
    DateTimeOffset CreatedAt);
