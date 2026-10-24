using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// The error code is the Sentry fingerprint and throttle key for provider failures. Grouped by
/// exception type instead, a retired model joined an old invalid_api_key issue and alerted nobody
/// (docs/incidents/2026-10-24-translation-down-on-a-retired-model.md) — so the two must differ.
/// </summary>
public class LlmFailureAlarmTests
{
    [Fact]
    public void ErrorCode_OpenAiModelRetired_ReturnsProviderCode() =>
        Assert.Equal("model_not_found", LlmFailureAlarm.ErrorCode("exception", new Exception(
            "HTTP 404 (invalid_request_error: model_not_found)\n\nThe model `gpt-4.1-nano` has been deprecated")));

    [Fact]
    public void ErrorCode_OpenAiBadKey_DiffersFromRetiredModel() =>
        Assert.Equal("invalid_api_key", LlmFailureAlarm.ErrorCode("exception", new Exception(
            "HTTP 401 (invalid_request_error: invalid_api_key)")));

    [Fact]
    public void ErrorCode_StatusWithoutCode_ReturnsHttpStatus() =>
        Assert.Equal("http_503", LlmFailureAlarm.ErrorCode("exception", new Exception("HTTP 503 Service Unavailable")));

    [Fact]
    public void ErrorCode_PlainException_ReturnsTypeName() =>
        Assert.Equal("TimeoutException", LlmFailureAlarm.ErrorCode("exception", new TimeoutException("slow")));

    [Fact]
    public void ErrorCode_NoException_ReturnsReason() =>
        Assert.Equal("timeout", LlmFailureAlarm.ErrorCode(LlmFailureAlarm.ReasonTimeout, null));
}
