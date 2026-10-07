using TextStack.Observability;
using Microsoft.Extensions.Configuration;

namespace TextStack.UnitTests;

/// <summary>
/// The environment tag lied once and cost real time: a developer machine running the Worker with the
/// production DSN and a local `.env` saying ASPNETCORE_ENVIRONMENT=Production wrote events into the
/// production Sentry project tagged `environment: Production`. They were later read — entirely
/// reasonably — as a production incident.
///
/// SENTRY_RELEASE is the discriminator: it is set from the GIT_SHA build arg in both Dockerfiles, so
/// every CI-built image has one and no `dotnet run` ever does.
/// </summary>
public class SentryEnvironmentTests
{
    [Fact]
    public void ResolveEnvironmentName_ProductionWithRelease_StaysProduction() =>
        Assert.Equal("Production", SentryBootstrap.ResolveEnvironmentName("Production", "58fec417"));

    [Fact]
    public void ResolveEnvironmentName_ProductionWithoutRelease_IsDowngraded() =>
        Assert.Equal(
            SentryBootstrap.UnverifiedProductionEnvironment,
            SentryBootstrap.ResolveEnvironmentName("Production", null));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void ResolveEnvironmentName_ProductionWithBlankRelease_IsDowngraded(string release) =>
        Assert.Equal(
            SentryBootstrap.UnverifiedProductionEnvironment,
            SentryBootstrap.ResolveEnvironmentName("Production", release));

    /// <summary>Only the Production claim is policed — a dev box calling itself Development is honest.</summary>
    [Theory]
    [InlineData("Development")]
    [InlineData("Staging")]
    [InlineData("Test")]
    public void ResolveEnvironmentName_NonProduction_IsUnchanged(string environmentName) =>
        Assert.Equal(environmentName, SentryBootstrap.ResolveEnvironmentName(environmentName, null));

    [Fact]
    public void Resolve_ProductionWithoutRelease_TagsSettingsAsUnverified()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SENTRY_DSN"] = "https://k@e.ingest.sentry.io/1",
        }).Build();

        var settings = SentryBootstrap.Resolve(config, "Production");

        Assert.Equal(SentryBootstrap.UnverifiedProductionEnvironment, settings!.Environment);
    }

    [Fact]
    public void Resolve_ProductionWithRelease_KeepsProduction()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SENTRY_DSN"] = "https://k@e.ingest.sentry.io/1",
            ["SENTRY_RELEASE"] = "58fec417",
        }).Build();

        var settings = SentryBootstrap.Resolve(config, "Production");

        Assert.Equal("Production", settings!.Environment);
    }
}
