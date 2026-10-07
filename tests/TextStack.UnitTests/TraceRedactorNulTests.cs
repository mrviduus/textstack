using System.Text.Json;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;
using TextStack.Observability;

namespace TextStack.UnitTests;

/// <summary>
/// Regression tests for a defect that cost 24 dropped LLM traces a day in production.
///
/// A NUL byte anywhere in a prompt or a model response is serialized by
/// System.Text.Json as the escape <c>\u0000</c>. That is valid JSON by the spec and
/// PostgreSQL rejects it outright:
///
///     ERROR:  unsupported Unicode escape sequence
///     DETAIL: \u0000 cannot be converted to text.     (SQLSTATE 22P02)
///
/// The insert into <c>llm_traces</c> threw inside a fire-and-forget writer, so the only
/// symptom was a log line and a row that never arrived. Verified against Postgres
/// directly before the fix was written.
/// </summary>
public class TraceRedactorNulTests
{
    private const string NulEscape = @"\u0000";

    [Fact]
    public void StripNul_RemovesTheRawCharacter_ForTextColumns()
    {
        // SystemPrompt, ResponseText and Error are plain text columns; Postgres cannot
        // store a NUL in those either.
        var withNul = "answer" + '\0' + "text";

        var result = TraceRedactor.StripNul(withNul);

        Assert.Equal("answertext", result);
    }

    [Fact]
    public void StripNul_RemovesTheEscapeSequence_ForJsonbColumns()
    {
        // What actually reaches jsonb: the serializer never emits a raw NUL, only this.
        var serialized = "[{" + '"' + "content" + '"' + ":" + '"' + "hi" + NulEscape + "there" + '"' + "}]";

        var result = TraceRedactor.StripNul(serialized);

        Assert.Equal("[{" + '"' + "content" + '"' + ":" + '"' + "hithere" + '"' + "}]", result);
        Assert.DoesNotContain(NulEscape, result, StringComparison.Ordinal);
    }

    [Fact]
    public void StripNul_LeavesOrdinaryTextAlone()
    {
        Assert.Equal("nothing to strip", TraceRedactor.StripNul("nothing to strip"));
        Assert.Null(TraceRedactor.StripNul(null));
        Assert.Equal("", TraceRedactor.StripNul(""));
    }

    [Fact]
    public void StripNul_DoesNotTouchOtherUnicodeEscapes()
    {
        // Only NUL is unstorable. Cyrillic and friends arrive as escapes too and must
        // survive — the app serves Ukrainian.
        // \u0431 is Cyrillic "б" — the app serves Ukrainian, and these escapes are
        // everywhere in serialized prompts. Only \u0000 is unstorable.
        var cyrillic = "[{" + '"' + "c" + '"' + ":" + '"' + @"\u0431\u0443" + '"' + "}]";

        Assert.Equal(cyrillic, TraceRedactor.StripNul(cyrillic));
    }

    [Fact]
    public void BuildTrace_ProducesJsonPostgresWillAccept_WhenAMessageContainsNul()
    {
        // The end-to-end shape of the production failure, on the `distractor` feature.
        var poisoned = "distractor for" + '\0' + " the word";
        var request = new LlmRequest(
            SystemPrompt: "sys" + '\0' + "prompt",
            Messages: new[] { new LlmMessage("user", poisoned) },
            MaxOutputTokens: 256,
            FeatureTag: "distractor");

        var trace = TracingDecorator.BuildTrace(request, response: null, latencyMs: 5, error: "boom");

        Assert.DoesNotContain(NulEscape, trace.MessagesJson, StringComparison.Ordinal);
        Assert.DoesNotContain('\0', trace.MessagesJson);
        Assert.DoesNotContain('\0', trace.SystemPrompt ?? "");
        // Still parses — stripping must not corrupt the document.
        using var parsed = JsonDocument.Parse(trace.MessagesJson);
        Assert.Equal(JsonValueKind.Array, parsed.RootElement.ValueKind);
    }
}
