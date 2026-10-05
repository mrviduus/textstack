using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;

namespace TextStack.Ai.Llm;

/// <summary>
/// Ollama (self-hosted) provider for the new <see cref="ILlmService"/> seam.
/// Ported 1:1 from Application/LLM/OllamaLlmService.cs — the <c>think=false</c>
/// flag is load-bearing, DO NOT remove. Stateless/thread-safe; singleton in AI-005.
/// Self-hosted ⇒ cost is always 0.
/// </summary>
public sealed class OllamaLlmClient : ILlmService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<OllamaLlmClient> _logger;
    private readonly string _baseUrl;
    private readonly string _model;
    private readonly int _timeoutSeconds;
    private readonly IProviderHealth _health;

    /// <summary>The circuit key for this provider — must match the keyed DI registration.</summary>
    public const string ProviderKey = AiProviderKeys.Ollama;

    /// <param name="health">
    /// Optional so the eval suite can keep constructing this client by hand (same precedent as
    /// <c>ModelGateway</c>'s optional <c>IRouteAlarm</c>); absent ⇒ every call is allowed.
    /// </param>
    public OllamaLlmClient(
        IHttpClientFactory httpClientFactory,
        IConfiguration config,
        ILogger<OllamaLlmClient> logger,
        IProviderHealth? health = null)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _health = health ?? NullProviderHealth.Instance;
        _baseUrl = config["Ollama:BaseUrl"]
            ?? Environment.GetEnvironmentVariable("OLLAMA_BASE_URL")
            ?? "http://localhost:11434";
        _model = config["Ollama:Model"]
            ?? Environment.GetEnvironmentVariable("OLLAMA_MODEL")
            ?? "gemma4:e2b";
        _timeoutSeconds = int.TryParse(config["Ollama:TimeoutSeconds"], out var t) ? t : 30;
    }

    public async Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;

        // Circuit open ⇒ return the same empty response the swallow paths below produce, but in
        // microseconds instead of Ollama:TimeoutSeconds (90 s in both hosts). Callers cannot tell
        // the difference; a dead provider simply stops costing wall-clock.
        if (!_health.TryBeginCall(ProviderKey, now))
        {
            _logger.LogDebug(
                "Ollama circuit open — skipping '{Feature}' without a call", request.FeatureTag);
            return Empty();
        }

        // /api/generate takes a single prompt. Concatenate system + messages
        // with a clear separator so the model treats them as role-split.
        var userPart = string.Join("\n\n", request.Messages.Select(m => m.Content));
        var prompt = string.IsNullOrWhiteSpace(request.SystemPrompt)
            ? userPart
            : $"{request.SystemPrompt}\n\n{userPart}";

        var client = _httpClientFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(_timeoutSeconds);

        // think=false disables chain-of-thought on Gemma-4 / Qwen-3 / similar.
        // Without it, the model emits a long "Thinking Process: …" preamble that
        // eats the entire num_predict budget — downstream parsers then see no
        // structured output. Backwards compatible: non-thinking models ignore it.
        var body = new
        {
            model = _model,
            prompt,
            stream = false,
            think = false,
            options = new { num_predict = request.MaxOutputTokens },
        };

        try
        {
            var response = await client.PostAsJsonAsync($"{_baseUrl}/api/generate", body, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Ollama returned {StatusCode}", response.StatusCode);
                // The swallow below is load-bearing (callers expect an empty response, not an
                // exception) — which is exactly why these failures are invisible in llm_traces:
                // TracingDecorator only sees a successful, zero-token answer. Report them here.
                LlmFailureAlarm.Capture(
                    "ollama", request.FeatureTag, LlmFailureAlarm.ReasonHttpStatus);
                // Deliberately does NOT trip the circuit: a non-2xx means Ollama is ALIVE and
                // answering (typically a wrong Ollama:Model → 404). That fails in milliseconds and
                // is fixed by one config edit — hiding it behind 30 minutes of silence would turn a
                // visible, cheap error into an invisible one.
                return Empty();
            }

            _health.ReportSuccess(ProviderKey, DateTimeOffset.UtcNow);

            var result = await response.Content.ReadFromJsonAsync<OllamaResponse>(ct);
            var text = StripThinking(result?.Response ?? string.Empty);
            // Self-hosted ⇒ free.
            var usage = new LlmUsage(result?.PromptEvalCount ?? 0, result?.EvalCount ?? 0, 0m);
            return new LlmResponse(text, [], usage, _model, Guid.NewGuid());
        }
        catch (TaskCanceledException)
        {
            _logger.LogWarning("Ollama request timed out after {Seconds}s", _timeoutSeconds);
            LlmFailureAlarm.Capture("ollama", request.FeatureTag, LlmFailureAlarm.ReasonTimeout);
            _health.ReportFailure(
                ProviderKey, request.FeatureTag, LlmFailureAlarm.ReasonTimeout, DateTimeOffset.UtcNow);
            return Empty();
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Ollama request failed");
            LlmFailureAlarm.Capture("ollama", request.FeatureTag, LlmFailureAlarm.ReasonTransport, ex);
            _health.ReportFailure(
                ProviderKey, request.FeatureTag, LlmFailureAlarm.ReasonTransport, DateTimeOffset.UtcNow);
            return Empty();
        }

        LlmResponse Empty() => new(string.Empty, [], new LlmUsage(0, 0, 0m), _model, Guid.NewGuid());
    }

    public async IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, [EnumeratorCancellation] CancellationToken ct)
    {
        // Intentional non-streaming (AI-028): Ollama is never streamed to a user — it serves only the
        // one-shot SRS distractor + eval-judge features. We complete once and emit the result as a text
        // delta followed by the terminal usage delta, so the contract (and TracingDecorator) still holds.
        var resp = await CompleteAsync(request, ct);
        if (!string.IsNullOrEmpty(resp.Text))
            yield return new LlmDelta(TextDelta: resp.Text);
        yield return new LlmDelta(FinalUsage: resp.Usage, ModelId: resp.ModelId);
    }

    // Compiled Regex, not [GeneratedRegex]: see the ARM64 SIGILL note in CLAUDE.md.
    private static readonly Regex LeadingThink = new(
        @"^\s*(?:<think>.*?)?</think>", RegexOptions.Singleline | RegexOptions.Compiled);

    /// <summary>
    /// Drops a leading <c>&lt;think&gt;…&lt;/think&gt;</c> block, or a stray leading <c>&lt;/think&gt;</c>,
    /// which some models leak even with <c>think=false</c>; the line parsers downstream would
    /// otherwise read the reasoning as the answer. Trims the result.
    /// </summary>
    public static string StripThinking(string text) => LeadingThink.Replace(text, string.Empty, 1).Trim();

    private sealed class OllamaResponse
    {
        [JsonPropertyName("response")] public string? Response { get; set; }
        [JsonPropertyName("prompt_eval_count")] public int? PromptEvalCount { get; set; }
        [JsonPropertyName("eval_count")] public int? EvalCount { get; set; }
    }
}
