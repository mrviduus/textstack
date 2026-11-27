using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.AiEvals;

/// <summary>
/// Builds the LLM clients eval tests run against, and skips the test when the
/// provider isn't available — no <c>OPENAI_API_KEY</c> —
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

    /// <summary>The judge model (OpenAI).</summary>
    public static ILlmService Judge() => OpenAi();
}
