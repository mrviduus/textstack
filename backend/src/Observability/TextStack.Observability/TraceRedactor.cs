using System.Text.RegularExpressions;

namespace TextStack.Observability;

/// <summary>
/// Strips obvious PII (email, phone) before a prompt/response is persisted —
/// the playbook PII rule for LlmTrace. Compiled (not [GeneratedRegex]) per the
/// repo's ARM64 SIGILL caveat.
/// </summary>
public static class TraceRedactor
{
    private static readonly Regex Email =
        new(@"[\w.+-]+@[\w-]+\.[\w.-]+", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    // Conservative: 8+ digits with optional separators / leading +.
    private static readonly Regex Phone =
        new(@"\+?\d[\d\s().-]{7,}\d", RegexOptions.Compiled);

    /// <summary>
    /// The six characters System.Text.Json emits for a NUL byte. It is legal JSON and
    /// PostgreSQL still refuses it.
    /// </summary>
    private const string NulEscape = @"\u0000";

    public static string? Redact(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        text = Email.Replace(text, "[redacted-email]");
        text = Phone.Replace(text, "[redacted-phone]");
        return StripNul(text);
    }

    /// <summary>
    /// Removes NUL, which PostgreSQL cannot store in either <c>text</c> or <c>jsonb</c>.
    ///
    /// This cost 24 lost traces a day in production. A NUL byte anywhere in a prompt or
    /// a model response is serialized by System.Text.Json as the escape sequence
    /// <c>\u0000</c> — valid JSON by the spec, and rejected outright by jsonb:
    ///
    ///     ERROR:  unsupported Unicode escape sequence
    ///     DETAIL: \u0000 cannot be converted to text.   (SQLSTATE 22P02)
    ///
    /// The insert into <c>llm_traces</c> then throws inside the fire-and-forget trace
    /// writer, so the only symptom was a log line and a missing row. Observed on the
    /// `distractor` and `tutor.agent` features; book text extracted from PDFs is a
    /// plausible source of stray NULs.
    ///
    /// Both forms are stripped: the raw character, for the plain <c>text</c> columns
    /// (SystemPrompt, ResponseText, Error), and the escape sequence, for the already
    /// serialized JSON in MessagesJson and ToolCallsJson — a raw NUL cannot survive in
    /// serializer output, so the escape is the only form that reaches jsonb.
    /// </summary>
    public static string? StripNul(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        if (text.Contains('\0')) text = text.Replace("\0", string.Empty);
        if (text.Contains(NulEscape, StringComparison.Ordinal))
            text = text.Replace(NulEscape, string.Empty, StringComparison.Ordinal);
        return text;
    }
}
