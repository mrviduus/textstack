# Migration plan: custom eval suite → `Microsoft.Extensions.AI.Evaluation`

Status: **COMPLETE** — all 7 steps landed on `ai-018-eval-meai-migration`.

Parity confirmed two ways:
- **Deterministic:** `RubricEvaluatorTests` — given the same judge reply, the MEAI
  `RubricEvaluator` produces metrics identical to `JudgeRunner.ParseScore`.
- **Live (Ollama gemma3, N=30/feature):** legacy vs MEAI within ±0.05 on every feature —
  bookmeta 4.96/4.94, vocab.distractor 3.57/3.53, vocab.hint 4.77/4.72, vocab.explanation 4.90/4.94
  (deltas = LLM nondeterminism, not logic drift). Both pass all floors.

The admin `POST /admin/ai-quality/evals/run` now scores via `RubricEvaluator`; the legacy
`JudgeRunner.JudgeAsync` scoring path is removed (`JudgeRunner` is now a static prompt/parse
utility). HTML report + disk response cache live in the test suite (`data/eval-meai/`).

Goal: replace our hand-rolled eval runner/judge with the Microsoft.Extensions.AI.Evaluation
(MEAI.Eval) framework, **keeping our golden datasets as the source of truth** and **keeping
scores comparable** (same thresholds, same local-Ollama judge). Migrate behind a parallel run —
old and new produce the same pass/fail on the full golden set before the old path is removed.

---

## 1. Current state (what we have)

| Piece | Path | Role |
|---|---|---|
| Golden models | `backend/src/Ai/TextStack.Ai.EvalSuite/{Explain,Translate,Vocab,BookMeta,Podcast}Golden.cs` | typed records per feature |
| Datasets | `backend/src/Ai/TextStack.Ai.EvalSuite/Datasets/*.json` (embedded) | the goldens (source of truth) |
| Loader | `…/GoldenLoader.cs` | reads embedded JSON → records |
| Definitions | `…/EvalDefinitions.cs` | per-feature: build `LlmRequest` (real prompt) + judge `Rubric` + evidence builder; `Keys` = explain/translate/vocab/bookmeta/podcast |
| Runner | `…/EvalSuiteRunner.cs` | for each golden: generate via `ILlmService`, judge via `JudgeRunner` (LLM rubric → `JudgeScore{D1,D2,D3}`, 1–5), aggregate, persist `EvalRun` |
| Generic judge | `backend/src/Ai/TextStack.Ai.Evals/JudgeRunner.cs` | strict-JSON 3-dim rubric scorer |
| LLM layer | `backend/src/Ai/TextStack.Ai.Llm/{OpenAiLlmClient,OllamaLlmClient,ModelGateway}` (`ILlmService`) | providers + routing |
| Test runner | `tests/TextStack.AiEvals/{EvalSuiteTests,EvalClients}.cs` | xUnit v3 Theory over `Keys`; `EvalClients` builds OpenAi/Ollama clients + skips when absent |
| Admin path | `POST /admin/ai-quality/evals/run` → `EvalSuiteRunner` | in-app on-demand run, writes `eval_runs` |

Judge today: local Ollama (`EVAL_JUDGE=ollama`, gemma) or OpenAI, via our `ILlmService`. Floors:
explain/translate ≥ 3.5, others ≥ 3.0 (1–5 scale).

## 2. Target (MEAI.Eval)

- **`Microsoft.Extensions.AI.Evaluation`** — core (`IEvaluator`, `EvaluationResult`, `EvaluationMetric`/`NumericMetric`).
- **`Microsoft.Extensions.AI.Evaluation.Quality`** — built-in LLM-judge evaluators (Relevance, Coherence, …).
- **`Microsoft.Extensions.AI.Evaluation.Reporting`** — `ReportingConfiguration`, disk response cache, HTML report.
- **`Microsoft.Extensions.AI`** (abstractions) — `IChatClient`, the seam every evaluator talks to.

Our `ILlmService` is wrapped as an **`IChatClient`** so all evaluators (built-in and custom) call
**the same local Ollama** we already use — no new external service.

## 3. Concept mapping

| Ours | MEAI.Eval |
|---|---|
| `GoldenLoader` + `Datasets/*.json` | **unchanged** — feed each golden as a scenario |
| One golden case | one `ScenarioRun` (`reportingConfig.CreateScenarioRunAsync(key)`) |
| `EvalDefinitions` request build (real prompt) | the "response under test": generate via our `IChatClient`, pass messages+response to evaluators |
| `JudgeRunner` rubric (D1/D2/D3, 1–5) | a **custom `IEvaluator`** (`RubricEvaluator`) emitting 3 `NumericMetric`s + overall, with the SAME prompt/parse |
| Floor thresholds | `EvaluationMetricInterpretation` (rating + `Failed` when below floor) — identical numbers |
| `EvalRun` persistence | MEAI reporting store (disk) + we keep writing `eval_runs` for the `/ai-quality` dashboard |
| built-in quality | `RelevanceEvaluator` / `CoherenceEvaluator` for explain & vocab (extra signal) |

## 4. Step-by-step (small commits, in order)

**Step 1 — packages.** Add to `Directory.Packages.props`: `Microsoft.Extensions.AI`,
`Microsoft.Extensions.AI.Evaluation`, `…Evaluation.Quality`, `…Evaluation.Reporting` (pin one
preview version). Reference the three Evaluation packages + `Microsoft.Extensions.AI` from
`tests/TextStack.AiEvals`. Build only — no behavior. _Commit: "chore(eval): add MEAI.Evaluation packages"._

**Step 2 — `IChatClient` adapter.** New `LlmServiceChatClient : IChatClient` in
`TextStack.Ai.Llm` (or the test project) wrapping `ILlmService`: map `ChatMessage[]` →
`LlmRequest` (system + user), return `ChatResponse` from `LlmResponse.Text`; `GetService`/dispose
no-ops; streaming optional. Lets evaluators call our Ollama/OpenAI gateway. _Commit: "feat(eval): ILlmService→IChatClient adapter"._

**Step 3 — custom `RubricEvaluator`.** Port `JudgeRunner` to an `IEvaluator` that takes a
`Rubric` (3 axes), runs the **same** judge prompt via the injected `IChatClient`, parses the
**same** strict JSON, and returns an `EvaluationResult` with `NumericMetric` per axis + an overall,
each interpreted Pass/Fail against the **same floor**. Reuse `EvalDefinitions` rubrics/evidence
verbatim so scores are identical. _Commit: "feat(eval): RubricEvaluator (parity with JudgeRunner)"._

**Step 4 — wire datasets → scenarios.** New `MeaiEvalTests` (xUnit) that, per `EvalDefinitions.Keys`,
loads goldens via the existing `GoldenLoader`, generates the response with the adapter, and runs
the scenario through a `ReportingConfiguration`. **GoldenLoader + Datasets unchanged.** Assert the
same floors. _Commit: "feat(eval): run goldens through MEAI scenarios"._

**Step 5 — reporting + caching.** `ReportingConfiguration` with a **disk response cache**
(`data/eval-cache`) so repeated runs don't re-hit the LLM, + HTML report output
(`data/eval-report/`). Keep runnable via `dotnet test`; document the report path. _Commit: "feat(eval): reporting config + response cache + HTML report"._

**Step 6 — built-in quality (opt-in).** Add `RelevanceEvaluator` + `CoherenceEvaluator` to the
**explain** and **vocab** scenarios, gated behind `EVAL_QUALITY=1` so default CI stays
deterministic-only. _Commit: "feat(eval): optional built-in quality evaluators"._

**Step 7 — parallel-run, compare, remove old.** Run BOTH `EvalSuiteRunner` (old) and the MEAI
path on the full golden set (local, Ollama judge). Compare per-feature pass/fail + mean scores;
they must match. Only then delete `EvalSuiteRunner` + `EvalSuiteTests` (keep `EvalDefinitions`
data + `GoldenLoader`). The admin `POST /admin/ai-quality/evals/run` is repointed to the MEAI
runner in the same step. _Commit: "refactor(eval): remove legacy runner after parity confirmed"._

## 5. Constraints honored
- Golden datasets stay the source of truth (GoldenLoader untouched).
- Judge = local Ollama via the same client (no new external service).
- Thresholds/prompts ported verbatim → comparable scores.
- Old runner stays until parity is proven, then removed.
- CPM, xUnit v3, .NET 10, project layout per CLAUDE.md.

## 6. Decisions (locked) + remaining risk
Decided 2026-06-06:
- **Adapter location** → `TextStack.Ai.Llm` (reusable by app + tests).
- **`eval_runs` dashboard** → keep writing `eval_runs` rows **in addition** to MEAI's report store, so `/ai-quality` keeps working unchanged.
- **HTML report** → generate to `data/eval-report/` only (gitignored); CI may publish as artifact. Not committed.
- **Built-in quality evaluators** (Relevance/Coherence on explain+vocab) → gated behind `EVAL_QUALITY=1`; default CI stays deterministic (rubric-parity only).
- **Scoring baseline** → our bespoke 1–5×3 rubric stays the parity baseline; built-in evaluators are additional/opt-in, never the gate.

Remaining risk:
1. **Package maturity** — MEAI.Evaluation is preview; pin one known-good version in CPM and bump deliberately.

Dataset scope feeding scenarios (unchanged, source of truth): explain 30 · translate 30 · vocab 30 (×3 facets) · bookmeta 30 · podcast 5 = **125 goldens**.

---
On approval I'll execute Steps 1→7 as separate commits and finish with the old-vs-new score comparison on the full golden set.
