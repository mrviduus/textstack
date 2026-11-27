using Microsoft.Extensions.AI;
using Microsoft.Extensions.AI.Evaluation;
using Microsoft.Extensions.Logging;
using TextStack.Ai.Core;
using TextStack.Ai.Evals;
using TextStack.Ai.Llm;

namespace TextStack.Ai.EvalSuite;

/// <summary>
/// Runs the eval suite in-process so the admin "Run evals" button works on prod.
/// Generation goes through <paramref name="generatorFor"/> (the real ModelGateway,
/// routed by FeatureTag → OpenAI exactly like prod). Judging goes through the
/// Microsoft.Extensions.AI.Evaluation <see cref="RubricEvaluator"/> (the same evaluator
/// the eval test suite uses), talking to <paramref name="judgeClient"/> via the
/// <see cref="LlmServiceChatClient"/> adapter — one scoring path shared by app + tests.
/// </summary>
public sealed class EvalSuiteRunner(ILogger<EvalSuiteRunner> logger)
{
    private static readonly ChatMessage[] JudgePlaceholderMessages = [new ChatMessage(ChatRole.User, string.Empty)];

    public async Task<IReadOnlyList<EvalRunResult>> RunAsync(
        Func<string, ILlmService> generatorFor,
        ILlmService judgeClient,
        IEnumerable<string>? keys,
        CancellationToken ct)
    {
        var defs = EvalDefinitions.Build(keys);
        var chatConfig = new ChatConfiguration(new LlmServiceChatClient(judgeClient, defaultFeatureTag: "eval.judge"));
        var results = new List<EvalRunResult>();

        foreach (var def in defs)
        {
            // feature → (rubric, generation modelId, scores)
            var acc = new Dictionary<string, (Rubric Rubric, string ModelId, List<JudgeScore> Scores)>();

            foreach (var unit in def.Units)
            {
                ct.ThrowIfCancellationRequested();
                var resp = await generatorFor(unit.Request.FeatureTag ?? def.Key).CompleteAsync(unit.Request, ct);
                var modelResponse = new ChatResponse(new ChatMessage(ChatRole.Assistant, resp.Text));

                foreach (var facet in unit.Facets)
                {
                    var evaluator = new RubricEvaluator(facet.Feature, facet.Rubric);
                    var result = await evaluator.EvaluateAsync(
                        JudgePlaceholderMessages, modelResponse, chatConfig,
                        [new RubricEvidenceContext(facet.Evidence(resp.Text))], ct);

                    var score = new JudgeScore(
                        ReadAxis(result, facet.Feature, facet.Rubric.Dim1),
                        ReadAxis(result, facet.Feature, facet.Rubric.Dim2),
                        ReadAxis(result, facet.Feature, facet.Rubric.Dim3),
                        string.Empty);

                    if (!acc.TryGetValue(facet.Feature, out var entry))
                        acc[facet.Feature] = entry = (facet.Rubric, resp.ModelId, new List<JudgeScore>());
                    entry.Scores.Add(score);
                }
            }

            foreach (var (feature, entry) in acc)
            {
                var summary = JudgeRunner.Aggregate(entry.Scores);
                results.Add(new EvalRunResult(feature, entry.ModelId, summary));
                logger.LogInformation("Eval {Feature}: N={N} overall={Score:0.00}", feature, summary.N, summary.MeanOverall);
            }
        }

        return results;
    }

    // RubricEvaluator names each axis "{feature}.{label}" (label = text before ':').
    private static int ReadAxis(EvaluationResult result, string feature, string dim) =>
        (int)Math.Round(result.Get<NumericMetric>($"{feature}.{Label(dim)}").Value ?? 0);

    private static string Label(string dim) => dim.Split(':')[0].Trim();
}
