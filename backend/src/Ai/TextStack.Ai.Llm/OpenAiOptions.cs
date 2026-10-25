namespace TextStack.Ai.Llm;

/// <summary>
/// The <c>OpenAI</c> section's model ids, bound with the Options pattern (registered in Application's
/// DI). The defaults below are the only defaults: appsettings and compose do not repeat them, so a
/// retired model is changed here and nowhere else (docs/incidents/2026-10-24-translation-down-on-a-retired-model.md).
/// The client, the Explain/translate cache keys and the registry seed all read these options.
/// </summary>
public sealed class OpenAiOptions
{
    public const string SectionName = "OpenAI";

    /// <summary>Translate, and every OpenAI caller without its own model.</summary>
    public string Model { get; set; } = "gpt-4.1-mini";

    public ExplainModelOptions Explain { get; set; } = new();

    /// <summary>
    /// Compose passes an unset variable as an empty string (<c>${OPENAI_MODEL:-}</c>), and the binder
    /// overwrites the default with it. An empty model id would reach OpenAI as a 400; treat it as unset.
    /// </summary>
    public void FillBlanks()
    {
        var defaults = new OpenAiOptions();
        if (string.IsNullOrWhiteSpace(Model)) Model = defaults.Model;
        Explain ??= new();
        if (string.IsNullOrWhiteSpace(Explain.Model)) Explain.Model = defaults.Explain.Model;
    }

    public sealed class ExplainModelOptions
    {
        /// <summary>Explain and the tutor; also the distillation teacher.</summary>
        public string Model { get; set; } = "gpt-4.1-mini";
    }
}

/// <summary>The <c>Eval</c> section's judge model — stronger than the models it grades.</summary>
public sealed class EvalOptions
{
    public const string SectionName = "Eval";

    public string JudgeModel { get; set; } = "gpt-4.1";

    public void FillBlanks()
    {
        if (string.IsNullOrWhiteSpace(JudgeModel)) JudgeModel = new EvalOptions().JudgeModel;
    }
}
