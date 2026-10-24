using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// The error code is the Sentry fingerprint and throttle key for provider failures. Grouped by
/// exception type instead, a retired model joined an old invalid_api_key issue and alerted nobody
/// (docs/incidents/2026-10-24-translation-down-on-a-retired-model.md) — so the two must differ.
/// </summary>
public class LlmFailureAlarmTests
{
    private const string Reason = LlmFailureAlarm.ReasonException;

    [Fact]
    public void ErrorCode_OpenAiModelRetired_ReturnsProviderCode() =>
        Assert.Equal("model_not_found", LlmFailureAlarm.ErrorCode(Reason, new Exception(
            "HTTP 404 (invalid_request_error: model_not_found)\n\nThe model `gpt-4.1-nano` has been deprecated")));

    [Fact]
    public void ErrorCode_OpenAiBadKey_DiffersFromRetiredModel() =>
        Assert.Equal("invalid_api_key", LlmFailureAlarm.ErrorCode(Reason, new Exception(
            "HTTP 401 (invalid_request_error: invalid_api_key)")));

    [Fact]
    public void ErrorCode_MixedCaseCode_KeepsIt() =>
        Assert.Equal("DeploymentNotFound", LlmFailureAlarm.ErrorCode(Reason, new Exception(
            "HTTP 404 (NotFound: DeploymentNotFound)")));

    [Fact]
    public void ErrorCode_StatusWithoutCode_ReturnsHttpStatus() =>
        Assert.Equal("http_503", LlmFailureAlarm.ErrorCode(Reason, new Exception("HTTP 503 Service Unavailable")));

    [Fact]
    public void ErrorCode_WrappedProviderError_ReadsInnerException() =>
        Assert.Equal("model_not_found", LlmFailureAlarm.ErrorCode(Reason, new InvalidOperationException(
            "LLM call failed", new Exception("HTTP 404 (invalid_request_error: model_not_found)"))));

    [Fact]
    public void ErrorCode_ParenthesesInBodyText_AreNotACode() =>
        Assert.Equal("JsonException", LlmFailureAlarm.ErrorCode(Reason,
            new System.Text.Json.JsonException("Invalid token (expected: object) at line 1")));

    [Fact]
    public void ErrorCode_EmptyErrorType_KeepsCode() =>
        Assert.Equal("insufficient_quota", LlmFailureAlarm.ErrorCode(Reason, new Exception(
            "HTTP 429 (: insufficient_quota)")));

    [Fact]
    public void ErrorCode_AggregateSecondInner_FindsProviderCode() =>
        Assert.Equal("model_not_found", LlmFailureAlarm.ErrorCode(Reason, new AggregateException(
            new TimeoutException("slow"), new Exception("HTTP 404 (invalid_request_error: model_not_found)"))));

    [Fact]
    public void ErrorCode_WrappedNonHttpCause_ReturnsRootType() =>
        Assert.Equal("TimeoutException", LlmFailureAlarm.ErrorCode(Reason, new InvalidOperationException(
            "LLM call failed", new TimeoutException("slow"))));

    [Fact]
    public void ErrorCode_CallerSuppliedCode_Wins() =>
        Assert.Equal("http_404", LlmFailureAlarm.ErrorCode(LlmFailureAlarm.ReasonHttpStatus, null, "http_404"));

    [Fact]
    public void Fingerprint_KeepsSentryDefaultGrouping() =>
        Assert.Equal("{{ default }}", LlmFailureAlarm.Fingerprint("openai", "translate", Reason, "model_not_found")[0]);

    [Fact]
    public void ErrorCode_NoException_ReturnsReason() =>
        Assert.Equal("timeout", LlmFailureAlarm.ErrorCode(LlmFailureAlarm.ReasonTimeout, null));

    [Fact]
    public void Fingerprint_DifferentCodes_Differ() =>
        Assert.NotEqual(
            string.Join('|', LlmFailureAlarm.Fingerprint("openai", "translate", Reason, "invalid_api_key")),
            string.Join('|', LlmFailureAlarm.Fingerprint("openai", "translate", Reason, "model_not_found")));
}
