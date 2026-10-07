using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Infrastructure.Telemetry;

/// <summary>
/// OpenTelemetry traces, metrics and logs — exported over OTLP when, and only when,
/// <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> is set. Without it nothing is registered: no exporter, no
/// listener, no cost.
///
/// Production sets no endpoint. Until 2026-10 it pointed at <c>aspire-dashboard</c>, a container the
/// deploy never starts, so every batch was built, failed to resolve and was dropped — silently, since
/// the exporter reports through an EventSource rather than a log line. Errors and a sample of request
/// traces go to Sentry instead (TextStack.Observability). Locally, start Aspire
/// (<c>docker compose --profile observability up -d aspire-dashboard</c>) and set the endpoint.
/// The console exporter that used to stand in for a missing endpoint is gone: in a container it
/// printed every span and metric into the log. See docs/01-architecture/delivery.md, Observability.
/// </summary>
public static class TelemetryExtensions
{
    /// <summary>The configured OTLP endpoint, or null when telemetry export is off.</summary>
    public static string? OtlpEndpoint(IConfiguration configuration)
    {
        var endpoint = configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]
            ?? Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT");
        return string.IsNullOrWhiteSpace(endpoint) ? null : endpoint.Trim();
    }

    public static IServiceCollection AddTextStackTelemetry(
        this IServiceCollection services,
        IConfiguration configuration,
        string serviceName,
        Action<TracerProviderBuilder>? configureTracing = null)
    {
        if (OtlpEndpoint(configuration) is not { } otlpEndpoint)
            return services;

        var resourceBuilder = Resource(configuration, serviceName);

        services.AddOpenTelemetry()
            .WithTracing(builder =>
            {
                builder
                    .SetResourceBuilder(resourceBuilder)
                    .AddSource(TelemetryConstants.IngestionActivitySourceName)
                    .AddSource(TelemetryConstants.ApiActivitySourceName)
                    // AI-pipeline spans (agent runs, RAG indexing). TraceScope dual-writes them to
                    // Sentry as well; this registration is what keeps them flowing to OTLP/Aspire.
                    .AddSource(TextStack.Ai.Core.AiActivitySource.Name)
                    .AddEntityFrameworkCoreInstrumentation(opts =>
                    {
                        opts.SetDbStatementForText = true; // Include SQL in traces
                    });

                // Allow additional instrumentation configuration
                configureTracing?.Invoke(builder);

                builder.AddOtlpExporter(options =>
                {
                    options.Endpoint = new Uri(otlpEndpoint);
                    options.Protocol = OtlpExportProtocol.Grpc;
                });
            })
            .WithMetrics(builder =>
            {
                builder
                    .SetResourceBuilder(resourceBuilder)
                    .AddMeter(TelemetryConstants.MeterName)
                    .AddRuntimeInstrumentation()
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddOtlpExporter(options =>
                    {
                        options.Endpoint = new Uri(otlpEndpoint);
                        options.Protocol = OtlpExportProtocol.Grpc;
                    });
            });

        return services;
    }

    public static ILoggingBuilder AddTelemetryLogging(
        this ILoggingBuilder builder,
        IConfiguration configuration,
        string serviceName)
    {
        builder.Configure(options =>
        {
            options.ActivityTrackingOptions =
                ActivityTrackingOptions.TraceId |
                ActivityTrackingOptions.SpanId |
                ActivityTrackingOptions.ParentId;
        });

        if (OtlpEndpoint(configuration) is not { } otlpEndpoint)
            return builder;

        builder.AddOpenTelemetry(options =>
        {
            options.SetResourceBuilder(Resource(configuration, serviceName));
            options.IncludeFormattedMessage = true;
            options.IncludeScopes = true;
            options.AddOtlpExporter(exporterOptions =>
            {
                exporterOptions.Endpoint = new Uri(otlpEndpoint);
                exporterOptions.Protocol = OtlpExportProtocol.Grpc;
            });
        });

        return builder;
    }

    private static ResourceBuilder Resource(IConfiguration configuration, string serviceName)
    {
        var environment = configuration["ASPNETCORE_ENVIRONMENT"]
            ?? Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
            ?? "Development";
        var serviceVersion = Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "1.0.0";

        return ResourceBuilder.CreateDefault()
            .AddService(serviceName: serviceName, serviceVersion: serviceVersion)
            .AddAttributes([
                new("deployment.environment", environment),
                new("host.name", Environment.MachineName)
            ]);
    }
}
