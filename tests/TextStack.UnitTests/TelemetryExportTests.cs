using Infrastructure.Telemetry;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OpenTelemetry.Logs;
using OpenTelemetry.Trace;

namespace TextStack.UnitTests;

/// <summary>
/// OpenTelemetry is registered only when an OTLP endpoint is configured. Production used to export to
/// a container the deploy never starts — every batch failed to resolve and was dropped, silently — and
/// the no-endpoint fallback was a console exporter that would have printed every span into the log.
/// No endpoint now means nothing at all.
/// </summary>
public class TelemetryExportTests
{
    private static IConfiguration Config(string? endpoint) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint })
            .Build();

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void OtlpEndpoint_Blank_IsNull(string endpoint) =>
        // Compose passes `${OTEL_EXPORTER_OTLP_ENDPOINT:-}`: unset in .env arrives as "".
        Assert.Null(TelemetryExtensions.OtlpEndpoint(Config(endpoint)));

    [Fact]
    public void OtlpEndpoint_Set_IsReturned() =>
        Assert.Equal("http://aspire-dashboard:18889", TelemetryExtensions.OtlpEndpoint(Config(" http://aspire-dashboard:18889 ")));

    [Fact]
    public void AddTextStackTelemetry_NoEndpoint_RegistersNothing()
    {
        var services = new ServiceCollection();

        services.AddTextStackTelemetry(Config(""), "textstack-test");

        Assert.Empty(services);
    }

    [Fact]
    public void AddTextStackTelemetry_Endpoint_RegistersTracerProvider()
    {
        var services = new ServiceCollection();

        services.AddTextStackTelemetry(Config("http://aspire-dashboard:18889"), "textstack-test");

        using var provider = services.BuildServiceProvider();
        Assert.NotNull(provider.GetService<TracerProvider>());
    }

    [Fact]
    public void AddTelemetryLogging_NoEndpoint_AddsNoOpenTelemetryLogger()
    {
        var services = new ServiceCollection();
        services.AddLogging(logging => logging.AddTelemetryLogging(Config(""), "textstack-test"));

        using var provider = services.BuildServiceProvider();
        Assert.DoesNotContain(provider.GetServices<ILoggerProvider>(), p => p is OpenTelemetryLoggerProvider);
    }

    [Fact]
    public void AddTelemetryLogging_Endpoint_AddsOpenTelemetryLogger()
    {
        var services = new ServiceCollection();
        services.AddLogging(logging => logging.AddTelemetryLogging(Config("http://aspire-dashboard:18889"), "textstack-test"));

        using var provider = services.BuildServiceProvider();
        Assert.Contains(provider.GetServices<ILoggerProvider>(), p => p is OpenTelemetryLoggerProvider);
    }
}
