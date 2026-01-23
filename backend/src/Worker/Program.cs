using System.Text;
using Application.Common.Interfaces;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Infrastructure.Telemetry;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Npgsql;
using OnlineLib.Extraction.Contracts;
using OnlineLib.Extraction.Extractors;
using OnlineLib.Extraction.Ocr;
using OnlineLib.Extraction.Registry;
using OnlineLib.Search;
using Worker.Services;

// Register legacy encodings (windows-1251 for FB2, etc.)
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var builder = Host.CreateApplicationBuilder(args);

// OpenTelemetry
builder.Services.AddOnlineLibTelemetry(builder.Configuration, "onlinelib-worker");
builder.Logging.AddTelemetryLogging(builder.Configuration, "onlinelib-worker");

// Database
var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? "Host=localhost;Port=5432;Database=books;Username=app;Password=changeme";

builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseNpgsql(connectionString)
        .UseSnakeCaseNamingConvention()
        .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));

// File storage
var storagePath = builder.Configuration["Storage:RootPath"] ?? "/storage";
builder.Services.AddSingleton<IFileStorageService>(new LocalFileStorageService(storagePath));

// Search library
builder.Services.AddOnlineLibSearch();
builder.Services.AddPostgresFtsProvider(
    _ => () => new NpgsqlConnection(connectionString),
    options => options.ConnectionString = connectionString);

// Extraction options (OCR disabled by default)
var extractionOptions = new ExtractionOptions
{
    EnableOcrFallback = builder.Configuration.GetValue("Extraction:EnableOcrFallback", false),
    MaxPagesForOcr = builder.Configuration.GetValue("Extraction:MaxPagesForOcr", 50),
    OcrLanguage = builder.Configuration.GetValue("Extraction:OcrLanguage", "eng") ?? "eng"
};
builder.Services.AddSingleton(extractionOptions);

// OCR engine (optional, only created if OCR enabled)
IOcrEngine? ocrEngine = null;
if (extractionOptions.EnableOcrFallback)
{
    var tessDataPath = builder.Configuration.GetValue("Extraction:TessDataPath", "/usr/share/tessdata") ?? "/usr/share/tessdata";
    ocrEngine = new TesseractOcrEngine(tessDataPath);
    builder.Services.AddSingleton(ocrEngine);
}

// Extraction
builder.Services.AddSingleton<ITextExtractor, EpubTextExtractor>();
builder.Services.AddSingleton<ITextExtractor, Fb2TextExtractor>();
builder.Services.AddSingleton<ITextExtractor, TxtTextExtractor>();
builder.Services.AddSingleton<ITextExtractor, MdTextExtractor>();
builder.Services.AddSingleton<ITextExtractor>(new PdfTextExtractor(extractionOptions, ocrEngine));
builder.Services.AddSingleton<IExtractorRegistry, ExtractorRegistry>();

// Services
builder.Services.AddSingleton<IngestionWorkerService>();
builder.Services.AddHostedService<IngestionWorker>();

// SEO Crawl
builder.Services.AddHttpClient("SeoCrawl");
builder.Services.AddSingleton<SeoCrawlWorkerService>();
builder.Services.AddHostedService<SeoCrawlWorker>();

// TextStack watcher (optional, enable via config)
if (builder.Configuration.GetValue("TextStack:EnableWatcher", false))
{
    builder.Services.AddHostedService<TextStackWatcher>();
}

var host = builder.Build();
host.Run();
