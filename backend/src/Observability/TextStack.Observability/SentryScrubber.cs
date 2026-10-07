using System.Collections.Frozen;
using System.Text.RegularExpressions;
using Sentry;

namespace TextStack.Observability;

/// <summary>
/// The privacy edge. Everything Sentry is about to send passes through here, and the rule is an
/// ALLOWLIST, not a denylist: any tag or extra we did not explicitly bless is dropped or redacted.
///
/// Why an allowlist. This service handles book text, reader prompts and LLM responses. A denylist
/// only stops the leaks somebody remembered to enumerate; a future contributor writing
/// <c>span.SetTag("prompt", userText)</c> would sail straight through one. With an allowlist that tag
/// dies at the edge whether or not the reviewer noticed it. The same reasoning is why we do NOT use
/// Sentry's OpenTelemetry exporter: it ships spans through the OTel SDK, bypassing this hook entirely,
/// while our OTel spans carry <c>http.client_ip</c> and full SQL text.
/// </summary>
public static class SentryScrubber
{
    /// <summary>Free text is truncated to this; the only free text we send is our own literals and
    /// exception messages, and a provider error can echo part of a prompt back at us.</summary>
    public const int MaxTextLength = 512;

    public const string Redacted = "[redacted]";

    public static readonly FrozenSet<string> AllowedTagKeys = new[]
    {
        // AI routing (the incident this integration exists for)
        "ai.task", "ai.provider", "ai.provider.resolved", "ai.provider.reason", "ai.failure",
        // Agent runs
        "agent.name", "agent.model", "agent.outcome",
        // RAG indexing
        "rag.kind", "rag.book_id", "rag.outcome",
        // Calling mobile build (AppVersionMiddleware): which version broke
        "app.version", "app.build",
        // Which host (api / worker / mcp-server) — they share one project
        SentryBootstrap.ServiceTag,
        // Span bookkeeping + Sentry's own
        "outcome", "environment", "release", "server_name", "transaction",
    }.ToFrozenSet(StringComparer.OrdinalIgnoreCase);

    public static readonly FrozenSet<string> AllowedExtraKeys = new[]
    {
        "agent.iterations", "agent.tokens_in", "agent.tokens_out", "agent.cost_usd",
        "agent.duration_ms", "rag.chunk_count",
    }.ToFrozenSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>Headers that carry credentials. Dropped even though SendDefaultPii is already false.</summary>
    private static readonly string[] SensitiveHeaderPrefixes = ["authorization", "cookie", "x-admin"];

    /// <summary>
    /// Exceptions the API deliberately maps to a 4xx. None of them can reach Sentry today — the
    /// ExceptionMiddleware converts them without logging, and only its unexpected-exception fallback
    /// calls LogError — but this keeps a future <c>LogError</c> on a validation path from turning
    /// ordinary client mistakes into pages.
    /// </summary>
    private static readonly string[] DroppedExceptionTypes =
    [
        "NotFoundException", "ConflictException", "ValidationException", "DomainException",
        "BudgetExceededException", "OperationCanceledException", "TaskCanceledException",
    ];

    public static SentryEvent? Scrub(SentryEvent e)
    {
        if (IsDroppedException(e))
            return null;

        if (IsDatabaseCommandEvent(e))
            return null;

        // Identity: nothing about who the reader is.
        e.User = new SentryUser();

        if (e.Request is { } request)
        {
            request.Data = null;
            request.Cookies = null;
            request.QueryString = null;
            request.Url = StripQuery(request.Url);

            foreach (var header in request.Headers.Keys.ToList())
            {
                if (SensitiveHeaderPrefixes.Any(p => header.StartsWith(p, StringComparison.OrdinalIgnoreCase)))
                    request.Headers.Remove(header);
            }
        }

        foreach (var key in e.Tags.Keys.ToList())
        {
            if (!AllowedTagKeys.Contains(key))
                e.UnsetTag(key);
        }

        // The SDK exposes Extra read-only with no removal API, so a disallowed key is neutralised by
        // overwriting its VALUE — the payload is what matters, and the key alone carries no data.
        foreach (var key in e.Extra.Keys.ToList())
        {
            if (!AllowedExtraKeys.Contains(key))
                e.SetExtra(key, Redacted);
        }

        if (e.Message is { } message)
            message.Formatted = Clean(message.Formatted);

        if (e.SentryExceptions is not null)
        {
            foreach (var ex in e.SentryExceptions)
                ex.Value = Clean(ex.Value);
        }

        return e;
    }

    /// <summary>Health probes are dropped outright — redundant with the sampler, but free.</summary>
    public static SentryTransaction? ScrubTransaction(SentryTransaction transaction)
    {
        if (SentryBootstrap.IgnoredTransactionPaths.Any(p =>
                transaction.Name.Contains(p, StringComparison.OrdinalIgnoreCase)))
            return null;

        foreach (var key in transaction.Tags.Keys.ToList())
        {
            if (!AllowedTagKeys.Contains(key))
                transaction.UnsetTag(key);
        }

        // Transactions skip Scrub(), so the request's query string (?q=<search>, ?text=<passage>)
        // and outgoing-call span descriptions ("GET https://openlibrary.org/search.json?title=<an
        // upload's title>") would ship as recorded. Cut the whole query, not known keys.
        if (transaction.Request is { } request)
        {
            request.QueryString = null;
            request.Url = StripQuery(request.Url);
        }

        foreach (var span in transaction.Spans)
            span.Description = StripQuery(span.Description);

        return transaction;
    }

    /// <summary>Everything from the first <c>?</c> or <c>#</c> on, removed.</summary>
    public static string? StripQuery(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        var cut = text.IndexOfAny(['?', '#']);
        return cut < 0 ? text : text[..cut];
    }

    /// <summary>
    /// Breadcrumbs are auto-captured log lines, and this codebase logs book titles, file paths and
    /// LLM diagnostics. Keep the shape (which operation, at what level) and redact the words. The
    /// structured <c>data</c> bag is dropped wholesale — it is unbounded and unauditable.
    /// (Breadcrumb is immutable and its timestamp-taking constructor is not public, so the rebuilt
    /// crumb carries the send time rather than the original — a sub-second difference in ordering
    /// context, worth it for a guaranteed-scrubbed payload.)
    ///
    /// EF Core command breadcrumbs are dropped ENTIRELY, not redacted. Caught in first-run
    /// verification: an event's breadcrumb trail carried <c>Executed DbCommand … SELECT …</c> with
    /// the full SQL inline in the MESSAGE, so nulling <c>data</c> did not stop it. That is the same
    /// class of leak (<c>SetDbStatementForText</c>) this integration deliberately avoided by not
    /// using Sentry's OpenTelemetry exporter — it would have been inconsistent to let it back in
    /// through the log pipeline. SQL is never worth its diagnostic value on a third-party service
    /// when the database holds what people are reading.
    /// </summary>
    public static Breadcrumb? ScrubBreadcrumb(Breadcrumb breadcrumb)
    {
        if (IsDatabaseCommand(breadcrumb))
            return null;

        return new(Clean(breadcrumb.Message) ?? string.Empty,
            breadcrumb.Type,
            data: null,
            category: breadcrumb.Category,
            level: breadcrumb.Level);
    }

    /// <summary>True for EF Core command-log breadcrumbs, which carry SQL text in their message.</summary>
    public static bool IsDatabaseCommand(Breadcrumb breadcrumb) =>
        breadcrumb.Category?.StartsWith(EfCommandLogger, StringComparison.OrdinalIgnoreCase) == true
        || ContainsDbCommandLog(breadcrumb.Message);

    /// <summary>
    /// True for EF Core command-log EVENTS. Dropping the breadcrumb was not enough: EF Core logs a
    /// failed command at <c>Error</c> level, and Sentry's ILogger integration turns any Error into an
    /// event whose message carries the statement — so the first production event of
    /// <c>PUT /me/progress</c> arrived with <c>INSERT INTO reading_progresses (id, chapter_id, …)</c>
    /// inline. Parameter VALUES were never present (EnableSensitiveDataLogging is off, so EF renders
    /// <c>@p0</c>/<c>'?'</c>), but statement and schema text still left the process, which is exactly
    /// what this integration promised it would not do.
    ///
    /// Dropping loses no signal: the real failure is reported separately by ExceptionMiddleware as a
    /// <c>DbUpdateException</c> with a full stack trace, the Npgsql SQLSTATE and the violated
    /// constraint name — everything needed to debug, none of the SQL.
    /// </summary>
    public static bool IsDatabaseCommandEvent(SentryEvent e) =>
        e.Logger?.StartsWith(EfCommandLogger, StringComparison.OrdinalIgnoreCase) == true
        || ContainsDbCommandLog(e.Message?.Formatted)
        || ContainsDbCommandLog(e.Message?.Message);

    private const string EfCommandLogger = "Microsoft.EntityFrameworkCore";

    private static bool ContainsDbCommandLog(string? text) =>
        text?.Contains("Executed DbCommand", StringComparison.OrdinalIgnoreCase) == true
        || text?.Contains("Failed executing DbCommand", StringComparison.OrdinalIgnoreCase) == true;

    private static bool IsDroppedException(SentryEvent e)
    {
        if (e.Exception is { } ex && DroppedExceptionTypes.Contains(ex.GetType().Name))
            return true;

        return e.SentryExceptions?.Any(x =>
            x.Type is { } type && DroppedExceptionTypes.Any(d => type.EndsWith(d, StringComparison.Ordinal))) == true;
    }

    /// <summary>
    /// <see cref="Scrub"/>, then every exception's message is replaced — type and stack trace stay.
    ///
    /// For the MCP server. Every tool call there carries the reader's own text (a highlight, an
    /// insight, a chapter review) or a book's, and a .NET exception message can echo its input
    /// (<c>FormatException</c> quotes the string it could not parse). The other hosts keep messages
    /// because theirs are what make a database or provider error debuggable; the bridge has neither,
    /// and an exception TYPE plus a stack trace is enough to find a mapping bug in it.
    /// </summary>
    public static SentryEvent? ScrubStrict(SentryEvent e)
    {
        if (Scrub(e) is not { } scrubbed)
            return null;

        if (scrubbed.SentryExceptions is not null)
        {
            foreach (var ex in scrubbed.SentryExceptions)
                ex.Value = Redacted;
        }

        return scrubbed;
    }

    // Credentials that can surface in free text (a log line, an exception message). Bearer values,
    // our own key formats (tsk_ connect keys, tso_ OAuth tokens), JWTs (the device-flow token), and
    // the key segment of the MCP connect URL, which is the key itself. Compiled Regex, not
    // [GeneratedRegex] — the ARM64 SIGILL caveat in CLAUDE.md.
    private static readonly (Regex Pattern, string Replacement)[] SecretPatterns =
    [
        (new(@"\bBearer\s+[^\s""',;]+", RegexOptions.Compiled | RegexOptions.IgnoreCase), "Bearer " + Redacted),
        (new(@"/mcp/k/[^\s/?#""']+", RegexOptions.Compiled), "/mcp/k/" + Redacted),
        (new(@"\bts[ko]_[A-Za-z0-9_-]+", RegexOptions.Compiled), Redacted),
        (new(@"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*", RegexOptions.Compiled), Redacted),
    ];

    // A query string inside free text: "GET /search?q=<what the reader typed> failed". A '?' only
    // counts when a key=value follows it, so ordinary prose survives. Cut to the next whitespace —
    // the same "drop the whole query, not known keys" rule StripQuery applies to URLs.
    private static readonly Regex QueryInText = new(@"\?[\w.%\[\]-]+=\S*", RegexOptions.Compiled);

    /// <summary>Credentials and query strings removed from free text. Public for the tests.</summary>
    public static string? RedactSecrets(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        foreach (var (pattern, replacement) in SecretPatterns)
            text = pattern.Replace(text, replacement);
        return QueryInText.Replace(text, string.Empty);
    }

    /// <summary>Redacts credentials, query strings, emails and phones (the last two with the same
    /// redactor that guards llm_traces), then truncates.</summary>
    private static string? Clean(string? text)
    {
        var redacted = TraceRedactor.Redact(RedactSecrets(text));
        if (redacted is null)
            return null;

        return redacted.Length <= MaxTextLength ? redacted : redacted[..MaxTextLength] + "…";
    }
}
