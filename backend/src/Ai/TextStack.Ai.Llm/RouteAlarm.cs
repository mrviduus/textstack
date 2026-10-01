using Microsoft.Extensions.Configuration;

namespace TextStack.Ai.Llm;

/// <summary>Why <see cref="ModelGateway"/> ended up on the provider it did.</summary>
public enum RouteReason
{
    /// <summary>A registry Primary row or an <c>Ai:Routes:{feature}</c> entry named this provider.</summary>
    RouteMatched,

    /// <summary>Nothing matched the feature — we fell through to <c>Ai:DefaultProvider</c>.</summary>
    DefaultFallback,
}

public static class RouteReasonNames
{
    public const string RouteMatched = "route_matched";
    public const string DefaultFallback = "default_fallback";

    public static string For(RouteReason reason) =>
        reason == RouteReason.RouteMatched ? RouteMatched : DefaultFallback;
}

/// <summary>Notified on every gateway route resolution. Never throws.</summary>
public interface IRouteAlarm
{
    void OnRouteResolved(string? featureTag, string resolvedKey, RouteReason reason);
}

/// <summary>
/// Raises a Sentry warning when an EXPENSIVE task resolves via <c>default_fallback</c> — the exact
/// shape of the 2026-07-14 incident: the Worker's <c>Ai:Routes</c> had no <c>pdf.parse</c> entry, so
/// PDF vision parsing fell through to <c>Ai:DefaultProvider: ollama</c> and pegged the CPU-only
/// Ollama container at ~390% for ~42 s/page. Nothing threw, nothing logged an error, no OpenAI
/// traffic appeared — the failure mode was SILENCE. A silent fallback on a task we know is expensive
/// is a defect by definition, so it gets an event.
///
/// Cheap tasks are not watched: falling back to the default provider is the normal, correct path for
/// most features, and alerting on it would be pure noise.
/// </summary>
public sealed class SentryRouteAlarm : IRouteAlarm
{
    private static readonly string[] DefaultWatchedTasks = ["podcast.script"];

    private readonly HashSet<string> _watched;
    private readonly AlarmThrottle _throttle;

    public SentryRouteAlarm(IConfiguration config)
    {
        var configured = config.GetSection("Ai:RouteAlarm:AlertOnDefaultRouteFor").Get<string[]>();
        _watched = new HashSet<string>(
            configured is { Length: > 0 } ? configured : DefaultWatchedTasks,
            StringComparer.OrdinalIgnoreCase);

        var cooldownMinutes = config.GetValue<int?>("Ai:RouteAlarm:CooldownMinutes") ?? 60;
        _throttle = new AlarmThrottle(TimeSpan.FromMinutes(Math.Max(1, cooldownMinutes)));
    }

    public void OnRouteResolved(string? featureTag, string resolvedKey, RouteReason reason)
    {
        if (reason != RouteReason.DefaultFallback)
            return;
        if (string.IsNullOrWhiteSpace(featureTag) || !_watched.Contains(featureTag))
            return;
        if (!_throttle.TryEnter($"route|{featureTag}|{resolvedKey}", DateTimeOffset.UtcNow))
            return;

        try
        {
            SentrySdk.CaptureMessage(
                $"AI route fell back to the default provider for an expensive task: "
                + $"'{featureTag}' → '{resolvedKey}'. Expected an explicit Ai:Routes entry.",
                scope =>
                {
                    scope.SetTag("ai.task", featureTag);
                    scope.SetTag("ai.provider.resolved", resolvedKey);
                    scope.SetTag("ai.provider.reason", RouteReasonNames.DefaultFallback);
                },
                SentryLevel.Warning);
        }
        catch
        {
            // Alarms must never break a real LLM call.
        }
    }
}
