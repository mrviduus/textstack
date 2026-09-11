using Microsoft.Extensions.Configuration;
using Sentry;

namespace Infrastructure.Telemetry;

/// <summary>Resolved Sentry configuration. Only ever constructed when a DSN is actually present.</summary>
public sealed record SentrySettings(string Dsn, string Environment, double TracesSampleRate, bool Debug);

/// <summary>
/// Resolves Sentry configuration and applies the shared option block used by BOTH hosts (API and
/// Worker), so the two can't drift on PII, scrubbing or sampling.
///
/// The no-op contract lives here: <see cref="Resolve"/> returns null when no DSN is configured, and
/// the callers then never engage the SDK at all (see <c>SentryExtensions</c>). That is stricter than
/// passing an empty DSN — which still installs middleware and logs a startup diagnostic — and it is
/// what makes local dev, CI and forks byte-identical to before this feature existed.
/// </summary>
public static class SentryBootstrap
{
    /// <summary>Paths whose transactions are never sampled — a health probe every 30s would be the
    /// single loudest thing in the account and says nothing a failing probe wouldn't.</summary>
    public static readonly string[] IgnoredTransactionPaths = ["/health", "/health/ready"];

    /// <summary>Operations that always sample at 1.0: they are rare (one per agent run / book index)
    /// and they are the entire point of this integration — sampling them at 0.2 would throw away 4 of
    /// every 5 traces we added Sentry to see.</summary>
    public static readonly string[] AlwaysSampledOperations = ["ai.agent", "rag.index"];

    public const double DefaultProductionTracesSampleRate = 0.2;

    public static SentrySettings? Resolve(IConfiguration configuration, string environmentName)
    {
        var dsn = configuration["SENTRY_DSN"]
            ?? configuration["Sentry:Dsn"]
            ?? System.Environment.GetEnvironmentVariable("SENTRY_DSN");

        if (string.IsNullOrWhiteSpace(dsn))
            return null;

        var isDevelopment = string.Equals(environmentName, "Development", StringComparison.OrdinalIgnoreCase);

        // A developer machine does not belong in the error tracker. This is not tidiness: a stale
        // OpenAI key in a local `.env` put 141 `invalid_api_key` events into the account over a
        // month, they sat at the top of the feed, and on 2026-09-11 they were read as a production
        // outage and chased as one. Dev noise in an error tracker is how a real error gets lost —
        // and every one of those events was indistinguishable from the real thing at a glance.
        //
        // The DSN stays in the local `.env` on purpose: the point is that having it configured is
        // harmless, not that it must be deleted and re-pasted. Set `Sentry:EnableInDevelopment=true`
        // to work ON this integration locally, which is the only case that wants the events.
        if (isDevelopment && !configuration.GetValue("Sentry:EnableInDevelopment", false))
            return null;
        var configured = configuration.GetValue<double?>("Sentry:TracesSampleRate");
        var rate = configured ?? (isDevelopment ? 1.0 : DefaultProductionTracesSampleRate);
        rate = Math.Clamp(rate, 0.0, 1.0);

        var debug = configuration.GetValue<bool?>("Sentry:Debug") ?? false;

        var release = configuration["SENTRY_RELEASE"]
            ?? System.Environment.GetEnvironmentVariable("SENTRY_RELEASE");

        return new SentrySettings(dsn.Trim(), ResolveEnvironmentName(environmentName, release), rate, debug);
    }

    /// <summary>
    /// The environment tag, with one guard: a process claiming <c>Production</c> that carries no
    /// release is reported as <see cref="UnverifiedProductionEnvironment"/> instead.
    ///
    /// This exists because the tag lied once and cost real time. A developer machine running the
    /// Worker with the production DSN and a local <c>.env</c> that says
    /// <c>ASPNETCORE_ENVIRONMENT=Production</c> wrote events into the production Sentry project
    /// tagged <c>environment: Production</c> — and they were later read, entirely reasonably, as a
    /// production incident. <c>SENTRY_RELEASE</c> is the discriminator: it is set from the
    /// <c>GIT_SHA</c> build arg in both Dockerfiles, so every CI-built image has one and no
    /// <c>dotnet run</c> ever does. Real production is unaffected.
    ///
    /// Deliberately a rename, not a drop: an unverified event is still worth having, it just must
    /// not masquerade. Filter it out in Sentry with <c>!environment:production-unverified</c>.
    /// </summary>
    public static string ResolveEnvironmentName(string environmentName, string? release)
    {
        var claimsProduction = string.Equals(environmentName, "Production", StringComparison.OrdinalIgnoreCase);
        return claimsProduction && string.IsNullOrWhiteSpace(release)
            ? UnverifiedProductionEnvironment
            : environmentName;
    }

    public const string UnverifiedProductionEnvironment = "production-unverified";

    /// <summary>Pure sampling decision, extracted so it is testable without a hub.</summary>
    public static double SampleRateFor(string? transactionName, string? operation, double baseRate)
    {
        if (transactionName is not null
            && IgnoredTransactionPaths.Any(p => transactionName.Contains(p, StringComparison.OrdinalIgnoreCase)))
            return 0.0;

        if (operation is not null && AlwaysSampledOperations.Contains(operation, StringComparer.OrdinalIgnoreCase))
            return 1.0;

        return baseRate;
    }

    public static void Apply(this SentrySettings settings, SentryOptions options)
    {
        options.Dsn = settings.Dsn;
        options.Environment = settings.Environment;
        options.Debug = settings.Debug;
        options.AttachStacktrace = true;

        // Privacy posture, layer 1: never let the SDK collect anything on its own — no IP, no cookies,
        // no username. (Request-body capture is an ASP.NET-Core-only option and is disabled next to
        // the API wiring, where the options type exposes it.)
        options.SendDefaultPii = false;

        // Release comes from SENTRY_RELEASE (set from the GIT_SHA build arg in the Dockerfiles); the
        // SDK reads it natively, so we deliberately don't set options.Release here.

        // TracesSampler and TracesSampleRate are mutually exclusive — the sampler carries the rate.
        options.TracesSampler = ctx => SampleRateFor(
            ctx.TransactionContext.Name,
            ctx.TransactionContext.Operation,
            settings.TracesSampleRate);

        // Privacy posture, layer 2: everything leaving the process goes through the allowlist.
        options.SetBeforeSend((e, _) => SentryScrubber.Scrub(e));
        options.SetBeforeSendTransaction((t, _) => SentryScrubber.ScrubTransaction(t));
        options.SetBeforeBreadcrumb((b, _) => SentryScrubber.ScrubBreadcrumb(b));
    }
}
