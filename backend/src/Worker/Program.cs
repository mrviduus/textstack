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
using TextStack.Search;
using Worker.Services;

var builder = Host.CreateApplicationBuilder(args);

// OpenTelemetry
builder.Services.AddTextStackTelemetry(builder.Configuration, "textstack-worker");
builder.Logging.AddTelemetryLogging(builder.Configuration, "textstack-worker");

// Database
var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? "Host=localhost;Port=5432;Database=books;Username=app;Password=changeme";

builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseNpgsql(connectionString)
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
builder.Services.AddPostgresFtsProvider(
    _ => () => new NpgsqlConnection(connectionString),
    options => options.ConnectionString = connectionString);

// Extraction
builder.Services.AddSingleton<ITextExtractor, EpubTextExtractor>();
builder.Services.AddSingleton<ITextExtractor, PdfTextExtractor>();
builder.Services.AddSingleton<IExtractorRegistry, ExtractorRegistry>();

// Application services (for ISsgRouteProvider, etc.)
builder.Services.AddApplication();

// Services
builder.Services.AddSingleton<IngestionWorkerService>();
builder.Services.AddSingleton<UserIngestionService>();
builder.Services.AddHostedService<IngestionWorker>();

// SEO Crawl
builder.Services.AddHttpClient("SeoCrawl");
builder.Services.AddSingleton<SeoCrawlWorkerService>();
builder.Services.AddHostedService<SeoCrawlWorker>();

// SSG Rebuild handled by dedicated ssg_worker container (apps/web/scripts/ssg-worker.mjs)

// TextStack watcher (optional, enable via config)
if (builder.Configuration.GetValue("TextStack:EnableWatcher", false))
{
    builder.Services.AddHostedService<TextStackWatcher>();
}

var host = builder.Build();
host.Run();
