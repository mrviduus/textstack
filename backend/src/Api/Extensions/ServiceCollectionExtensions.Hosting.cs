using Infrastructure.Telemetry;
using Microsoft.AspNetCore.Http.Features;
using OpenTelemetry.Trace;
using Sentry.AspNetCore;
using Sentry.Extensibility;

namespace Api.Extensions;

/// <summary>
/// DI + host-configuration extension methods extracted from Program.cs (refactor R2).
/// Purely behavior-preserving: same registrations, same lifetimes, same order where it
/// matters — grouped by concern so Program.cs reads like a table of contents.
///
/// Split across partial files by concern:
///   - .Hosting.cs        upload limits, OpenTelemetry/logging
///   - .Cors.cs           CORS default policy
///   - .Ai.cs             AI eval runners, agents, tools, crews
///   - .Persistence.cs    ICurrentSite, DbContext, file storage
///   - .Search.cs         search providers, similar/hybrid catalog, reindex
///   - .Content.cs        vocabulary, images, sites, user books, email, TTS
///   - .HostedServices.cs background workers
///   - .RateLimiting.cs   rate-limiter policies
/// </summary>
public static partial class ServiceCollectionExtensions
{
    // Match nginx client_max_body_size (500MB) + per-user storage quota.
    // Default Kestrel cap is 30MB → users hit 413 on real-world PDFs.
    private const long MaxUploadBytes = 500L * 1024 * 1024;

    /// <summary>Kestrel + multipart body limits sized to match nginx (500MB).</summary>
    public static WebApplicationBuilder AddTextStackUploadLimits(this WebApplicationBuilder builder)
    {
        builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = MaxUploadBytes);
        builder.Services.Configure<FormOptions>(o =>
        {
            o.MultipartBodyLengthLimit = MaxUploadBytes;
            o.ValueLengthLimit = int.MaxValue;
            o.MultipartHeadersLengthLimit = int.MaxValue;
        });
        return builder;
    }

    /// <summary>OpenTelemetry tracing/metrics + telemetry logging for the API host.</summary>
    public static WebApplicationBuilder AddTextStackObservability(this WebApplicationBuilder builder)
    {
        builder.Services.AddTextStackTelemetry(
            builder.Configuration,
            "textstack-api",
            tracing => tracing
                .AddAspNetCoreInstrumentation(options =>
                {
                    options.RecordException = true;
                    options.EnrichWithHttpRequest = (activity, request) =>
                    {
                        activity.SetTag("http.client_ip", request.HttpContext.Connection.RemoteIpAddress?.ToString());
                    };
                })
                .AddHttpClientInstrumentation());
        builder.Logging.AddTelemetryLogging(builder.Configuration, "textstack-api");
        return builder;
    }

    /// <summary>
    /// Sentry for the API host. No-op when <c>SENTRY_DSN</c> is unset — we don't engage the SDK at
    /// all (rather than initialising it with an empty DSN), so local dev, CI and forks are unchanged.
    ///
    /// Note the interaction with <c>ExceptionMiddleware</c>: it catches every exception and returns a
    /// 500, so nothing ever propagates to Sentry's middleware. Unhandled errors reach Sentry through
    /// its ILogger integration instead, via that middleware's
    /// <c>logger.LogError(ex, "Unhandled exception")</c> — hence <c>MinimumEventLevel = Error</c>.
    /// The typed domain exceptions it maps to 4xx are never logged, and are additionally dropped in
    /// <see cref="SentryScrubber"/> in case that ever changes.
    /// </summary>
    public static WebApplicationBuilder AddTextStackSentry(this WebApplicationBuilder builder)
    {
        var settings = SentryBootstrap.Resolve(builder.Configuration, builder.Environment.EnvironmentName);
        if (settings is null)
            return builder;

        builder.WebHost.UseSentry(options =>
        {
            settings.Apply(options);

            // Never read a request body into an event: our uploads are books and our POST bodies are
            // reader prompts — neither belongs in an error tracker.
            options.MaxRequestBodySize = RequestSize.None;
            options.MinimumEventLevel = LogLevel.Error;
        });

        return builder;
    }
}
