using System.Diagnostics;
using System.Reflection;

namespace Infrastructure.Telemetry;

public static class TelemetryConstants
{
    public static readonly string ServiceVersion =
        Assembly.GetEntryAssembly()?.GetName().Version?.ToString() ?? "1.0.0";

    public const string ApiActivitySourceName = "TextStack.Api";
}

public static class ApiActivitySource
{
    public static readonly ActivitySource Source = new(
        TelemetryConstants.ApiActivitySourceName,
        TelemetryConstants.ServiceVersion);
}
