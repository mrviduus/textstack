using TextStack.Ai.Core;
using TextStack.Ai.Evals;

namespace TextStack.Ai.EvalSuite;

/// <summary>One judged facet of a generation: the persisted feature key, its rubric,
/// and how to build the judge evidence from the model's actual output.</summary>
public sealed record FacetEval(string Feature, Rubric Rubric, Func<string, string> Evidence);

/// <summary>One golden case: the generation request + the facets judged on its output.
/// Vocab has 3 facets (distractor/hint/explanation) from a single generation.</summary>
public sealed record EvalUnit(LlmRequest Request, IReadOnlyList<FacetEval> Facets);

/// <summary>A feature's eval: a selectable <see cref="Key"/> (explain/translate)
/// and its golden units.</summary>
public sealed record EvalDefinition(string Key, IReadOnlyList<EvalUnit> Units);

/// <summary>Aggregate result for one persisted feature after a run.</summary>
public sealed record EvalRunResult(string Feature, string ModelId, EvalSummary Summary);
