using System.Text.RegularExpressions;

namespace TextStack.Ai.Llm;

/// <summary>
/// Provider-level failure reporting, tagged with the task and provider so a Sentry issue answers
/// "which feature, on which model, is broken?" without opening a trace.
///
/// Static (not DI) on purpose: the two call sites that need it — <see cref="TracingDecorator"/> and
/// <see cref="OllamaLlmClient"/> — are constructed by hand in keyed DI factories, and threading an
/// extra dependency through both would churn every existing unit-test construction for no gain.
/// Against a disabled hub (no DSN) every call here is already a no-op.
/// </summary>
public static class LlmFailureAlarm
{
    public const string ReasonException = "exception";
    public const string ReasonHttpStatus = "http_status";
    public const string ReasonTimeout = "timeout";
    public const string ReasonTransport = "transport";

    private static AlarmThrottle _throttle = new(TimeSpan.FromMinutes(60));

    /// <summary>Sets the shared cooldown from <c>Ai:RouteAlarm:CooldownMinutes</c> at startup.</summary>
    public static void Configure(TimeSpan cooldown) => _throttle = new AlarmThrottle(cooldown);

    // OpenAI SDK messages read "HTTP 404 (invalid_request_error: model_not_found) …". Compiled, not
    // [GeneratedRegex]: the ARM64 SIGILL caveat (CLAUDE.md, Extraction).
    private static readonly Regex ProviderCode = new(@"\(\s*[a-z_]+\s*:\s*([a-z_]+)\s*\)", RegexOptions.Compiled);
    private static readonly Regex HttpStatus = new(@"\bHTTP (\d{3})\b", RegexOptions.Compiled);

    /// <summary>
    /// What went wrong, short enough to group by: the provider's error code (<c>model_not_found</c>,
    /// <c>invalid_api_key</c>), else <c>http_404</c>, else the exception type, else the reason.
    /// </summary>
    public static string ErrorCode(string reason, Exception? ex)
    {
        if (ex is null) return reason;
        if (ProviderCode.Match(ex.Message) is { Success: true } code) return code.Groups[1].Value;
        if (HttpStatus.Match(ex.Message) is { Success: true } status) return $"http_{status.Groups[1].Value}";
        return ex.GetType().Name;
    }

    /// <summary>
    /// Reports one provider failure, throttled per (provider, task, reason, error code). A dead Ollama
    /// during a 106-page PDF parse produces one event, not 106.
    ///
    /// Fingerprinted by the same key, so each distinct failure is its own Sentry issue and fires the
    /// new-issue alert. Grouped by exception type instead, a retired model joined an old, ongoing
    /// invalid_api_key issue and notified nobody (docs/incidents/2026-10-24-translation-down-on-a-retired-model.md).
    /// </summary>
    public static void Capture(string provider, string? featureTag, string reason, Exception? ex = null)
    {
        var task = string.IsNullOrWhiteSpace(featureTag) ? "unknown" : featureTag;
        var code = ErrorCode(reason, ex);
        if (!_throttle.TryEnter($"llm|{provider}|{task}|{reason}|{code}", DateTimeOffset.UtcNow))
            return;

        try
        {
            void Enrich(Scope scope)
            {
                scope.SetTag("ai.provider", provider);
                scope.SetTag("ai.task", task);
                scope.SetTag("ai.failure", reason);
                scope.SetTag("ai.error_code", code);
                scope.SetFingerprint(["llm-failure", provider, task, reason, code]);
            }

            if (ex is not null)
                SentrySdk.CaptureException(ex, Enrich);
            else
                SentrySdk.CaptureMessage(
                    $"LLM provider '{provider}' failed for task '{task}' ({reason}).",
                    Enrich,
                    SentryLevel.Warning);
        }
        catch
        {
            // Reporting a failure must never cause one.
        }
    }
}
