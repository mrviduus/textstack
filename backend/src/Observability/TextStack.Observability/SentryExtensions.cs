using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Sentry.Extensions.Logging;

namespace TextStack.Observability;

/// <summary>
/// Sentry for hosts without a Sentry request pipeline — the Worker and the MCP server. Sentry rides
/// the logging provider: <c>logger.LogError(ex, …)</c> becomes an event.
///
/// No-op when no DSN is configured — we don't call into the SDK at all rather than initialising it
/// with an empty DSN, so a local dev run, a CI run and a fork behave exactly as before this feature.
/// (The API host's equivalent lives next to its other observability wiring, in
/// <c>Api/Extensions/ServiceCollectionExtensions.Hosting.cs</c>, because it needs ASP.NET types.)
/// </summary>
public static class SentryExtensions
{
    /// <param name="service">The <see cref="SentryBootstrap.ServiceTag"/> value — the compose service name.</param>
    /// <param name="configure">Host-specific tightening, applied after the shared options.</param>
    public static ILoggingBuilder AddTextStackSentry(
        this ILoggingBuilder logging, IConfiguration configuration, string environmentName, string service,
        Action<SentryLoggingOptions>? configure = null)
    {
        var settings = SentryBootstrap.Resolve(configuration, environmentName);
        if (settings is null)
            return logging;

        logging.AddSentry(options =>
        {
            settings.Apply(options, service);
            options.MinimumEventLevel = LogLevel.Error;
            configure?.Invoke(options);
        });

        return logging;
    }
}
