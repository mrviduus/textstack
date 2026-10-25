using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.AiEvals;

/// <summary>
/// Builds the LLM clients eval tests run against, and skips the test when the
/// provider isn't available — no <c>OPENAI_API_KEY</c>, or Ollama not running —
/// so the opt-in evals never fail default CI. Tests get a real provider only when
/// run deliberately with the env/services present.
/// </summary>
internal static class EvalClients
{
    public static ILlmService OpenAi()
    {
        var key = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        Assert.SkipWhen(string.IsNullOrWhiteSpace(key), "OPENAI_API_KEY not set — eval skipped (opt-in).");
        // Empty config: the key comes from OPENAI_API_KEY; the model from OPENAI_MODEL, else the code default.
        var model = Environment.GetEnvironmentVariable("OPENAI_MODEL") is { Length: > 0 } m ? m : new OpenAiOptions().Model;
        return new OpenAiLlmClient(new ConfigurationBuilder().Build(), NullLogger<OpenAiLlmClient>.Instance, model);
    }

    /// <summary>
    /// The judge model. Defaults to OpenAI; set <c>EVAL_JUDGE=ollama</c> to judge
    /// with local Ollama/gemma4 (free, no OpenAI key — handy when the key is the
    /// blocker). A small local judge is noisier/looser, so scores are less reliable.
    /// </summary>
    public static ILlmService Judge()
    {
        var which = (Environment.GetEnvironmentVariable("EVAL_JUDGE") ?? "openai").Trim().ToLowerInvariant();
        return which == "ollama" ? Ollama() : OpenAi();
    }

    public static ILlmService Ollama()
    {
        var baseUrl = Environment.GetEnvironmentVariable("OLLAMA_BASE_URL") ?? "http://localhost:11434";
        Assert.SkipUnless(IsReachable(baseUrl), $"Ollama not reachable at {baseUrl} — eval skipped (opt-in).");
        var httpFactory = new ServiceCollection().AddHttpClient().BuildServiceProvider()
            .GetRequiredService<IHttpClientFactory>();
        // Empty config: OllamaLlmClient falls back to OLLAMA_BASE_URL / OLLAMA_MODEL env vars.
        return new OllamaLlmClient(httpFactory, new ConfigurationBuilder().Build(), NullLogger<OllamaLlmClient>.Instance);
    }

    private static bool IsReachable(string baseUrl)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            _ = http.GetAsync(baseUrl).GetAwaiter().GetResult();
            return true;
        }
        catch
        {
            return false;
        }
    }
}
