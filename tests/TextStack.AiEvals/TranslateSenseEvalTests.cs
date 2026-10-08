using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using TextStack.Ai.Core;
using TextStack.Ai.EvalSuite;
using TextStack.Ai.Llm;

namespace TextStack.AiEvals;

/// <summary>
/// QA-007: "pocketed" → pt-BR "enterrado" (buried). This eval asks one question per case —
/// did the translation keep the sense the word has IN ITS SENTENCE? — across nano vs mini,
/// with and without the sentence in the prompt. Deterministic tests pin the runner;
/// the live run skips without <c>OPENAI_API_KEY</c>.
/// </summary>
public class TranslateSenseEvalTests
{
    private static readonly string[] Targets = ["pt", "uk", "es", "de"];

    /// <summary>Generator fake: right sense only when the sentence reached the prompt.</summary>
    private sealed class ContextSensitiveTranslator : ILlmService
    {
        public List<string> SystemPrompts { get; } = [];

        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            lock (SystemPrompts) SystemPrompts.Add(request.SystemPrompt);
            var text = request.SystemPrompt.Contains("Sentence context:", StringComparison.Ordinal) ? "RIGHT" : "WRONG";
            return Task.FromResult(new LlmResponse(text, [], new LlmUsage(10, 2, 0m), "fake", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) => throw new NotSupportedException();
    }

    /// <summary>Judge fake: CORRECT iff the translation under review is "RIGHT".</summary>
    private sealed class FakeJudge(string? fixedReply = null) : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct)
        {
            var reply = fixedReply ?? (request.Messages[^1].Content.Contains("Translation: RIGHT", StringComparison.Ordinal)
                ? "CORRECT\nkeeps the sense" : "WRONG\nother sense");
            return Task.FromResult(new LlmResponse(reply, [], new LlmUsage(10, 2, 0m), "judge", Guid.NewGuid()));
        }

        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) => throw new NotSupportedException();
    }

    private sealed class ThrowingLlm : ILlmService
    {
        public Task<LlmResponse> CompleteAsync(LlmRequest request, CancellationToken ct) => throw new HttpRequestException("boom");
        public IAsyncEnumerable<LlmDelta> StreamAsync(LlmRequest request, CancellationToken ct) => throw new NotSupportedException();
    }

    private static readonly IReadOnlyList<TranslateSenseGolden> Two =
    [
        new("pocketed", "He pocketed the coins.", "put into his pocket"),
        new("wound", "He wound the clock.", "turned the key (past of wind)"),
    ];

    // Review r8 of #780: a judge that decorates its verdict must not be scored WRONG.
    [Theory]
    [InlineData("**CORRECT** — keeps the sense", true)]
    [InlineData("Verdict: CORRECT\nkeeps the sense", true)]
    [InlineData("CORRECT", true)]
    [InlineData("WRONG", false)]
    [InlineData("**WRONG** — the correct sense is 'put away'", false)]
    [InlineData("INCORRECT", false)]
    [InlineData("I am not sure", false)]
    // Review r9: a negation is wrong, not read as its CORRECT.
    [InlineData("Not correct: it means 'buried'", false)]
    [InlineData("**NOT CORRECT**", false)]
    [InlineData("The translation is not  correct.", false)]
    [InlineData("Incorrect — the sense is 'put into a pocket'", false)]
    public void IsCorrectVerdict_JudgeReply_NegativesCheckedFirst(string reply, bool expected)
    {
        Assert.Equal(expected, TranslateSenseEvalRunner.IsCorrectVerdict(reply));
    }

    [Fact]
    public void LoadGoldens_Dataset_ThirtyCasesEachSentenceContainsItsWord()
    {
        var goldens = TranslateSenseEvalRunner.LoadGoldens();

        Assert.True(goldens.Count >= 30, $"expected >= 30 cases, got {goldens.Count}");
        Assert.All(goldens, g =>
        {
            Assert.Contains(g.Word, g.Sentence, StringComparison.OrdinalIgnoreCase);
            Assert.False(string.IsNullOrWhiteSpace(g.Sense));
        });
        Assert.Contains(goldens, g => g.Word == "pocketed");
    }

    [Fact]
    public async Task RunAsync_WithContext_SentenceInPromptAndAllCorrect()
    {
        var gen = new ContextSensitiveTranslator();

        var r = await TranslateSenseEvalRunner.RunAsync(gen, new FakeJudge(), Two, Targets, withContext: true,
            TestContext.Current.CancellationToken);

        Assert.Equal(Two.Count * Targets.Length, r.N);
        Assert.Equal(1.0, r.Accuracy, 3);
        Assert.All(gen.SystemPrompts, p => Assert.Contains("Sentence context:", p));
    }

    [Fact]
    public async Task RunAsync_WithoutContext_NoSentenceInPromptAndAllWrong()
    {
        var gen = new ContextSensitiveTranslator();

        var r = await TranslateSenseEvalRunner.RunAsync(gen, new FakeJudge(), Two, Targets, withContext: false,
            TestContext.Current.CancellationToken);

        Assert.Equal(0.0, r.Accuracy, 3);
        Assert.All(gen.SystemPrompts, p => Assert.DoesNotContain("Sentence context:", p));
        Assert.All(r.Cases, c => Assert.Equal("WRONG", c.Translation));
    }

    [Fact]
    public async Task RunAsync_UnparseableVerdict_CountedWrong()
    {
        var r = await TranslateSenseEvalRunner.RunAsync(new ContextSensitiveTranslator(), new FakeJudge("maybe?"), Two,
            ["pt"], withContext: true, TestContext.Current.CancellationToken);

        Assert.Equal(0.0, r.Accuracy, 3);
        Assert.All(r.Cases, c => Assert.False(c.Correct));
    }

    [Fact]
    public async Task RunAsync_GeneratorThrows_CaseRecordedAsErrorNotThrown()
    {
        var r = await TranslateSenseEvalRunner.RunAsync(new ThrowingLlm(), new FakeJudge(), Two, ["pt"], withContext: true,
            TestContext.Current.CancellationToken);

        Assert.Equal(2, r.N);
        Assert.Equal(0.0, r.Accuracy, 3);
        Assert.All(r.Cases, c => Assert.NotNull(c.Error));
    }

    /// <summary>
    /// Live: nano vs mini × with/without sentence, judged by gpt-4.1 (stronger than both,
    /// so mini is not grading itself). Opt-in:
    /// <c>OPENAI_API_KEY=… dotnet test tests/TextStack.AiEvals --filter "Name~TranslateSense_Live"</c>
    /// </summary>
    [Fact]
    public async Task TranslateSense_Live_NanoVsMiniWithAndWithoutContext_ReportsAccuracy()
    {
        var key = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        Assert.SkipWhen(string.IsNullOrWhiteSpace(key), "OPENAI_API_KEY not set — eval skipped (opt-in).");

        var judgeModel = Environment.GetEnvironmentVariable("EVAL_JUDGE_MODEL") ?? "gpt-4.1";
        var judge = Client(judgeModel);
        var goldens = TranslateSenseEvalRunner.LoadGoldens();
        var ct = TestContext.Current.CancellationToken;

        var lines = new List<string> { $"judge={judgeModel}, cases={goldens.Count}x{Targets.Length}" };
        foreach (var model in new[] { "gpt-4.1-nano", "gpt-4.1-mini" })
        {
            foreach (var withContext in new[] { true, false })
            {
                var r = await TranslateSenseEvalRunner.RunAsync(Client(model), judge, goldens, Targets, withContext, ct);
                // A bad key / model name errors every case — that is wiring, not a 0% score.
                var errors = r.Cases.Where(c => c.Error is not null).ToList();
                Assert.True(errors.Count * 2 < r.N, $"{model}: {errors.Count}/{r.N} cases errored, first: {errors.FirstOrDefault()?.Error}");
                var perLang = string.Join(" ", Targets.Select(t =>
                    $"{t}={r.Cases.Where(c => c.TargetLang == t).Average(c => c.Correct ? 1.0 : 0.0):P0}"));
                lines.Add($"{model} context={withContext}: {r.Accuracy:P1} ({r.Cases.Count(c => c.Correct)}/{r.N}) [{perLang}]");
                lines.AddRange(r.Cases.Where(c => !c.Correct)
                    .Select(c => $"    x {c.Word}->{c.TargetLang}: {c.Translation ?? c.Error}"));
            }
        }

        var report = string.Join(Environment.NewLine, lines);
        TestContext.Current.TestOutputHelper?.WriteLine(report);
        var outPath = Environment.GetEnvironmentVariable("EVAL_REPORT_PATH");
        if (!string.IsNullOrWhiteSpace(outPath))
            await File.WriteAllTextAsync(outPath, report, ct);
    }

    private static OpenAiLlmClient Client(string model) =>
        new(new ConfigurationBuilder().Build(), NullLogger<OpenAiLlmClient>.Instance, model);
}
