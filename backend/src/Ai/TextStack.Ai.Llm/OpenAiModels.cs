using Microsoft.Extensions.Configuration;

namespace TextStack.Ai.Llm;

/// <summary>
/// The one place an OpenAI model id is resolved in code: config key, then default. The client, the
/// response caches and the registry seeder all read it here, so the model served, the cache key and the
/// admin label cannot drift apart. When OpenAI retires a model, change the default here and in the
/// config files (appsettings, compose, <c>.env.example</c>) — docs/incidents/2026-10-24-translation-down-on-a-retired-model.md.
/// </summary>
public static class OpenAiModels
{
    /// <summary><c>OpenAI:Model</c> — translate, and every OpenAI caller without its own model.</summary>
    public const string DefaultModel = "gpt-4.1-mini";

    /// <summary><c>OpenAI:Explain:Model</c> — Explain and the tutor; also the distillation teacher.</summary>
    public const string DefaultExplainModel = "gpt-4.1-mini";

    /// <summary><c>Eval:JudgeModel</c> — stronger than the models it grades.</summary>
    public const string DefaultJudgeModel = "gpt-4.1";

    public static string Default(IConfiguration config) =>
        config["OpenAI:Model"] ?? Environment.GetEnvironmentVariable("OPENAI_MODEL") ?? DefaultModel;

    public static string Explain(IConfiguration config) => config["OpenAI:Explain:Model"] ?? DefaultExplainModel;

    public static string Judge(IConfiguration config) => config["Eval:JudgeModel"] ?? DefaultJudgeModel;
}
