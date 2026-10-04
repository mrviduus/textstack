using Application.Ai;
using TextStack.Ai.Core;
using TextStack.Ai.Evals;
using TextStack.Vocabulary;

namespace TextStack.Ai.EvalSuite;

/// <summary>
/// The feature-specific eval registry: ties each golden dataset to the REAL
/// production prompt (ExplainPrompt/TranslatePrompt/DistractorPrompt/BookMetadataPrompt)
/// and its judge rubric(s). Generation runs through the gateway by FeatureTag, so
/// explain/translate hit OpenAI and vocab/bookmeta hit Ollama exactly like prod.
/// </summary>
public static class EvalDefinitions
{
    public static readonly IReadOnlyList<string> Keys = ["explain", "translate", "vocab", "bookmeta"];

    private static readonly Rubric ExplainRubric = new(
        "accuracy: does it match the meaning the word carries IN THIS SENTENCE's domain?",
        "conciseness: 2-3 sentences, no padding, no dictionary boilerplate?",
        "usefulness: would a developer learning the topic find it genuinely helpful?");

    private static readonly Rubric TranslateRubric = new(
        "accuracy: does it convey the source meaning, using the domain sense when a genre/sentence is given?",
        "fluency: is it natural, grammatical target-language text?",
        "register: right domain register, parenthetical clarifier only when genuinely ambiguous?");

    private static readonly Rubric DistractorRubric = new(
        "plausibility: are the 5 distractors real words that could plausibly confuse a learner (same part of speech)?",
        "distinctness: are they clearly WRONG (not synonyms of the target) and distinct from one another?",
        "difficulty: single words, similar register to the target — not trivially eliminable?");

    private static readonly Rubric HintRubric = new(
        "helpfulness: does the hint point at the meaning?",
        "no-spoiler: does it avoid using the target word or a direct synonym?",
        "brevity: one short sentence, roughly under 15 words?");

    private static readonly Rubric ExplanationRubric = new(
        "accuracy: does it correctly explain the word (and its use in context if given)?",
        "clarity: clear and learner-friendly, 2-3 sentences?",
        "nativeness: written fluently in the requested native language?");

    private static readonly Rubric BookMetaRubric = new(
        "genre-accuracy: does the GENRE line match or reasonably fit the book?",
        "year-plausibility: is the YEAR correct or close to the real first-publication year?",
        "description-quality: is the DESCRIPTION accurate, 2-3 sentences, no spoilers?");


    /// <summary>Build all eval definitions (optionally filtered to <paramref name="keys"/>).</summary>
    public static IReadOnlyList<EvalDefinition> Build(IEnumerable<string>? keys = null)
    {
        var wanted = keys is null ? null : new HashSet<string>(keys, StringComparer.OrdinalIgnoreCase);
        var defs = new List<EvalDefinition>();

        if (Want(wanted, "explain"))
        {
            var units = GoldenLoader.Load<ExplainGolden>("explain.json").Select(g => new EvalUnit(
                new LlmRequest(
                    ExplainPrompt.BuildSystemPrompt(g.Genre, g.TargetLang),
                    [new LlmMessage("user", ExplainPrompt.BuildUserPrompt(g.Word, g.Sentence))],
                    MaxOutputTokens: 500, FeatureTag: "explain"),
                [new FacetEval("explain", ExplainRubric, actual =>
                    $"Word: {g.Word}\nSentence: {g.Sentence}\nReference explanation: {g.ExpectedExplanation}\nActual explanation: {actual}")]))
                .ToList();
            defs.Add(new EvalDefinition("explain", units));
        }

        if (Want(wanted, "translate"))
        {
            var units = GoldenLoader.Load<TranslateGolden>("translate.json").Select(g => new EvalUnit(
                new LlmRequest(
                    TranslatePrompt.BuildSystemPrompt(g.SourceLang, g.TargetLang, g.Genre, g.Sentence),
                    [new LlmMessage("user", g.Text)],
                    MaxOutputTokens: 1000, FeatureTag: "translate"),
                [new FacetEval("translate", TranslateRubric, actual =>
                    $"Text: {g.Text}\nDirection: {g.SourceLang} -> {g.TargetLang}\nDomain: {g.Genre ?? "(none)"}\n" +
                    $"Sentence: {g.Sentence ?? "(none)"}\nReference translation: {g.ExpectedTranslation}\nActual translation: {actual}")]))
                .ToList();
            defs.Add(new EvalDefinition("translate", units));
        }

        if (Want(wanted, "vocab"))
        {
            var units = GoldenLoader.Load<VocabGolden>("vocab.json").Select(g =>
            {
                var (sys, user) = DistractorPrompt.Build(g.Word, g.Language, g.Definition, g.Sentence, g.NativeLanguage);
                return new EvalUnit(
                    new LlmRequest(sys, [new LlmMessage("user", user)], MaxOutputTokens: 600, FeatureTag: "distractor"),
                    [
                        new FacetEval("vocab.distractor", DistractorRubric, actual =>
                            $"Target word: {g.Word}\nReference distractors: {string.Join(", ", g.ExpectedDistractors)}\n" +
                            $"Model output (evaluate the DISTRACTORS line):\n{actual}"),
                        new FacetEval("vocab.hint", HintRubric, actual =>
                            $"Target word: {g.Word}\nReference hint: {g.ExpectedHint}\nModel output (evaluate the HINT line):\n{actual}"),
                        new FacetEval("vocab.explanation", ExplanationRubric, actual =>
                            $"Target word: {g.Word}\nNative language: {g.NativeLanguage}\nReference explanation: {g.ExpectedExplanation}\n" +
                            $"Model output (evaluate the EXPLANATION line):\n{actual}"),
                    ]);
            }).ToList();
            defs.Add(new EvalDefinition("vocab", units));
        }

        if (Want(wanted, "bookmeta"))
        {
            var units = GoldenLoader.Load<BookMetaGolden>("bookmeta.json").Select(g =>
            {
                var (sys, user) = BookMetadataPrompt.Build(g.Title, g.Author, needsDescription: true);
                return new EvalUnit(
                    new LlmRequest(sys, [new LlmMessage("user", user)], MaxOutputTokens: 400, FeatureTag: "bookmeta"),
                    [new FacetEval("bookmeta", BookMetaRubric, actual =>
                        $"Title: {g.Title}\nAuthor: {g.Author ?? "(unknown)"}\nReference genre: {g.ExpectedGenre}\n" +
                        $"Reference year: {g.ExpectedYear?.ToString() ?? "ancient/uncertain"}\nReference description: {g.ExpectedDescription}\n" +
                        $"Model output (GENRE/YEAR/DESCRIPTION lines):\n{actual}")]);
            }).ToList();
            defs.Add(new EvalDefinition("bookmeta", units));
        }


        return defs;
    }

    private static bool Want(HashSet<string>? wanted, string key) => wanted is null || wanted.Contains(key);
}
