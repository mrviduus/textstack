using Infrastructure.Telemetry;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests;

/// <summary>
/// Locks the Sentry no-op contract and the sampling policy.
///
/// The no-op matters more than it looks: local dev, CI and forks run without a DSN, and the whole
/// integration is required to be invisible there. Resolve() returning null is what makes the hosts
/// skip UseSentry/AddSentry entirely instead of initialising the SDK with an empty DSN.
/// </summary>
public class SentryBootstrapTests
{
    private static IConfiguration Config(params (string Key, string? Value)[] pairs) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(pairs.ToDictionary(p => p.Key, p => p.Value))
            .Build();

    [Fact]
    public void Resolve_DsnMissing_ReturnsNull() =>
        Assert.Null(SentryBootstrap.Resolve(Config(), "Production"));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Resolve_DsnBlank_ReturnsNull(string dsn) =>
        Assert.Null(SentryBootstrap.Resolve(Config(("SENTRY_DSN", dsn)), "Production"));

    [Fact]
    public void Resolve_DsnFromEnvStyleKey_ReturnsSettings()
    {
        var settings = SentryBootstrap.Resolve(Config(("SENTRY_DSN", "https://key@example.ingest.sentry.io/1")), "Production");

        Assert.NotNull(settings);
        Assert.Equal("https://key@example.ingest.sentry.io/1", settings.Dsn);
        // No SENTRY_RELEASE here, so the environment is reported as unverified — see
        // SentryEnvironmentTests for why a release-less "Production" claim is not trusted.
        Assert.Equal(SentryBootstrap.UnverifiedProductionEnvironment, settings.Environment);
    }

    [Fact]
    public void Resolve_DsnFromAppSettingsKey_ReturnsSettings()
    {
        var settings = SentryBootstrap.Resolve(Config(("Sentry:Dsn", "https://key@example.ingest.sentry.io/2")), "Staging");

        Assert.NotNull(settings);
        Assert.Equal("https://key@example.ingest.sentry.io/2", settings.Dsn);
    }

    [Fact]
    public void Resolve_Production_DefaultsToTwentyPercent()
    {
        var settings = SentryBootstrap.Resolve(Config(("SENTRY_DSN", "https://k@e.ingest.sentry.io/1")), "Production");

        Assert.Equal(SentryBootstrap.DefaultProductionTracesSampleRate, settings!.TracesSampleRate);
    }

    [Fact]
    public void Resolve_Development_DefaultsToFullSampling()
    {
        // Development reports nothing by default now, so the sampling rule is only reachable through
        // the opt-in — the rule itself is unchanged: when you ARE looking at dev traces, you want all
        // of them, not one in five.
        var settings = SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://k@e.ingest.sentry.io/1"), ("Sentry:EnableInDevelopment", "true")),
            "Development");

        Assert.Equal(1.0, settings!.TracesSampleRate);
    }

    [Fact]
    public void Resolve_ConfiguredRate_OverridesDefault()
    {
        var settings = SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://k@e.ingest.sentry.io/1"), ("Sentry:TracesSampleRate", "0.5")),
            "Production");

        Assert.Equal(0.5, settings!.TracesSampleRate);
    }

    [Theory]
    [InlineData("5", 1.0)]
    [InlineData("-1", 0.0)]
    public void Resolve_RateOutOfRange_IsClamped(string configured, double expected)
    {
        var settings = SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://k@e.ingest.sentry.io/1"), ("Sentry:TracesSampleRate", configured)),
            "Production");

        Assert.Equal(expected, settings!.TracesSampleRate);
    }

    [Theory]
    [InlineData("GET /health")]
    [InlineData("GET /health/ready")]
    public void SampleRateFor_HealthProbe_IsNeverSampled(string transactionName) =>
        Assert.Equal(0.0, SentryBootstrap.SampleRateFor(transactionName, "http.server", 0.2));

    [Theory]
    [InlineData("ai.agent")]
    [InlineData("rag.index")]
    public void SampleRateFor_AiOperation_IsAlwaysSampled(string operation) =>
        Assert.Equal(1.0, SentryBootstrap.SampleRateFor("agent.run", operation, 0.2));

    [Fact]
    public void SampleRateFor_HttpRequest_UsesBaseRate() =>
        Assert.Equal(0.2, SentryBootstrap.SampleRateFor("GET /books", "http.server", 0.2));

    // ---- Development is not reported ---------------------------------------------------------

    [Fact]
    public void Resolve_Development_ReturnsNull_EvenWithADsn()
    {
        // The local `.env` legitimately carries a DSN — the integration is developed against it. What
        // must not happen is a developer machine writing into the account: a stale local OpenAI key
        // put 141 `invalid_api_key` events there over a month, and they were eventually read as a
        // production outage. Null here is what keeps the hosts from engaging the SDK at all.
        var settings = SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://key@example.ingest.sentry.io/1")), "Development");

        Assert.Null(settings);
    }

    [Theory]
    [InlineData("development")]
    [InlineData("DEVELOPMENT")]
    public void Resolve_Development_IsMatchedRegardlessOfCase(string environmentName) =>
        Assert.Null(SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://key@example.ingest.sentry.io/1")), environmentName));

    [Fact]
    public void Resolve_Development_WithExplicitOptIn_StillReports()
    {
        // The escape hatch exists so this integration can be worked on locally. Without it the only
        // way to test a change to the Sentry wiring would be to ship it.
        var settings = SentryBootstrap.Resolve(
            Config(("SENTRY_DSN", "https://key@example.ingest.sentry.io/1"),
                   ("Sentry:EnableInDevelopment", "true")), "Development");

        Assert.NotNull(settings);
        Assert.Equal("Development", settings.Environment);
    }

    [Fact]
    public void Resolve_NonDevelopmentEnvironments_AreUnaffected()
    {
        // The change must cost nothing anywhere else — Staging and Production report exactly as before.
        foreach (var env in new[] { "Staging", "Production", "production-like-thing" })
            Assert.NotNull(SentryBootstrap.Resolve(
                Config(("SENTRY_DSN", "https://key@example.ingest.sentry.io/1")), env));
    }
}

