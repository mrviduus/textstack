using TextStack.Ai.Core;
using TextStack.Ai.Llm;

namespace TextStack.AiEvals;

/// <summary>
/// Deterministic Step-5 coverage: drives <see cref="MeaiEvalRunner"/> with a fake
/// generator + fake judge (no OpenAI) so it always runs in CI, and asserts the
/// MEAI reporting pipeline (disk result store + response cache + HtmlReportWriter)
/// actually produces an HTML report.
/// </summary>
public class MeaiReportingTests
{
    private sealed class FixedLlm(string reply) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) =>
            Task.FromResult(new LlmResponse(reply, [], new LlmUsage(0, 0, 0m), "fake", Guid.NewGuid()));

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) =>
            throw new NotSupportedException();
    }

    [Fact]
    public async Task Run_writes_an_html_report_for_the_execution()
    {
        var ct = TestContext.Current.CancellationToken;
        var generator = new FixedLlm("GENRE: Fiction\nYEAR: 1900\nDESCRIPTION: A canned description for the report test.");
        var judge = new LlmServiceChatClient(new FixedLlm("{\"d1\":4,\"d2\":4,\"d3\":4}"), defaultFeatureTag: "eval.judge");
        var reportPath = Path.Combine(EvalStorage.Root("test-report"), "unit-report.html");

        var scores = await new MeaiEvalRunner().RunAsync(
            generatorFor: _ => generator,
            judge: judge,
            keys: ["bookmeta"],
            storageRoot: EvalStorage.Root("test-cache"),
            ct: ct,
            executionName: "unittest",
            reportPath: reportPath);

        // All facets scored 4/4/4 → overall 4.0, above the 3.0 floor.
        Assert.NotEmpty(scores);
        Assert.All(scores, s => Assert.True(s.MeanOverall >= 3.0));

        // The reporting pipeline wrote a non-empty HTML report.
        Assert.True(File.Exists(reportPath), $"expected HTML report at {reportPath}");
        Assert.True(new FileInfo(reportPath).Length > 0, "HTML report is empty");
    }

    [Fact]
    public async Task Quality_evaluators_opt_in_does_not_break_the_run()
    {
        // With qualityEvaluators on, explain scenarios also run MEAI's built-in
        // Coherence + Relevance. Against a fake judge those produce diagnostics, not
        // exceptions — the run must still complete, gate on the rubric floor, and report.
        var ct = TestContext.Current.CancellationToken;
        var generator = new FixedLlm("A clear, concise explanation of the word in context.");
        var judge = new LlmServiceChatClient(new FixedLlm("{\"d1\":4,\"d2\":4,\"d3\":4}"), defaultFeatureTag: "eval.judge");
        var reportPath = Path.Combine(EvalStorage.Root("test-report"), "unit-report-quality.html");

        var scores = await new MeaiEvalRunner().RunAsync(
            generatorFor: _ => generator,
            judge: judge,
            keys: ["explain"],
            storageRoot: EvalStorage.Root("test-cache-quality"),
            ct: ct,
            executionName: "unittest-quality",
            reportPath: reportPath,
            qualityEvaluators: true);

        Assert.NotEmpty(scores);
        Assert.All(scores, s => Assert.True(s.MeanOverall >= 3.5));   // explain floor unaffected by quality
        Assert.True(File.Exists(reportPath) && new FileInfo(reportPath).Length > 0);
    }
}
