using System.Diagnostics;

namespace TextStack.Ai.Core;

/// <summary>
/// The <see cref="ActivitySource"/> every AI-pipeline span is emitted on (agent runs, RAG indexing).
/// Registered with OpenTelemetry in <c>TelemetryExtensions.AddTextStackTelemetry</c> so these spans
/// reach the OTLP exporter (Aspire) exactly like the API's spans.
/// </summary>
public static class AiActivitySource
{
    public const string Name = "TextStack.Ai";

    public static readonly ActivitySource Source = new(Name);
}

/// <summary>
/// One AI-pipeline span, dual-written to BOTH sinks: an <see cref="Activity"/> (→ OTLP/Aspire) and a
/// Sentry span (→ scrubbed by <c>SentryScrubber</c> at the edge). We deliberately do NOT use the
/// <c>Sentry.OpenTelemetry</c> bridge: it is deprecated upstream, and its replacement ships spans
/// through the OpenTelemetry SDK — bypassing <c>BeforeSend</c>, which is the only place we can strip
/// the <c>http.client_ip</c> tag and the full SQL text (<c>SetDbStatementForText</c>) our existing
/// OTel pipeline attaches. Dual-writing costs one small object per agent run / book index and keeps
/// every byte that reaches Sentry inside our own allowlist.
///
/// Sentry-side shape: if a transaction is already in scope (an API request), we open a CHILD span on
/// it; otherwise (the Worker, which has no request) we push a scope and start our own transaction, so
/// concurrent RAG/agent runs in singleton Worker services can't cross-contaminate — <c>PushScope</c>
/// is AsyncLocal and <c>IsGlobalModeEnabled</c> stays false.
///
/// Every Sentry interaction is wrapped so observability can NEVER break a run: a disabled hub (no
/// DSN) is already a no-op, and an unexpected SDK failure is swallowed.
/// </summary>
public sealed class TraceScope : IDisposable
{
    public const string OutcomeCompleted = "completed";
    public const string OutcomeError = "error";
    public const string OutcomeBudgetExhausted = "budget_exhausted";

    private readonly Activity? _activity;
    private readonly ISpan? _span;
    private readonly IDisposable? _scope;
    private bool _disposed;

    private TraceScope(Activity? activity, ISpan? span, IDisposable? scope)
    {
        _activity = activity;
        _span = span;
        _scope = scope;
    }

    /// <summary>
    /// Terminal outcome, written as the <c>agent.outcome</c>/<c>rag.outcome</c> tag and mapped to the
    /// span status on dispose. Defaults to <see cref="OutcomeError"/> so an escaping exception (or an
    /// abandoned iterator) is recorded as a failure without needing a catch block.
    /// </summary>
    public string Outcome { get; set; } = OutcomeError;

    public static TraceScope Start(string name, string operation)
    {
        var activity = AiActivitySource.Source.StartActivity(name, ActivityKind.Internal);

        ISpan? span = null;
        IDisposable? scope = null;
        try
        {
            var parent = SentrySdk.GetSpan();
            if (parent is not null)
            {
                span = parent.StartChild(operation, name);
            }
            else
            {
                scope = SentrySdk.PushScope();
                var transaction = SentrySdk.StartTransaction(name, operation);
                SentrySdk.ConfigureScope(s => s.Transaction = transaction);
                span = transaction;
            }
        }
        catch
        {
            // Never let telemetry break the pipeline it observes.
        }

        return new TraceScope(activity, span, scope);
    }

    /// <summary>String tag on both sinks. Keys must be on <c>SentryScrubber.AllowedTagKeys</c> or
    /// they are dropped before the event leaves the process — that allowlist is the guarantee that
    /// no prompt, response or book text can ever reach Sentry.</summary>
    public TraceScope SetTag(string key, string? value)
    {
        if (string.IsNullOrEmpty(value))
            return this;

        _activity?.SetTag(key, value);
        try { _span?.SetTag(key, value); } catch { /* ignored */ }
        return this;
    }

    /// <summary>Numeric measure (tokens, cost, counts, durations) on both sinks.</summary>
    public TraceScope SetMeasure(string key, double value)
    {
        _activity?.SetTag(key, value);
        try { _span?.SetExtra(key, value); } catch { /* ignored */ }
        return this;
    }

    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;

        _activity?.SetTag("outcome", Outcome);
        _activity?.Dispose();

        try
        {
            _span?.SetTag("outcome", Outcome);
            _span?.Finish(Outcome == OutcomeCompleted ? SpanStatus.Ok : SpanStatus.InternalError);
        }
        catch
        {
            // ignored
        }

        _scope?.Dispose();
    }
}
