using System.Reflection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Infrastructure.Telemetry;

public static class TelemetryExtensions
{
    public static IServiceCollection AddOnlineLibTelemetry(
        this IServiceCollection services,
        IConfiguration configuration,
        string serviceName,
        Action<TracerProviderBuilder>? configureTracing = null)
    {
        var otlpEndpoint = configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]
            ?? Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT");

        var useConsoleExporter = string.IsNullOrEmpty(otlpEndpoint);
        var environment = configuration["ASPNETCORE_ENVIRONMENT"]
            ?? Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT")
            ?? "Development";

        var serviceVersion = Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "1.0.0";

        var resourceBuilder = ResourceBuilder.CreateDefault()
            .AddService(
                serviceName: serviceName,
                serviceVersion: serviceVersion)
            .AddAttributes([
                new("deployment.environment", environment),
                new("host.name", Environment.MachineName)
            ]);

        // Tracing
        services.AddOpenTelemetry()
            .WithTracing(builder =>
            {
                builder
                    .SetResourceBuilder(resourceBuilder)
                    .AddSource(TelemetryConstants.IngestionActivitySourceName)
                    .AddSource(TelemetryConstants.ApiActivitySourceName)
                    .AddEntityFrameworkCoreInstrumentation(opts =>
                    {
                        opts.SetDbStatementForText = true; // Include SQL in traces
                    });

                // Allow additional instrumentation configuration
                configureTracing?.Invoke(builder);

                if (useConsoleExporter)
                {
                    builder.AddConsoleExporter();
                }
                else
                {
                    builder.AddOtlpExporter(options =>
                    {
                        options.Endpoint = new Uri(otlpEndpoint!);
                    });
                }
            })
            .WithMetrics(builder =>
            {
                builder
                    .SetResourceBuilder(resourceBuilder)
                    .AddMeter(TelemetryConstants.MeterName)
                    .AddRuntimeInstrumentation();

                if (useConsoleExporter)
                {
                    builder.AddConsoleExporter();
                }
                else
                {
                    builder.AddOtlpExporter(options =>
                    {
                        options.Endpoint = new Uri(otlpEndpoint!);
                    });
                }
            })
            .WithLogging(builder =>
            {
                builder.SetResourceBuilder(resourceBuilder);

                if (useConsoleExporter)
                {
                    builder.AddConsoleExporter();
                }
                else
                {
                    builder.AddOtlpExporter(options =>
                    {
                        options.Endpoint = new Uri(otlpEndpoint!);
                    });
                }
            });

        return services;
    }

    public static ILoggingBuilder AddTelemetryLogging(this ILoggingBuilder builder)
    {
        builder.Configure(options =>
        {
            options.ActivityTrackingOptions =
                ActivityTrackingOptions.TraceId |
                ActivityTrackingOptions.SpanId |
                ActivityTrackingOptions.ParentId;
        });

        return builder;
    }
}
