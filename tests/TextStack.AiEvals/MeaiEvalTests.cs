using TextStack.Ai.EvalSuite;
using TextStack.Ai.Llm;

namespace TextStack.AiEvals;

/// <summary>
/// The golden suite run through Microsoft.Extensions.AI.Evaluation (the new path),
/// asserting the SAME per-feature floors as the legacy <see cref="EvalSuiteTests"/>.
/// Same goldens, same generation provider per feature, same judge — so a green run
/// here should match the legacy run (full old-vs-new comparison lands in Step 7).
/// Self-skips when a provider isn't available, exactly like the legacy suite.
/// </summary>
[Trait("Category", "Eval")]
public class MeaiEvalTests(ITestOutputHelper output)
{
    public static IEnumerable<object[]> Keys => EvalDefinitions.Keys.Select(k => new object[] { k });

    [Theory]
    [MemberData(nameof(Keys))]
    public async Task Feature_eval_meets_floor_via_MEAI(string key)
    {
        var generator = EvalClients.OpenAi();   // skips if unavailable
        var judge = new LlmServiceChatClient(EvalClients.Judge(), defaultFeatureTag: "eval.judge");
        var ct = TestContext.Current.CancellationToken;

        var reportPath = Path.Combine(EvalStorage.Root("report"), $"eval-report-{key}.html");
        var runner = new MeaiEvalRunner();
        var scores = await runner.RunAsync(
            generatorFor: _ => generator,
            judge: judge,
            keys: [key],
            storageRoot: EvalStorage.Root("cache"),
            ct: ct,
            executionName: key,
            reportPath: reportPath,
            // Opt-in (EVAL_QUALITY=1): add built-in Coherence/Relevance to explain+vocab.
            // Default CI stays deterministic-rubric-only.
            qualityEvaluators: Environment.GetEnvironmentVariable("EVAL_QUALITY") == "1");
        output.WriteLine($"MEAI HTML report → {reportPath}");

        Assert.NotEmpty(scores);
        foreach (var s in scores)
        {
            output.WriteLine($"{s.Feature}: N={s.N} overall={s.MeanOverall:0.00}");
            var floor = MeaiEvalRunner.Floor(s.Feature);
            Assert.True(s.MeanOverall >= floor,
                $"{s.Feature} mean {s.MeanOverall:0.00} below floor {floor:0.0}");
        }
    }
}
