using Application.Admin;
using Application.AdminAuth;
using Application.AdminSettings;
using Application.Auth;
using Application.Authors;
using Application.Books;
using Application.ReadingTracking;
using Application.Reprocessing;
using Application.Seo;
using Application.LLM;
using Application.Vocabulary;
using Application.SsgRebuild;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Application;

public static class DependencyInjection
{
    public static IServiceCollection AddApplication(this IServiceCollection services)
    {
        // Testable clock for time-sensitive flows (device-grant expiry, AI-050a).
        services.TryAddSingleton(TimeProvider.System);

        services.AddScoped<AuthorsService>();
        services.AddScoped<BookService>();
        services.AddScoped<ReadingStatsService>();
        services.AddScoped<ReadingSessionService>();
        services.AddScoped<SeoService>();

        // SEO Backfill Automation
        services.AddScoped<SeoContextBuilder>();
        services.AddScoped<SeoContentApplier>();
        services.AddScoped<SeoCoverageAnalyzer>();
        services.AddScoped<SeoJobProcessor>();
        services.AddScoped<AdminService>();
        services.AddScoped<Ingestion.IngestionService>();
        services.AddScoped<AuthService>();
        services.AddScoped<AdminAuthService>();
        services.AddScoped<AdminSettingsService>();
        services.AddScoped<ReprocessingService>();

        // The single writer of SRS state — shared by ordinary review and Smart session.
        services.AddScoped<VocabularyReviewRecorder>();

        // Vocabulary anti-spiral
        services.AddScoped<WeeklyBudgetService>();
        services.AddScoped<DailyCapService>();
        services.AddScoped<RetirementSweeper>();
        services.AddScoped<ClusterCandidateService>();
        services.AddScoped<ConceptClusteringService>();
        services.AddSingleton<IFrequencyFilter, FrequencyFilter>();

        // Legacy ILlmServiceFactory — now backed by LegacyLlmAdapter over the new
        // stack (AI-005). The old keyed Domain.LLM providers are gone; callers
        // keep this factory until they move to Core.ILlmService directly.
        services.AddSingleton<Domain.LLM.ILlmServiceFactory, LlmServiceFactory>();

        // AI platform (Ai.* libs) — new ILlmService stack (the factory routes here).
        // Trace writer: scoped (per-request DbContext); the singleton
        // TracingDecorator resolves it per-write via a fresh scope.
        services.AddScoped<global::TextStack.Ai.Core.ILlmTraceWriter, Ai.DbLlmTraceWriter>();
        services.AddScoped<global::TextStack.Ai.Core.IAgentRunWriter, Ai.DbAgentRunWriter>();

        // Shadow-run writer: scoped (per-request DbContext); the singleton ModelGateway
        // resolves it inside a fresh scope per fire-and-forget write (AI-075).
        services.AddScoped<global::TextStack.Ai.Core.IShadowRunWriter, Ai.DbShadowRunWriter>();

        // Sampling policy (Ai:Tracing:Sampling). Errors always sampled regardless.
        services.AddSingleton(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();
            return new global::TextStack.Ai.Llm.TracingOptions(
                c.GetValue("Ai:Tracing:Sampling:Default", 1.0),
                c.GetSection("Ai:Tracing:Sampling:PerFeature").Get<Dictionary<string, double>>());
        });

        // Shadow-routing policy (Ai:Shadow). OFF by default (no Routes → no shadow calls).
        services.AddSingleton(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();
            return new global::TextStack.Ai.Llm.ShadowOptions(
                c.GetValue("Ai:Shadow:Default:SampleRate", 0.0),
                c.GetSection("Ai:Shadow:Routes").Get<Dictionary<string, string>>() ?? new(),
                c.GetSection("Ai:Shadow:SampleRates").Get<Dictionary<string, double>>(),
                c.GetValue("Ai:Shadow:TimeoutSeconds", 15));
        });

        // Per-tier entitlements. Same hand-rolled-factory shape as Ai:Budgets below: a typo in
        // configuration degrades to a safe default instead of throwing at startup, because a bad
        // quota value must never be able to stop the whole product from booting.
        services.AddSingleton(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();

            Entitlements.TierEntitlements ReadTier(IConfigurationSection s) =>
                new(s.GetValue<long?>("StorageLimitBytes"),
                    s.GetValue<int?>("MaxBooks"),
                    s.GetValue<int?>("DailyEnrichmentCap"),
                    s.GetValue<bool?>("AiEnabled"));

            var def = ReadTier(c.GetSection("Entitlements:Default"));

            // An unknown or misspelled tier key is SKIPPED, not thrown — that tier then inherits
            // Default and uploads keep working.
            var tiers = new Dictionary<string, Entitlements.TierEntitlements>(StringComparer.OrdinalIgnoreCase);
            foreach (var section in c.GetSection("Entitlements:Tiers").GetChildren())
            {
                if (Enum.TryParse<global::Domain.Enums.UserTier>(section.Key, ignoreCase: true, out var tier))
                    tiers[tier.ToString()] = ReadTier(section);
            }

            var staff = new HashSet<string>(
                (c.GetSection("Entitlements:StaffEmails").Get<string[]>() ?? [])
                    .Where(e => !string.IsNullOrWhiteSpace(e))
                    .Select(e => e.Trim()),
                StringComparer.OrdinalIgnoreCase);

            // Config may only LOWER the single-request ceiling — it is Cloudflare's, not ours.
            var maxSingle = Math.Clamp(
                c.GetValue<long?>("Entitlements:MaxSingleUploadBytes") ?? 80L * 1024 * 1024,
                1L * 1024 * 1024,
                Entitlements.EntitlementOptions.PlatformSingleRequestCeilingBytes);

            var maxStorage = c.GetValue<long?>("Entitlements:MaxStorageLimitBytes") is { } m && m > 0
                ? m
                : 20L * 1024 * 1024 * 1024;

            return new Entitlements.EntitlementOptions(def, tiers, staff, maxSingle, maxStorage);
        });
        services.AddSingleton<Entitlements.IEntitlementResolver, Entitlements.EntitlementResolver>();

        // Per-provider circuit breaker. Registered BEFORE the keyed providers so OllamaLlmClient's
        // optional IProviderHealth resolves. It never routes — it only decides whether a call to an
        // already-chosen provider is worth attempting. Ai:ProviderHealth:Enabled=false is the kill
        // switch and restores byte-for-byte the previous behaviour.
        services.AddSingleton<global::TextStack.Ai.Llm.IProviderHealthAlarm>(sp =>
            new global::TextStack.Ai.Llm.SentryProviderHealthAlarm(sp.GetRequiredService<IConfiguration>()));
        services.AddSingleton<global::TextStack.Ai.Llm.IProviderHealth>(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();
            if (!c.GetValue("Ai:ProviderHealth:Enabled", true))
                return global::TextStack.Ai.Llm.NullProviderHealth.Instance;

            var ladder = (c.GetSection("Ai:ProviderHealth:BackoffMinutes").Get<int[]>() ?? [1, 5, 30])
                .Select(m => TimeSpan.FromMinutes(Math.Max(1, m)))
                .ToArray();

            return new global::TextStack.Ai.Llm.ProviderHealthRegistry(
                sp.GetRequiredService<global::TextStack.Ai.Llm.IProviderHealthAlarm>(),
                sp.GetRequiredService<ILogger<global::TextStack.Ai.Llm.ProviderHealthRegistry>>(),
                ladder);
        });

        // Raw providers (keyed) on Core.ILlmService.
        services.AddKeyedSingleton<global::TextStack.Ai.Core.ILlmService, global::TextStack.Ai.Llm.OpenAiLlmClient>("openai-raw");
        services.AddKeyedSingleton<global::TextStack.Ai.Core.ILlmService, global::TextStack.Ai.Llm.OllamaLlmClient>("ollama-raw");

        // A dedicated OpenAI judge provider on a STRONGER model (Eval:JudgeModel,
        // default gpt-4.1) — separate from the nano generation model so the eval
        // judge is both more reliable and not the same model it's grading.
        services.AddKeyedSingleton<global::TextStack.Ai.Core.ILlmService>("openai-judge-raw", (sp, key) =>
            new global::TextStack.Ai.Llm.OpenAiLlmClient(
                sp.GetRequiredService<IConfiguration>(),
                sp.GetRequiredService<ILogger<global::TextStack.Ai.Llm.OpenAiLlmClient>>(),
                sp.GetRequiredService<IConfiguration>()["Eval:JudgeModel"] ?? "gpt-4.1"));

        // Explain runs a STRONGER generation model than the nano default (OpenAI:Explain:Model,
        // default gpt-4.1-mini). Routed per-feature (Ai:Routes:explain[.toolcall] → openai-explain)
        // so translate stays on nano. This model is also the distillation teacher.
        services.AddKeyedSingleton<global::TextStack.Ai.Core.ILlmService>("openai-explain-raw", (sp, key) =>
            new global::TextStack.Ai.Llm.OpenAiLlmClient(
                sp.GetRequiredService<IConfiguration>(),
                sp.GetRequiredService<ILogger<global::TextStack.Ai.Llm.OpenAiLlmClient>>(),
                sp.GetRequiredService<IConfiguration>()["OpenAI:Explain:Model"] ?? "gpt-4.1-mini"));

        // Decorated providers (keyed): TracingDecorator wraps each raw provider.
        foreach (var providerKey in global::TextStack.Ai.Llm.AiProviderKeys.Registered)
        {
            services.AddKeyedSingleton<global::TextStack.Ai.Core.ILlmService>(providerKey, (sp, key) =>
                new global::TextStack.Ai.Llm.TracingDecorator(
                    sp.GetRequiredKeyedService<global::TextStack.Ai.Core.ILlmService>($"{key}-raw"),
                    sp.GetRequiredService<IServiceScopeFactory>(),
                    sp.GetRequiredService<global::TextStack.Ai.Llm.TracingOptions>(),
                    sp.GetRequiredService<ILogger<global::TextStack.Ai.Llm.TracingDecorator>>(),
                    (string)key!));
        }

        // RegistryModelRouteProvider (below) + RollingSpendTracker depend on IMemoryCache.
        // The API host calls AddMemoryCache(), but the Worker host does NOT — so without this
        // the Worker crash-loops on startup ("Unable to resolve IMemoryCache") and processes
        // ZERO ingestion jobs (uploads + clips stuck Queued forever). Idempotent (TryAdd).
        services.AddMemoryCache();

        // Table-driven primary routing (Phase 12 RLOps): the gateway consults this BEFORE
        // its config route, so an admin promote/rollback flips traffic without a redeploy.
        // Singleton (caches one snapshot of the `models` registry); hot-path safe + never throws.
        services.AddSingleton<global::TextStack.Ai.Core.IModelRouteProvider, Ai.RegistryModelRouteProvider>();

        // Cost-aware routing policy (Ai:Budgets, Phase 12 RLOps slice 4). OFF by default
        // (empty Features + Default mode Off → no enforcement). A budgeted feature can hard-stop
        // (→429) or reroute to a cheaper fallback provider once over its daily USD cap.
        services.AddSingleton(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();

            global::TextStack.Ai.Llm.BudgetMode ParseMode(string? raw) =>
                Enum.TryParse<global::TextStack.Ai.Llm.BudgetMode>(raw, ignoreCase: true, out var m)
                    ? m
                    : global::TextStack.Ai.Llm.BudgetMode.Off;

            var defaultMode = ParseMode(c["Ai:Budgets:Default:Mode"]);
            var def = new global::TextStack.Ai.Llm.FeatureBudget(null, null, defaultMode);

            var features = new Dictionary<string, global::TextStack.Ai.Llm.FeatureBudget>();
            foreach (var section in c.GetSection("Ai:Budgets:Features").GetChildren())
            {
                var daily = section.GetValue<decimal?>("DailyUsd");
                var fallback = section["Fallback"];
                var mode = ParseMode(section["Mode"]);
                features[section.Key] = new global::TextStack.Ai.Llm.FeatureBudget(daily, fallback, mode);
            }

            return new global::TextStack.Ai.Llm.BudgetOptions(def, features);
        });

        // Per-feature daily spend tracker (in-memory, UTC rollover, lazy-seeds from llm_traces).
        // Singleton: the gateway reads/records spend on every call; lives behind the never-throw
        // ISpendTracker contract. Registered BEFORE the gateway (the gateway depends on it).
        services.AddSingleton<global::TextStack.Ai.Core.ISpendTracker, Ai.RollingSpendTracker>();

        // One-click promote / rollback of the primary model for a feature.
        services.AddScoped<Ai.ModelPromotionService>();

        // Silent-fallback alarm (Sentry): an EXPENSIVE task resolving via Ai:DefaultProvider instead
        // of an explicit route is the 2026-07-14 pdf.parse → Ollama incident (since deleted). Throttled per
        // (task, provider) so a 106-page PDF raises one event, not 106. Also sets the shared
        // cooldown used by LlmFailureAlarm.
        services.AddSingleton<global::TextStack.Ai.Llm.IRouteAlarm>(sp =>
        {
            var c = sp.GetRequiredService<IConfiguration>();
            var cooldown = TimeSpan.FromMinutes(
                Math.Max(1, c.GetValue<int?>("Ai:RouteAlarm:CooldownMinutes") ?? 60));
            global::TextStack.Ai.Llm.LlmFailureAlarm.Configure(cooldown);
            return new global::TextStack.Ai.Llm.SentryRouteAlarm(c);
        });

        // Default Core.ILlmService = the gateway (routes FeatureTag → decorated provider;
        // registry-first primary routing + optional fire-and-forget shadow routing per Ai:Shadow).
        services.AddSingleton<global::TextStack.Ai.Core.ILlmService>(sp =>
            new global::TextStack.Ai.Llm.ModelGateway(
                sp,
                sp.GetRequiredService<IConfiguration>(),
                sp.GetRequiredService<IServiceScopeFactory>(),
                sp.GetRequiredService<global::TextStack.Ai.Llm.ShadowOptions>(),
                sp.GetRequiredService<global::TextStack.Ai.Core.IModelRouteProvider>(),
                sp.GetRequiredService<global::TextStack.Ai.Core.ISpendTracker>(),
                sp.GetRequiredService<global::TextStack.Ai.Llm.BudgetOptions>(),
                sp.GetRequiredService<ILogger<global::TextStack.Ai.Llm.ModelGateway>>(),
                sp.GetService<global::TextStack.Ai.Llm.IRouteAlarm>()));

        // Embeddings (Phase 4 RAG). Single OpenAI provider; resolved lazily so a keyless
        // host still starts (the client throws on construction without a key).
        services.AddSingleton<global::TextStack.Ai.Core.IEmbeddingService, global::TextStack.Ai.Llm.OpenAiEmbeddingClient>();

        // SSG Rebuild - interfaces for SOLID compliance
        services.AddScoped<ISsgRouteProvider, SsgRouteProvider>();
        services.AddScoped<ISsgJobService, SsgRebuildService>();

        return services;
    }

    public static IServiceCollection AddAuthSettings(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<JwtSettings>(configuration.GetSection(JwtSettings.SectionName));
        services.Configure<GoogleSettings>(configuration.GetSection(GoogleSettings.SectionName));
        services.Configure<AppleSettings>(configuration.GetSection(AppleSettings.SectionName));
        return services;
    }
}
