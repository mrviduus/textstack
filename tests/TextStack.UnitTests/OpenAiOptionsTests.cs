using Application;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TextStack.Ai.Llm;

namespace TextStack.UnitTests;

/// <summary>
/// OpenAI model ids come only from <see cref="OpenAiOptions"/> / <see cref="EvalOptions"/>: the class defaults
/// are the only defaults (appsettings and compose do not repeat them), and compose's empty
/// <c>${OPENAI_MODEL:-}</c> must not reach OpenAI as a blank model id. Resolved through the real
/// <c>AddApplication()</c> registration, so the binding and the blank guard are both covered.
/// </summary>
public class OpenAiOptionsTests
{
    private static (OpenAiOptions OpenAi, EvalOptions Eval) Resolve(Dictionary<string, string?> settings)
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(settings).Build());
        services.AddApplication();
        using var sp = services.BuildServiceProvider();
        return (sp.GetRequiredService<IOptions<OpenAiOptions>>().Value, sp.GetRequiredService<IOptions<EvalOptions>>().Value);
    }

    [Fact]
    public void Resolve_NothingConfigured_UsesClassDefaults()
    {
        var (openAi, eval) = Resolve([]);

        Assert.Equal(new OpenAiOptions().Model, openAi.Model);
        Assert.Equal(new OpenAiOptions().Explain.Model, openAi.Explain.Model);
        Assert.Equal(new EvalOptions().JudgeModel, eval.JudgeModel);
    }

    [Fact]
    public void Resolve_Configured_UsesConfiguredModels()
    {
        var (openAi, eval) = Resolve(new()
        {
            ["OpenAI:Model"] = "translate-model",
            ["OpenAI:Explain:Model"] = "explain-model",
            ["Eval:JudgeModel"] = "judge-model",
        });

        Assert.Equal("translate-model", openAi.Model);
        Assert.Equal("explain-model", openAi.Explain.Model);
        Assert.Equal("judge-model", eval.JudgeModel);
    }

    [Fact]
    public void Resolve_BlankValues_FallBackToDefaults()
    {
        var (openAi, eval) = Resolve(new()
        {
            ["OpenAI:Model"] = "",
            ["OpenAI:Explain:Model"] = "  ",
            ["Eval:JudgeModel"] = "",
        });

        Assert.Equal(new OpenAiOptions().Model, openAi.Model);
        Assert.Equal(new OpenAiOptions().Explain.Model, openAi.Explain.Model);
        Assert.Equal(new EvalOptions().JudgeModel, eval.JudgeModel);
    }

    [Fact]
    public void Resolve_TrailingCarriageReturn_IsTrimmed()
    {
        var (openAi, eval) = Resolve(new()
        {
            ["OpenAI:Model"] = "translate-model\r",
            ["Eval:JudgeModel"] = " judge-model ",
        });

        Assert.Equal("translate-model", openAi.Model);
        Assert.Equal("judge-model", eval.JudgeModel);
    }
}
