using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Observability;

namespace TextStack.Ai.Llm;

/// <summary>
/// Composite <see cref="ILlmService"/> that routes each call to a provider by
/// <c>FeatureTag</c> (config <c>Ai:Routes:{featureTag}</c> → provider key, falling
/// back to <c>Ai:DefaultProvider</c>). Resolves the *decorated* keyed instance, so
/// tracing already wraps the provider. Callers never know which model answered.
///
/// v2 (AI-075): optional SHADOW routing. When a feature has a shadow route
/// (<c>Ai:Shadow:Routes:{featureTag}</c>) and the call is sampled, the gateway —
/// AFTER the primary response is ready — fires a fire-and-forget shadow call against
/// the shadow provider's <c>-raw</c> (untraced) sibling and persists one
/// <see cref="Core.ShadowRun"/> row. Shadow NEVER affects the primary call's latency
/// or correctness: the primary returns immediately, the shadow runs on a background
/// scope with its own timeout, and any shadow failure/timeout is swallowed + logged.
/// </summary>
public sealed class ModelGateway(
    IServiceProvider serviceProvider,
    IConfiguration config,
    IServiceScopeFactory scopeFactory,
    ShadowOptions shadowOptions,
    IModelRouteProvider routeProvider,
    ISpendTracker spendTracker,
    BudgetOptions budgetOptions,
    ILogger<ModelGateway> logger,
    IRouteAlarm? routeAlarm = null) : ILlmService
{
    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var primary = await BudgetAwareRoute(request.FeatureTag).CompleteAsync(request, ct);
        sw.Stop();

        RecordSpend(request.FeatureTag, primary);
        // Fire-and-forget — never awaited, so the primary returns instantly.
        MaybeShadow(request, primary, sw.ElapsedMilliseconds);
        return primary;
    }

    // Streamed primary is re-yielded unchanged & in order. The shadow (a non-streamed
    // CompleteAsync) only fires AFTER the primary stream completes cleanly; if the
    // primary stream throws mid-way, no shadow runs. The user only ever sees the
    // primary stream.
    public async IAsyncEnumerable<LlmDelta> StreamAsync(
        LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var text = new StringBuilder();
        var toolCalls = new List<ToolCall>();
        LlmUsage? usage = null;
        string? modelId = null;
        var traceId = Guid.NewGuid();

        await using var e = BudgetAwareRoute(request.FeatureTag).StreamAsync(request, ct).GetAsyncEnumerator(ct);
        while (true)
        {
            if (!await e.MoveNextAsync())
                break;
            var delta = e.Current;

            if (delta.TextDelta is not null) text.Append(delta.TextDelta);
            if (delta.ToolCallDelta is not null) toolCalls.Add(delta.ToolCallDelta);
            if (delta.FinalUsage is not null) usage = delta.FinalUsage;
            if (delta.ModelId is not null) modelId = delta.ModelId;
            yield return delta;
        }

        sw.Stop();
        // Only reached on clean completion (an exception escapes the loop without
        // running this), so a primary that throws mid-stream is never shadowed.
        var primary = TracingDecorator.BuildStreamedResponse(text.ToString(), toolCalls, usage, modelId, traceId);
        RecordSpend(request.FeatureTag, primary);
        MaybeShadow(request, primary, sw.ElapsedMilliseconds);
    }

    private ILlmService Route(string? featureTag)
    {
        var decision = ResolveRoute(featureTag);
        var key = decision.Key;
        var reason = decision.Reason;

        // A registry row may name a provider key with no keyed registration (e.g. a key
        // renamed in config but still recorded in `models`). That must NEVER throw — fall
        // back to the config route + log, mirroring an unknown-key first-deploy guard.
        var svc = serviceProvider.GetKeyedService<ILlmService>(key);
        if (svc is null)
        {
            logger.LogWarning(
                "Unknown provider key '{Key}' for feature '{Feature}'; falling back to config route", key, featureTag);
            var configKey = ConfigRouteKey(featureTag);
            key = configKey ?? config["Ai:DefaultProvider"] ?? "openai";
            // The guard re-resolves: landing on DefaultProvider here is genuinely a fallback.
            reason = configKey is not null ? RouteReason.RouteMatched : RouteReason.DefaultFallback;
            svc = serviceProvider.GetRequiredKeyedService<ILlmService>(key);
        }

        ReportRoute(featureTag, key, reason);
        return svc;
    }

    /// <summary>
    /// Publishes the resolved route to observability. The span attributes are the fix for the
    /// 2026-07-14 silent-fallback incident: with <c>ai.task</c> + <c>ai.provider.resolved</c> +
    /// <c>ai.provider.reason</c> on the span, "which model actually answered, and did anyone
    /// choose it on purpose?" is answerable from a trace instead of from CPU graphs. The alarm
    /// escalates the one case that is always a defect — an expensive task on a default fallback.
    /// Never throws: observability may not break a real LLM call.
    /// </summary>
    private void ReportRoute(string? featureTag, string key, RouteReason reason)
    {
        try
        {
            var span = SentrySdk.GetSpan();
            if (span is not null)
            {
                span.SetTag("ai.task", featureTag ?? "unknown");
                span.SetTag("ai.provider.resolved", key);
                span.SetTag("ai.provider.reason", RouteReasonNames.For(reason));
            }

            Activity.Current?.SetTag("ai.task", featureTag ?? "unknown");
            Activity.Current?.SetTag("ai.provider.resolved", key);
            Activity.Current?.SetTag("ai.provider.reason", RouteReasonNames.For(reason));

            routeAlarm?.OnRouteResolved(featureTag, key, reason);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Route reporting failed for feature '{Feature}'", featureTag);
        }
    }

    /// <summary>
    /// The ONE place route precedence lives: registry Primary (table-driven, set by admin
    /// promote/rollback) → config <c>Ai:Routes:{feature}</c> → <c>Ai:DefaultProvider</c> → "openai".
    /// The route provider is hot-path safe (cached, never throws → null on any failure), so a missing
    /// DB or empty registry transparently falls through to the config route. Returns the reason as a
    /// by-product so callers can tell a deliberate route from a silent fallback — previously
    /// indistinguishable, which is exactly how the pdf.parse → Ollama incident stayed invisible.
    /// </summary>
    private RouteDecision ResolveRoute(string? featureTag)
    {
        var matched = RegistryKey(featureTag) ?? ConfigRouteKey(featureTag);
        return matched is not null
            ? new RouteDecision(matched, RouteReason.RouteMatched)
            : new RouteDecision(config["Ai:DefaultProvider"] ?? "openai", RouteReason.DefaultFallback);
    }

    private string? ConfigRouteKey(string? featureTag) =>
        !string.IsNullOrWhiteSpace(featureTag) ? config[$"Ai:Routes:{featureTag}"] : null;

    private readonly record struct RouteDecision(string Key, RouteReason Reason);

    /// <summary>
    /// Route resolution with cost-aware budget enforcement layered on top of the true primary
    /// (<see cref="Route"/>). When a feature is at/over its daily budget and budget enforcement is
    /// ON for it: <c>fallback</c> mode reroutes to the configured cheaper provider (if it resolves
    /// to a registered keyed service; otherwise it logs + uses the true primary), and <c>hardstop</c>
    /// mode throws <see cref="BudgetExceededException"/>. ANY exception in the budget check (a
    /// tracker glitch, an options bug) is swallowed → the true primary is used, so budget logic can
    /// NEVER break a real LLM call. The shadow path is unaffected: it always compares the TRUE
    /// primary (see <see cref="ResolvedPrimaryKey"/>), not the budget fallback.
    /// </summary>
    private ILlmService BudgetAwareRoute(string? featureTag)
    {
        var truePrimary = Route(featureTag);
        try
        {
            if (string.IsNullOrWhiteSpace(featureTag))
                return truePrimary;

            var mode = budgetOptions.ModeFor(featureTag);
            if (mode == BudgetMode.Off)
                return truePrimary;

            if (budgetOptions.DailyUsdFor(featureTag) is not { } dailyUsd)
                return truePrimary;

            var spent = spendTracker.SpentTodayUsd(featureTag);
            if (spent < dailyUsd)
                return truePrimary;

            if (mode == BudgetMode.HardStop)
                throw new BudgetExceededException(featureTag, dailyUsd, spent);

            // Fallback mode: reroute to the cheaper provider if it's a registered keyed service.
            var fallbackKey = budgetOptions.FallbackKeyFor(featureTag);
            if (fallbackKey is not null
                && serviceProvider.GetKeyedService<ILlmService>(fallbackKey) is { } fallbackSvc)
            {
                logger.LogDebug(
                    "Feature '{Feature}' over budget (${Spent}/${Budget}); routing to fallback '{Key}'",
                    featureTag, spent, dailyUsd, fallbackKey);
                return fallbackSvc;
            }

            logger.LogWarning(
                "Feature '{Feature}' over budget but fallback '{Key}' is not registered; using primary",
                featureTag, fallbackKey);
            return truePrimary;
        }
        catch (BudgetExceededException)
        {
            // Hard stop is a deliberate signal — let it surface (mapped to 429 by the API).
            throw;
        }
        catch (Exception ex)
        {
            // Budget logic must NEVER break a call — fall back to the true primary.
            logger.LogDebug(ex, "Budget-aware routing failed for feature '{Feature}'; using primary", featureTag);
            return truePrimary;
        }
    }

    /// <summary>Record one completed call's cost against the feature's running daily total, exactly
    /// once per gateway call (regardless of whether the budget fallback served it). Shadow <c>-raw</c>
    /// calls bypass the gateway entirely, so shadow spend is correctly NOT counted. Never throws.</summary>
    private void RecordSpend(string? featureTag, LlmResponse primary)
    {
        if (string.IsNullOrWhiteSpace(featureTag))
            return;
        try
        {
            spendTracker.Record(featureTag, primary.Usage.CostUsd);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Spend record failed for feature '{Feature}'", featureTag);
        }
    }

    /// <summary>Resolved PRIMARY provider key for a feature (registry → config → default),
    /// mirroring <see cref="Route"/>'s precedence WITHOUT touching DI. Used to skip a
    /// shadow that now points at the same provider as the primary.</summary>
    private string ResolvedPrimaryKey(string? featureTag) => ResolveRoute(featureTag).Key;

    /// <summary>Registry Primary key for a feature, defensively. The provider contract is
    /// never-throws, but we ALSO guard here so a misbehaving provider can never break a real
    /// LLM call — it just falls through to the config route.</summary>
    private string? RegistryKey(string? featureTag)
    {
        if (string.IsNullOrWhiteSpace(featureTag))
            return null;
        try
        {
            return routeProvider.PrimaryProviderKey(featureTag);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Registry route lookup threw for feature '{Feature}'; using config route", featureTag);
            return null;
        }
    }

    /// <summary>
    /// If a shadow route is configured for the feature and the call is sampled, run the
    /// shadow on a background scope and persist one row. Fully fire-and-forget: the task
    /// is never awaited, every failure is swallowed + logged, and the user's
    /// CancellationToken is NOT threaded (the shadow uses its own timeout).
    /// </summary>
    private void MaybeShadow(LlmRequest request, LlmResponse primary, long primaryLatencyMs)
    {
        var shadowKey = shadowOptions.ShadowKeyFor(request.FeatureTag);
        if (shadowKey is null)
            return;

        // Post-promotion guard: if the shadow route now points at the SAME provider the
        // primary already resolves to (e.g. the shadow candidate got promoted), shadowing
        // would compare a model to itself + burn paid calls for nothing. Skip it.
        if (string.Equals(shadowKey, ResolvedPrimaryKey(request.FeatureTag), StringComparison.Ordinal))
        {
            logger.LogDebug(
                "Shadow key '{Key}' equals the primary for feature '{Feature}'; skipping self-shadow",
                shadowKey, request.FeatureTag);
            return;
        }

        if (!ShouldSample(shadowOptions.RateFor(request.FeatureTag)))
            return;

        var feature = string.IsNullOrWhiteSpace(request.FeatureTag) ? "unknown" : request.FeatureTag;
        var timeout = TimeSpan.FromSeconds(shadowOptions.TimeoutSeconds);

        _ = Task.Run(async () =>
        {
            try
            {
                using var scope = scopeFactory.CreateScope();
                // Resolve the -raw (UNTRACED) sibling: no llm_traces row, no recursion
                // through the gateway, and the cost is owned by this shadow row only.
                var shadow = scope.ServiceProvider.GetRequiredKeyedService<ILlmService>($"{shadowKey}-raw");

                using var cts = new CancellationTokenSource(timeout);
                var sw = Stopwatch.StartNew();
                var shadowResponse = await shadow.CompleteAsync(request, cts.Token);
                sw.Stop();

                // LlmRequest carries no caller identity today; UserId is reserved for when
                // the gateway threads one (mirrors how LlmTrace.UserId is currently null).
                var run = BuildShadowRun(
                    feature, primary, primaryLatencyMs, shadowResponse, sw.ElapsedMilliseconds,
                    ComputePromptHash(request), userId: null, shadowProviderKey: shadowKey);

                var writer = scope.ServiceProvider.GetRequiredService<IShadowRunWriter>();
                await writer.WriteAsync(run, CancellationToken.None);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Shadow run failed for feature '{Feature}' (shadow key '{Key}')", feature, shadowKey);
            }
        });
    }

    // ---- pure, deterministic helpers (unit-tested directly) ----

    /// <summary>Sample a shadow run by rate. Deliberately NOT coupled to the tracing
    /// sampler — shadow has its own (paid) economics.</summary>
    public static bool ShouldSample(double rate)
    {
        if (rate >= 1.0) return true;
        if (rate <= 0.0) return false;
        return Random.Shared.NextDouble() < rate;
    }

    /// <summary>
    /// Build a redacted <see cref="Core.ShadowRun"/> from a primary + shadow response.
    /// Both response texts are PII-scrubbed with the SAME redactor the TracingDecorator
    /// uses, BEFORE the row is constructed.
    /// </summary>
    public static Core.ShadowRun BuildShadowRun(
        string featureTag, LlmResponse primary, long primaryMs,
        LlmResponse shadow, long shadowMs, string promptHash, Guid? userId,
        string shadowProviderKey = "") =>
        new(
            Id: Guid.NewGuid(),
            FeatureTag: featureTag,
            PrimaryModelId: primary.ModelId,
            ShadowModelId: shadow.ModelId,
            PrimaryResponse: TraceRedactor.Redact(primary.Text),
            ShadowResponse: TraceRedactor.Redact(shadow.Text),
            PrimaryLatencyMs: (int)Math.Min(primaryMs, int.MaxValue),
            ShadowLatencyMs: (int)Math.Min(shadowMs, int.MaxValue),
            PrimaryCostUsd: primary.Usage.CostUsd,
            ShadowCostUsd: shadow.Usage.CostUsd,
            PrimaryTokensIn: primary.Usage.InputTokens,
            PrimaryTokensOut: primary.Usage.OutputTokens,
            ShadowTokensIn: shadow.Usage.InputTokens,
            ShadowTokensOut: shadow.Usage.OutputTokens,
            PrimaryTraceId: primary.TraceId,
            ShadowTraceId: shadow.TraceId,
            PromptHash: promptHash,
            UserId: userId,
            CreatedAt: DateTimeOffset.UtcNow,
            ShadowProviderKey: shadowProviderKey);

    /// <summary>Same prompt-hash scheme as the TracingDecorator (system prompt + messages JSON).</summary>
    public static string ComputePromptHash(LlmRequest request)
    {
        var messagesJson = JsonSerializer.Serialize(request.Messages);
        var bytes = Encoding.UTF8.GetBytes($"{request.SystemPrompt}\n{messagesJson}");
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
