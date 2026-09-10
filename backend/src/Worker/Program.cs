using Application;
using Application.Common.Interfaces;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Infrastructure.Telemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;
using TextStack.Extraction.Extractors;
using TextStack.Extraction.Registry;
using TextStack.Ai.Tools;
using TextStack.Search;
using TextStack.Search.Meilisearch;
using TextStack.Tts;
using Worker.Services;

var builder = Host.CreateApplicationBuilder(args);

// OpenTelemetry
builder.Services.AddTextStackTelemetry(builder.Configuration, "textstack-worker");
builder.Logging.AddTelemetryLogging(builder.Configuration, "textstack-worker");

// Sentry (no-op without SENTRY_DSN). Additive: the OTLP logging provider above is untouched.
builder.Logging.AddTextStackSentry(builder.Configuration, builder.Environment.EnvironmentName);

// Database
var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? "Host=localhost;Port=5432;Database=books;Username=app;Password=changeme";

builder.Services.AddSingleton<Application.Common.Interfaces.ICurrentSite>(
    sp => new Infrastructure.Persistence.CurrentSite(sp.GetRequiredService<IConfiguration>()));

builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseNpgsql(connectionString, o => o.UseVector())
        .UseSnakeCaseNamingConvention()
        .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));

// Register IAppDbContext for scoped services (creates context via factory)
builder.Services.AddScoped<IAppDbContext>(sp =>
    sp.GetRequiredService<IDbContextFactory<AppDbContext>>().CreateDbContext());

// File storage
var storagePath = builder.Configuration["Storage:RootPath"] ?? "/storage";
builder.Services.AddSingleton<IFileStorageService>(new LocalFileStorageService(storagePath));

// Search library
builder.Services.AddTextStackSearch();
var searchProvider = builder.Configuration["Search:Provider"] ?? "postgres";
if (searchProvider == "meilisearch")
    builder.Services.AddMeilisearchProvider(options =>
        builder.Configuration.GetSection("Search:Meilisearch").Bind(options));
else
    builder.Services.AddPostgresFtsProvider(
        _ => () => new NpgsqlConnection(connectionString),
        options => options.ConnectionString = connectionString);

// Extraction
builder.Services.AddSingleton<ITextExtractor, EpubTextExtractor>();
builder.Services.AddSingleton<ITextExtractor, PdfTextExtractor>();
builder.Services.AddSingleton<ITextExtractor, HtmlTextExtractor>();
builder.Services.AddSingleton<IExtractorRegistry, ExtractorRegistry>();

// Image optimization
builder.Services.AddSingleton<IImageOptimizer, ImageOptimizer>();

// Application services (for ISsgRouteProvider, etc.)
builder.Services.AddApplication();

// HTTP client factory (for OllamaLlmService + etc.)
builder.Services.AddHttpClient();

// Book metadata enrichment (AI-Agent-1): the EnrichmentAgent (tool-using, cross-checked, calibrated)
// is the primary IBookMetadataGenerator; it decorates the legacy Ollama BookMetadataGenerator and falls
// back to it on agent error / budget exhaustion. The agent needs the in-process ITool registry +
// AgentLoop, which the API host wires but the Worker did not — register both here.
builder.Services.AddAiTools(typeof(Application.Tools.OpenLibrarySearchTool).Assembly);
TextStack.Ai.Agents.ServiceCollectionExtensions.AddAiAgents(builder.Services);
builder.Services.AddScoped<Application.Agents.EnrichmentAgent>();
builder.Services.AddSingleton<BookMetadataGenerator>();
builder.Services.AddSingleton<IBookMetadataGenerator, EnrichmentAgentMetadataGenerator>();
// Startup observability: probe EVERY provider the route table references, once, before any worker
// loop starts — and open that provider's circuit if it is unreachable, so the loops skip instead of
// hammering. Must stay FIRST among hosted services. Supersedes the old EnrichmentKeyCheck.
builder.Services.AddHostedService<AiProviderReadinessCheck>();
builder.Services.AddSingleton<ITagSuggestionGenerator, TagSuggestionGenerator>();
builder.Services.AddScoped<IPodcastScriptBuilder, PodcastScriptBuilder>();
// TTS + audio assembly for podcasts (Edge TTS is free; ffmpeg is in the Worker image).
builder.Services.Configure<TtsConfiguration>(builder.Configuration.GetSection("Tts"));
builder.Services.AddSingleton<ITtsService, EdgeTtsService>();
builder.Services.AddSingleton<IAudioAssembler, AudioAssembler>();
builder.Services.AddSingleton<IngestionWorkerService>();
// Enrichment-reliability: shared executor (atomic claim + terminal status) used by the ingestion
// inline-kick and the sweep worker below. Singleton — depends only on the DbContext factory + the
// singleton IBookMetadataGenerator.
builder.Services.AddSingleton<UserBookEnrichmentService>();
builder.Services.AddSingleton<UserIngestionService>();
builder.Services.AddHostedService<IngestionWorker>();
// Sweep: drains Pending (API re-enrich reaches the worker here) + reclaims stale Running rows.
builder.Services.AddHostedService<MetadataEnrichmentWorker>();
builder.Services.AddHostedService<PodcastWorker>();

// SSG Rebuild handled by dedicated ssg_worker container (apps/web/scripts/ssg-worker.mjs)

// Guest cleanup (purge inactive guests every 6h)
builder.Services.AddHostedService<GuestCleanupWorker>();

// Admin refresh token cleanup (purge expired rows daily)
builder.Services.AddHostedService<AdminRefreshTokenCleanupWorker>();

// Heartbeat file for docker healthcheck
builder.Services.AddHostedService<HeartbeatWorker>();

// One-shot metadata backfill — heals user_books that have Genre=NULL because
// the worker previously couldn't reach Ollama (wrong env var). Self-skips
// when there's nothing to do, so safe to leave registered.
builder.Services.AddHostedService<MetadataBackfillWorker>();

// TextStack watcher (optional, enable via config)
if (builder.Configuration.GetValue("TextStack:EnableWatcher", false))
{
    builder.Services.AddHostedService<TextStackWatcher>();
}

var host = builder.Build();
host.Run();
