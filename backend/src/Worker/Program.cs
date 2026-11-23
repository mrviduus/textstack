using Application;
using Infrastructure.Persistence;
using Infrastructure.Services;
using Infrastructure.Telemetry;
using TextStack.Observability;
using Worker.Services;

var builder = Host.CreateApplicationBuilder(args);

// OpenTelemetry
builder.Services.AddTextStackTelemetry(builder.Configuration, "textstack-worker");
builder.Logging.AddTelemetryLogging(builder.Configuration, "textstack-worker");

// Sentry (no-op without SENTRY_DSN). Additive: the OTLP logging provider above is untouched.
builder.Logging.AddTextStackSentry(builder.Configuration, builder.Environment.EnvironmentName, "worker");

// Database
builder.Services.AddTextStackDataAccess(builder.Configuration.AppConnectionString());

builder.Services.AddTextStackFileStores(builder.Configuration);

// Application services
builder.Services.AddApplication();
builder.Services.AddIdentityPorts();

// HTTP client factory (for OllamaLlmService + etc.)
builder.Services.AddHttpClient();

builder.Services.AddWorkerLoops(builder.Configuration);

var host = builder.Build();
host.Run();
