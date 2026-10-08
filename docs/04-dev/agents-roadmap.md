# Agents Roadmap — three ReAct agents on TextStack's existing AI stack

> **Historical (design doc, mid-2026).** Outcome: Agent 1 (`EnrichmentAgent`, feature `bookmeta.agent`)
> and Agent 2 (`TutorAgent`) shipped and remain. Agent 3 (Librarian) was built and then **deleted
> 2026-09-10** together with `StudyBuddyAgent`, book chat, `ask_book` and the whole RAG stack
> (`IRagService`, `TextStack.Ai.Rag`) — see [assistant-handoff.md](../05-features/assistant-handoff.md).
> `LookupDictionaryTool`, `SearchBookTool` and `FindEarlierDefinitionTool` named below no longer exist.
> The §0 description of `AgentLoop` / `ToolRegistry` / `ModelGateway` is still broadly right; line numbers are not maintained.

> Design doc. No code here. The goal is to show three *genuinely agentic* features
> (reason → call tools → observe → retry, stateful, some human-in-the-loop) that plug
> into TextStack's **existing** `TextStack.Ai.*` runtime, not new infra bolted on.
>
> Product thesis (non-negotiable): **fluency through reading**. Every agent below must
> make the user a better reader, not turn the app into a drill / chatbot toy.

---

## 0. What already exists (the seams the agents reuse)

The codebase already shipped a hand-rolled ReAct runtime in Phase 5/6. This is the single
most important fact for this doc: **we do not build an agent framework — we already have one.**

### 0.1 The ReAct loop — `AgentLoop`
`backend/src/Ai/TextStack.Ai.Agents/AgentLoop.cs:30` is the plan → act → observe loop every
concrete agent runs on. Per iteration it:
- calls `ILlmService.CompleteAsync` with the agent's allowed tool schemas (`AgentLoop.cs:72`),
- if the model answers with **no** tool call → that's the final answer (`AgentLoop.cs:86`),
- else dispatches the requested tools (validated, in parallel, failures returned **as data** so
  the model can recover — `AgentLoop.cs:98`) and feeds results back for the next turn,
- is bounded by `AgentLoopOptions` — a hard `MaxSteps` cap **and** an optional cumulative
  `CostCapUsd` (`Agents.cs:41`); exhausting either throws `AgentBudgetExhaustedException` which
  *carries the partial transcript* (`Agents.cs:52`),
- records every turn as an `AgentStep` (`Agents.cs:6`) and can stream them as SSE
  (`AgentLoop.StreamAsync`, `AgentLoop.cs:55`).

This is exactly the "reason/act/observe + stopping criteria + budget" loop the three agents need.
**All three reuse it.** No new loop.

### 0.2 Tools — define once, dispatch everywhere
- `ITool` (`backend/src/Ai/TextStack.Ai.Core/ITool.cs:8`): `Name`, `Description`, `ArgsSchema`
  (JSON Schema draft 2020-12), `InvokeAsync(args, ToolContext, ct)`.
- `ToolContext` (`Tools.cs:12`): `UserId?`, `EditionId?`, `AgentRunId`, **a scoped
  `IServiceProvider`** — tools resolve `IAppDbContext`, `IHttpClientFactory`, RAG, etc. at invoke
  time.
- `ToolRegistry` (`backend/src/Ai/TextStack.Ai.Tools/ToolRegistry.cs:11`): indexes every
  DI-registered `ITool` by name; `SchemasFor(names)` returns the per-agent subset offered to the
  model.
- `ToolDispatcher` (`ToolDispatcher.cs:29`): resolves tool → **validates args against the tool's
  JSON Schema** → invokes inside **its own DI scope** (so parallel tools don't share a DbContext,
  `ToolDispatcher.cs:48`). Unknown tool / bad args / thrown exception all come back as a failed
  `ToolResult` (data, not an exception) → the model self-corrects.
- Existing concrete tools to copy from: `GetChapterTool` (DB read, `backend/src/Application/Tools/GetChapterTool.cs`),
  `SearchBookTool`, `FindEarlierDefinitionTool`, `GetUserHighlightsTool`, `GetUserVocabularyTool`,
  and crucially **`LookupDictionaryTool`** (`Application/Tools/LookupDictionaryTool.cs:48`) — the
  *external-HTTP-from-a-tool* pattern: `ctx.Services.GetRequiredService<IHttpClientFactory>()`,
  10s timeout, "not found" returned as `{found:false}` data not an error. **Agent 1 and Agent 3's
  external-catalog tools are this pattern.**

Tools are registered by an assembly scan: `builder.Services.AddAiTools(typeof(GetChapterTool).Assembly)`
(`Api/Program.cs:95`). Adding a tool = add an `ITool` class; it's auto-discovered.

### 0.3 The LLM gateway — one seam, keyed providers, routing, budget, shadow
`ILlmService` (`Core/ILlmService.cs:7`) is the single seam every call flows through. The concrete
`ModelGateway` (`backend/src/Ai/TextStack.Ai.Llm/ModelGateway.cs:27`) routes by `FeatureTag`
(`Ai:Routes:{featureTag}` → keyed provider, registry-overridable by admin promote/rollback,
`ModelGateway.cs:85`), enforces **per-feature daily budgets** (`BudgetAwareRoute`, `.cs:121`:
fallback-to-cheaper or hard-stop), records spend, and fires **shadow** runs for eval
(`MaybeShadow`, `.cs:225`). Providers: OpenAI (`OpenAiLlmClient`) keyed for gpt-4.1-nano / -mini,
and Ollama (`OllamaLlmClient`) for local. **A new agent just picks a `FeatureTag`** and gets
routing/budget/tracing/shadow for free.

Legacy callers (the current enrichment path) reach this via `ILlmServiceFactory.Get(jobName)`
(`Application/LLM/LlmServiceFactory.cs:11`), which maps a job name → FeatureTag and wraps the
gateway in a `LegacyLlmAdapter`. `BookMetadata` → feature tag `bookmeta` is already wired
(`LlmServiceFactory.cs:20`).

### 0.4 Observability — `llm_traces` + `agent_run`
- Every `ILlmService` call is auto-traced by `TracingDecorator` → `ILlmTraceWriter` →
  `DbLlmTraceWriter` → `llm_traces` (`Application/Ai/DbLlmTraceWriter.cs:13`): model, prompt hash,
  redacted system/messages/response, tokens, cost, latency, `TraceParentId`, error. **Agents get
  this per-step for free** because each step is an `ILlmService` call.
- Each finished agent run is persisted to `agent_run` (`Domain/Entities/AgentRun.cs:10`) via
  `IAgentRunWriter` → `DbAgentRunWriter` (`Application/Ai/DbAgentRunWriter.cs:14`): agent name,
  user/edition, goal, status (`completed | budget_exhausted | error`), final output, **full step
  transcript as jsonb**, iterations/tokens/cost/latency. Built by `AgentRunRecordFactory`
  (`Agents/AgentRunRecordFactory.cs:9`) — `Completed` / `BudgetExhausted` (keeps partial
  transcript) / `Failed`. The reader UI replays steps from here.

### 0.5 RAG + hybrid search the agents call
- `IRagService` (`backend/src/Ai/TextStack.Ai.Rag/IRagService.cs`) + `RagService` — chunk,
  embed, retrieve, RRF-fuse (`RrfFusion.cs`), spoiler-gated "ask this book" (answers only from
  chapters the user has read). On-demand per-book indexing (catalog has 0 chunks until clicked;
  see MEMORY: RAG on-demand). Already exposed to agents/MCP as `ask_book`.
- Search providers: Postgres FTS (`Search/.../PostgresSearchProvider.cs`) + hybrid semantic
  (AI-057). Already an MCP tool `search_books`.
- `IEmbeddingService` (`Core/IEmbeddingService.cs`) / `OpenAiEmbeddingClient`.

### 0.6 The MCP catalog — a *parallel* tool surface
`McpToolCatalog` (`backend/src/Ai/TextStack.Ai.Mcp/Tools/McpToolCatalog.cs:25`) is a **separate,
HTTP-bridge** tool list (7 tools: `search_books`, `get_book`, `get_chapter`, `list_my_highlights`,
`list_my_vocabulary`, `ask_book`, `save_highlight`). It is NOT the `ITool` registry — it's a
thin MCP↔public-HTTP bridge with its own descriptors. Important distinction for this doc: **the
agents use the in-process `ITool` registry (DB/RAG direct), not the MCP bridge.** The MCP surface
is for external clients (Claude Desktop). We note where a capability already exists on both.

### 0.7 Existing crews (multi-agent precedent)
`AutoPublishCrew` / `SeoCrew` (`Application/Agents/`) already chain Researcher → Drafter →
Editor → Critic agents with `CrewOrchestrator` + run-record persistence. Precedent that
multi-step, multi-role agent composition is already a shipped pattern here.

### 0.8 External API egress today
Outbound HTTP is `IHttpClientFactory` (`LookupDictionaryTool`) or an injected `HttpClient`
(`StandardEbooksSyncService.cs:72`, the closest precedent for hitting an external book catalog).
No web-search tool exists yet. **Open Library / Google Books would be new `ITool`s following the
`LookupDictionaryTool` shape**, with a `TextStack.Ai.*` typed client behind them.

---

## 1. Shared agent-runtime view — reuse, don't rebuild

**Recommendation: do NOT create a new agent framework. Reuse `AgentLoop` + the `ITool` registry +
`ModelGateway` as-is.** All three agents are `IAgent<TInput, TOutput>` (`Core/IAgent.cs`) concrete
classes in `Application/Agents/` that own only (a) a system prompt, (b) an allowed-tool list, and
(c) an `AgentLoopOptions` budget — exactly like `StudyBuddyAgent` (`Application/Agents/StudyBuddyAgent.cs:17`).

What each new agent contributes:
| Piece | Reuse | Build |
|---|---|---|
| Plan/act/observe loop | `AgentLoop` | — |
| Tool definition + dispatch + schema validation | `ITool` / `ToolRegistry` / `ToolDispatcher` | the *new tools* (Open Library, Google Books, tutor exercise-gen, ingest-trigger) |
| Model call + routing + budget + shadow | `ModelGateway` via `FeatureTag` | one new route key per agent in `Ai:Routes` |
| Per-step tracing | `TracingDecorator` → `llm_traces` | — |
| Run persistence + replay | `agent_run` + `AgentRunRecordFactory` + `DbAgentRunWriter` | maybe new columns (see Agent 1) |
| Streaming to UI | `AgentLoop.StreamAsync` → SSE (`StudyBuddyEndpoints` pattern) | endpoint per agent |
| Eval | `TextStack.Ai.EvalSuite` runners + goldens | a golden set per agent |

**One genuinely shared new piece** worth adding: a small **`ExternalCatalogClient`** (typed
HttpClient + response models for Open Library + Google Books, with caching + a circuit breaker)
in a new file under `Application/Ai/External/` (or a thin `TextStack.Ai.External` lib if we want
it framework-free and reusable by Worker). **Agent 1 and Agent 3 both need it** — building it once
and exposing it through two thin `ITool`s avoids duplicating quota/retry/parse logic. Recommend:
start it as `Application/Ai/External/ExternalCatalogClient.cs` (DI-registered typed client, like
`StandardEbooksSyncService`'s HttpClient), promote to its own lib only if a third consumer appears
(YAGNI).

**Where the agents live:** `Application/Agents/` (logic) + `Application/Tools/` (new tools) +
`Api/Endpoints/` (HTTP/SSE) for Agent 2/3; **Worker** for Agent 1 (fire-and-forget at ingestion).
No new top-level project. This keeps Clean Architecture: tools/agents depend on Application
interfaces (`IAppDbContext`, `IRagService`, `IHttpClientFactory`); EF/HTTP impls stay in
Infrastructure/Application.

---

## 2. Agent 1 — Enrichment Agent at book upload  ★ MVP / showcase

### 2.1 Goal & user value
When a book is uploaded (admin catalog or **user upload — the priority per MEMORY**), produce
**accurate, sourced** metadata: genre, published year, description, author canonicalization. Good
metadata → better domain-aware translation prompts, better library cards, better discovery →
the reader finds and trusts the right book faster. Today this is a **single Ollama call**
(`BookMetadataGenerator.GenerateAsync`, `Worker/Services/BookMetadataGenerator.cs:15`) that
hallucinates genre/year/description from *just title+author* with **no external verification** and
**no confidence** — its only validation is a genre whitelist and a year range (`BookMetadataGenerator.cs:36`).

### 2.2 Why it's genuinely agentic (not a prompt)
A one-shot LLM guesses. The agent **decides**: is the model confident? If yes → done in one step
(cheap, like StudyBuddy's no-tool path). If the title is ambiguous, the year is uncertain, or two
sources disagree, it **acts**: call Open Library, call Google Books, **cross-check**, reconcile the
conflict (e.g. Google says 1937, Open Library says 1951 → prefer earliest *first-published* edition
with a source), retry a narrower lookup, and either commit with **provenance + confidence** or emit
a calibrated `unknown`. The branching, the conflict resolution, the retry, and the
"give-up-honestly" path are the agency.

### 2.3 Architecture
- **Class:** `EnrichmentAgent : IAgent<EnrichmentInput, EnrichmentResult>` in
  `Application/Agents/EnrichmentAgent.cs`, thin over `AgentLoop` (copy `StudyBuddyAgent` shape).
- **FeatureTag:** `bookmeta.agent` (new route key; keep legacy `bookmeta` for the fallback path).
- **Model choice:** **gpt-4.1-mini** for the reasoning/reconciliation loop (it must weigh
  conflicting evidence — nano is too weak for that), with budget fallback to nano configured in
  `Ai:Budgets`. The final description copy can stay nano. Rationale: enrichment runs once per book,
  off the hot path, so a few cents is fine; correctness >> cost here.
- **Budget:** `AgentLoopOptions(MaxSteps: 5, MaxTokensPerStep: 800, CostCapUsd: 0.03)`. 5 steps is
  enough for: reason → OpenLibrary → GoogleBooks → reconcile → commit.
- **Where it hooks in:** replace `IBookMetadataGenerator`'s single call. The Worker trigger points
  stay identical — ~~`MetadataBackfillWorker` (`Worker/Services/MetadataBackfillWorker.cs:86`) and
  the post-ingestion fire-and-forget~~ (both deleted: the kick 2026-10-07, the backfill worker
  2026-10-08, ADR-022/023; `MetadataEnrichmentWorker` is the one consumer). Keep it **fire-and-forget, idempotent, NULL-fields-only**
  (the existing worker already does this, `MetadataBackfillWorker.cs:90`). Implement
  `IBookMetadataGenerator` with an `EnrichmentAgentMetadataGenerator` that runs the agent and maps
  `EnrichmentResult → BookMetadataResult` — **zero churn to callers**. Keep the old Ollama
  generator as the registered fallback when the agent errors or budget-stops.

### 2.4 Tool catalog (new `ITool`s)
All follow the `LookupDictionaryTool` external-HTTP shape; "not found" is data.

| Tool | Args (JSON Schema) | Returns | Source |
|---|---|---|---|
| `search_open_library` | `{ title:string, author?:string }` | `[{ title, authors[], firstPublishYear, subjects[], olWorkKey }]` | openlibrary.org `/search.json` (no key, polite rate limit) |
| `get_open_library_work` | `{ olWorkKey:string }` | `{ title, description, subjects[], firstPublishDate }` | OL works API |
| `search_google_books` | `{ title:string, author?:string }` | `[{ title, authors[], publishedDate, categories[], description }]` | Google Books `volumes` (API key, quota — see risks) |
| `normalize_year` | `{ candidates:[{year:int, source:string}] }` | `{ year:int?, confidence:number, rationale:string }` | **local pure tool** — deterministic reconciliation rule (prefer earliest plausible first-publication; pure & unit-tested) |

`normalize_year` being a *local deterministic tool* rather than asking the LLM to do arithmetic is
a deliberate reliability choice (same spirit as `DistractorGenerator`'s fallback cascade). It also
makes conflict-resolution **auditable** in the step transcript.

### 2.5 Control loop + stopping rules
1. **Reason**: model receives `title`, `author?`, and which fields are missing. System prompt
   instructs: *if you already know this work with high confidence (canonical classic), answer in
   one step with `confidence` per field; only call tools when uncertain or fields conflict.*
   (This is StudyBuddy's "don't over-call" gate, `StudyBuddyAgent.cs:71`, applied to metadata.)
2. **Act**: on low confidence → `search_open_library` and/or `search_google_books`.
3. **Observe / reconcile**: if sources agree → commit. If they disagree on year → call
   `normalize_year`. If genre maps ambiguously → pick the whitelist genre with the best subject
   overlap, lower confidence.
4. **Stop** when: confidence ≥ threshold (e.g. 0.7) on all needed fields, OR `MaxSteps`, OR cost
   cap. On budget exhaustion → commit whatever has confidence ≥ threshold, mark the rest `unknown`.
5. **Output** `EnrichmentResult { Genre?, Year?, Description?, perFieldConfidence, sources[] }`.

### 2.6 Data the agent reads / writes (data-model change)
Reads: `UserBook.Title/Author/Genre/Description/PublishedYear` (or `Edition.*` for catalog).
Writes: same NULL fields only, **plus provenance**. New nullable columns (one migration):
- on `user_books` (and/or `editions`): `metadata_source` (`text` — `manual|llm|agent`),
  `metadata_confidence` (`real`), `metadata_provenance` (`jsonb` — `{field: {value, source, confidence}}`).
- Mirrors the **SEO backfill** precedent exactly (`SeoSource: manual|auto|hybrid` protects manual
  rows from overwrite). Reuse that mental model: never overwrite a `manual` field.

The agent run itself is persisted to `agent_run` (agent=`enrichment`) — full reconciliation
transcript replayable in admin.

### 2.7 Human-in-the-loop
**None at runtime** (it's fire-and-forget at ingestion). HITL is *post-hoc*: admin sees low-confidence
enrichments in a review queue (extend the admin Jobs/Editions UI) and can accept/override — flipping
`metadata_source` to `manual`. This matches Auto-Publish's "require review" trust model.

### 2.8 Failure modes + guardrails
- **Hallucinated year/genre** → mitigated by external cross-check + `normalize_year` + confidence
  threshold + calibrated `unknown`. Genre still constrained to the existing whitelist
  (`BookMetadataGenerator.cs:29`).
- **Prompt injection from external data** (a malicious OL "description" telling the model to do X)
  → tool results are returned as structured fields, not free instructions; reuse the
  `SeoPromptSanitizer` idea (strip `{{`, `assistant:`, `</prompt>`, `<|…|>`) on external text
  before it enters the prompt. Treat external text as untrusted data, never as instructions.
- **Infinite loop / cost** → `MaxSteps=5` + `CostCapUsd=0.03` (hard caps in `AgentLoop`).
- **External API down / quota** → tool returns `{found:false}`; agent degrades to LLM-only with
  lowered confidence; circuit-breaker in the typed client. Never blocks ingestion (fire-and-forget).
- **Google Books quota / key** → key in config (`GoogleBooks:ApiKey`), per-day quota; tool
  short-circuits to `unknown` when 429. Open Library has no key but needs a polite User-Agent +
  rate limit.

### 2.9 Observability + eval
- Per-step `llm_traces` (free) + `agent_run` row with provenance in output.
- **Eval (concrete):** a golden set of **known books with ground-truth metadata** — extend the
  existing `BookMetaGolden` (`EvalSuite/BookMetaGolden.cs:6`: `Title, Author, ExpectedGenre,
  ExpectedYear, ExpectedDescription`) into `EnrichmentGolden` adding `ExpectedConfidenceBand`.
  New `EnrichmentEvalRunner` (copy the existing BookMeta runner) reports:
  - **Year accuracy** (exact / ±1yr), **Genre accuracy** (whitelist match),
  - **Calibration**: of items the agent marked high-confidence, what % were correct
    (we *want* it to say `unknown` on genuinely unknown books, not guess) — this is the headline
    portfolio metric: *honest calibration, not just raw accuracy*,
  - **Cost/latency per book** vs the old single-Ollama-call baseline.
  - ~50 goldens: 25 canonical classics (agent should one-shot), 15 ambiguous/obscure (agent should
    use tools), 10 genuinely-unknown (agent should say `unknown`).

### 2.10 Sliced PR plan
1. **PR1** — `ExternalCatalogClient` typed client + `search_open_library` / `get_open_library_work`
   tools + unit tests (mocked HTTP). No agent yet.
2. **PR2** — `search_google_books` tool + `normalize_year` pure tool + tests.
3. **PR3** — `EnrichmentAgent` + `EnrichmentAgentMetadataGenerator : IBookMetadataGenerator`;
   wire as primary with Ollama fallback; migration for provenance columns.
4. **PR4** — `EnrichmentGolden` dataset + `EnrichmentEvalRunner` + calibration metric; admin
   low-confidence review surfacing.

(Bundle into one PR branch per MEMORY "bundle PR slices"; update CHANGELOG.)

### 2.11 Open questions
- Catalog `Edition` vs `UserBook` first? (MEMORY says user-books-first → start there.)
- Google Books key/quota acceptable, or Open-Library-only MVP?
- Confidence threshold 0.7 — tune on the golden set?

---

## 3. Agent 2 — Learning Tutor Agent

### 3.1 Goal & user value
Reason over the learner's **SRS state + reading history + weak vocabulary** and plan *what to
surface next to deepen reading-driven fluency* — the right due cards, an exercise at the right
difficulty, an **example sentence pulled from a book they've actually read** (RAG) so practice
stays anchored to real reading. Thesis guardrail: **this enhances reading; it is not a drill app.**
The tutor's job is to keep the learner reading and to reinforce words *from their books*, not to
generate endless decontextualized quizzes.

### 3.2 Why it's genuinely agentic
Multi-step, **stateful**, **human-in-the-loop**: the agent plans a short session, presents one
item, the learner answers, and the agent **re-plans** based on the answer (got it wrong fast →
drop difficulty, surface the source sentence; got it right → advance stage / move on). It reads
heterogeneous state and chooses among exercise types and difficulties. That feedback-driven
re-planning across turns is the agency — a single prompt can't react to the learner's answer.

### 3.3 Architecture
- **Class:** `TutorAgent : IAgent<TutorInput, TutorPlan>` in `Application/Agents/TutorAgent.cs`.
- **FeatureTag:** `tutor`. **Model:** gpt-4.1-mini (planning over mixed signals); exercise *content*
  generation can route to nano / reuse the existing Ollama `DistractorGenerator`.
- **Budget per turn:** `AgentLoopOptions(MaxSteps: 4, CostCapUsd: 0.02)`. Each learner answer = a
  new bounded agent turn, not one long-lived loop (keeps cost predictable + lets us persist
  between turns).
- **State / persistence (data-model):** a `tutor_session` entity (jsonb plan + cursor + history)
  so the multi-turn session survives across HTTP requests. New migration. The per-turn agent run
  still lands in `agent_run` (agent=`tutor`) for replay.
- **Integration:** new SSE endpoint `POST /me/tutor/session` + `POST /me/tutor/answer`
  (copy `StudyBuddyEndpoints` streaming + run-persistence shape). Frontend: a *reading-adjacent*
  surface (Practice/Vocabulary pages, `apps/web/src/pages/PracticePage.tsx`), shared with mobile
  via `packages/`. Reuse existing `useVocabularyReview` / `useCardAnswer` hooks for the answer UI.

### 3.4 State the agent reads
- SRS: `VocabularyWord` stages + `nextReviewAt` (due cards), recent `VocabularyReview` accuracy &
  response times (`Application/Vocabulary/SrsEngine.cs`, the 5 stages).
- Reading level: `vocabLevel` (`@textstack/shared` vocabLevel), recent books / `ReadingSession`.
- Weak words: low `consecutiveCorrect`, repeated wrong reviews.

### 3.5 Tool catalog (new + reused)
| Tool | Args | Returns | Reuse |
|---|---|---|---|
| `fetch_due_cards` | `{ limit:int }` | due `VocabularyWord`s + stage | DB (new tool, like `GetUserVocabularyTool`) |
| `get_recent_accuracy` | `{ days:int }` | accuracy / avg response time | DB (`VocabularyReview`) |
| `estimate_difficulty` | `{ word, userVocabLevel }` | difficulty band | **local pure tool** (deterministic, unit-tested) |
| `pull_example_sentence` | `{ word, editionId? }` | a sentence containing the word **from a book the user has read** | **`IRagService` / `ask_book` spoiler-gated** — reuse RAG! This is the thesis anchor |
| `generate_exercise` | `{ word, mode, difficulty }` | MC/cloze item (distractors+hint) | reuse `DistractorGenerator` (Ollama) — don't rebuild |

`pull_example_sentence` reusing the spoiler-gated RAG is what keeps the tutor *reading-anchored*
and inside the thesis: every drilled word comes back to a sentence from the learner's own reading.

### 3.6 Human-in-the-loop turns
1. Agent plans a 5-item micro-session (reason + `fetch_due_cards` + `get_recent_accuracy`).
2. Presents item 1 → **waits for the learner's answer** (HITL boundary; persist `tutor_session`).
3. On answer: a fresh bounded agent turn observes correctness/latency, calls `SrsEngine` to update
   the card, decides next item / difficulty, optionally `pull_example_sentence` on a miss.
4. Repeat until session goal met or learner stops. Always end by nudging back to *reading*
   (e.g. "you're strong on these — keep reading chapter N").

### 3.7 Failure modes + guardrails
- **Drift into drill-app** → hard session cap (≤5–7 items), every miss surfaces a *reading*
  sentence, sessions end with a reading nudge. Product-level guardrail, enforced in the prompt +
  endpoint.
- **Bad exercise (wrong distractors)** → reuse `DistractorGenerator`'s existing fallback cascade.
- **Cost from long sessions** → per-turn budget; session = many cheap bounded turns, not one
  unbounded loop.
- **Spoilers** → `pull_example_sentence` uses the spoiler-gated RAG (read-chapters only).
- **Hallucinated "you struggled with X"** → only state facts from `get_recent_accuracy` tool
  results; prompt forbids inventing history.

### 3.8 Observability + eval (hard — be honest)
Evaluating a tutor is genuinely hard; there's no single ground-truth label.
- Per-turn `agent_run` + `llm_traces`.
- **Eval strategy — simulated learner + rubric:** build a `SimulatedLearnerEvalRunner`
  (new in `EvalSuite`, alongside `StudyBuddyEvalRunner`) where a scripted learner-policy answers
  the tutor (e.g. "knows easy words, fails hard ones, slow on medium"). Metrics:
  - **Adaptivity**: does difficulty track the simulated learner's demonstrated ability
    (correlation between item difficulty and simulated mastery)?
  - **Thesis adherence (LLM-judge rubric)**: % of sessions that surface a book-sourced sentence on
    misses and end with a reading nudge — reuse the `JudgeRunner`/`RubricEvaluator` pattern
    (`EvalSuite/RubricEvaluator.cs`).
  - **SRS correctness**: does the agent call `SrsEngine` transitions consistent with the answers
    (deterministic check, no LLM judge needed)?
  Honest caveat: simulated-learner evals validate *mechanics and policy*, not real pedagogical
  efficacy — that needs longitudinal A/B on real retention, out of scope for the portfolio.

### 3.9 PR plan
1. DB tools (`fetch_due_cards`, `get_recent_accuracy`, `estimate_difficulty`) + tests.
2. `pull_example_sentence` over RAG + `generate_exercise` over `DistractorGenerator`.
3. `TutorAgent` + `tutor_session` entity/migration + SSE endpoints.
4. Frontend session UI (web+mobile via `packages/`).
5. `SimulatedLearnerEvalRunner` + rubric.

### 3.10 Open questions
- Session lives client- or server-side between turns? (recommend server `tutor_session` for replay)
- Reuse `VocabularyReviewPage` UI or a new tutor surface?
- Is a separate tutor even wanted, or fold planning into the existing review queue? (scope risk)

---

## 4. Agent 3 — Librarian Agent (tool-using retrieval)

### 4.1 Goal & user value
Natural-language catalog requests — *"find books like X about Y in Ukrainian under 300 pages"* —
answered by planning over library search, expanding to external sources when the library is thin,
and explaining the reasoning. Lowers the barrier from "browse a grid" to "ask for what you want to
read next" → gets the reader to the right book, faster, which serves the thesis (more reading).

### 4.2 Why it's genuinely agentic
It **parses constraints** (language, length, topic, similarity), **plans** a search, **evaluates
coverage** ("only 1 result, not enough"), and **decides to expand** to external catalogs or to
*trigger ingestion* of a public-domain title — then summarizes with reasoning. The
plan→search→evaluate-coverage→expand→(maybe ingest) loop with a coverage decision is the agency.

### 4.3 Architecture
- **Class:** `LibrarianAgent : IAgent<LibrarianInput, LibrarianAnswer>` in
  `Application/Agents/LibrarianAgent.cs`. **FeatureTag:** `librarian`. **Model:** gpt-4.1-mini.
- **Budget:** `AgentLoopOptions(MaxSteps: 6, CostCapUsd: 0.04)`.
- **Integration:** SSE endpoint `GET /search/ask` (or `/me/librarian`) — copy `StudyBuddyEndpoints`.
  Surfaces on the web search page + mobile. Reuses the same tools the **MCP `search_books`** exposes
  externally, but in-process via the `ITool` registry.

### 4.4 Tool catalog
| Tool | Args | Returns | Reuse |
|---|---|---|---|
| `library_search` | `{ query, lang?, limit }` | FTS hits | Postgres FTS provider (existing) |
| `hybrid_semantic_search` | `{ query, k }` | semantic+FTS RRF hits | AI-057 hybrid + `RrfFusion` (existing) |
| `get_book` | `{ slug }` | metadata (pages/lang/genre) for constraint filtering | existing (mirrors MCP `get_book`) |
| `external_catalog_search` | `{ title?, subject?, lang? }` | OL / Standard Ebooks candidates | **reuse `ExternalCatalogClient` from Agent 1** + `StandardEbooksSyncService` |
| `trigger_ingest` | `{ source, externalId }` | job id (queued) | existing ingestion pipeline (`UserIngestionJob`/admin import) |

Constraint parsing (lang / `< N pages` / topic / "like X") happens in the model's reasoning, then
maps to tool args + a post-filter step; page-count/lang filters are applied as **deterministic
post-filters** on `get_book` results, not trusted to the LLM.

### 4.5 Control loop
plan (parse constraints) → `library_search` / `hybrid_semantic_search` → **evaluate coverage**
(enough results matching constraints?) → if thin → `external_catalog_search` → if a clearly
public-domain match → optionally `trigger_ingest` → summarize top N with one-line *why each fits*.
Stop on enough coverage, `MaxSteps`, or cost cap.

### 4.6 When it may ingest vs only recommend — guardrails (critical)
- **Ingest only** sources known-public-domain: Standard Ebooks + Open Library public-domain
  (verify a public-domain/PD flag), never arbitrary web results. **Copyright guardrail is a hard
  gate**, enforced in the `trigger_ingest` tool (it refuses non-allowlisted sources), not left to
  the LLM's judgment.
- Default behavior is **recommend**, not ingest; ingest is opt-in (admin-triggered, or a clear user
  confirmation = a HITL step before queueing).
- **Prompt injection** from external descriptions → sanitize (as Agent 1).
- **Hallucinated books** → the agent may only recommend titles that came back from a tool result;
  prompt forbids inventing catalog entries; each recommendation carries its source/slug.
- Cost / loops → standard `MaxSteps` + cost cap.

### 4.7 Observability + eval
- `agent_run` (agent=`librarian`) + `llm_traces`.
- **Eval (concrete):** a **query → relevance-set** golden (`LibrarianGolden`: query + constraints +
  expected-relevant slugs). New `LibrarianEvalRunner` reporting **precision@k / recall@k** of the
  returned set against the relevance labels, **constraint-satisfaction rate** (do returned books
  actually match lang/length?), and **coverage-decision accuracy** (did it correctly decide to
  expand externally when the library was thin?). ~30 queries spanning easy in-library, constrained,
  and "needs external expansion" cases.

### 4.8 PR plan
1. `library_search` + `hybrid_semantic_search` + `get_book` tools (wrap existing providers).
2. `external_catalog_search` (reuse `ExternalCatalogClient`) + `trigger_ingest` with the
   copyright allowlist gate + tests.
3. `LibrarianAgent` + SSE endpoint + web/mobile surface.
4. `LibrarianGolden` + `LibrarianEvalRunner` (precision/recall@k).

### 4.9 Open questions
- Auto-ingest ever, or always require confirmation? (recommend: always HITL confirm)
- Is "like X" similarity served by hybrid semantic search alone, or do we need a
  book-embedding similarity index (new)?
- Page-count metadata coverage — do we reliably have it to filter on?

---

## 5. Cross-cutting

### 5.1 Telemetry — `llm_traces` + `agent_run` (mostly free)
All three get per-step `llm_traces` and a persisted `agent_run` transcript out of the box. The
**only schema change** is Agent 1's provenance/confidence columns (and Agent 2's `tutor_session`).
Optional: add `agent_run.confidence` / `agent_run.tool_calls_count` columns if we want to chart
agent reliability in the existing admin AI-quality page (`AdminAiQualityEndpoints`).

### 5.2 Evals — one runner per agent, in `TextStack.Ai.EvalSuite`
Reuse the existing runner/golden/judge scaffolding (`StudyBuddyEvalRunner`, `RubricEvaluator`,
`JudgeRunner`, `GoldenLoader`). Headline metrics: Agent 1 **calibration** (honest-unknown rate),
Agent 2 **adaptivity + thesis-adherence** (simulated learner), Agent 3 **precision/recall@k +
constraint satisfaction**. Wire into the shadow/eval flow already feeding the admin AI-quality UI.

### 5.3 Cost
Per-feature daily budgets via `Ai:Budgets` + `BudgetAwareRoute` (`ModelGateway.cs:121`) — set a
cap per agent FeatureTag with fallback-to-nano. Agent 1 is once-per-book (cheap aggregate);
Agent 2/3 are user-triggered (rate-limit per IP/user like Explain's 20/min). Hard per-run
`CostCapUsd` already enforced by `AgentLoop`.

### 5.4 Risks (honest)
- **External API reliability/quota** (OL/Google Books) is the biggest Agent-1/3 risk — circuit
  breaker + graceful degrade to LLM-only/local-only.
- **Prompt injection from external text** — sanitize all external strings before they enter a
  prompt (reuse `SeoPromptSanitizer`).
- **Copyright** (Agent 3 ingest) — hard allowlist gate, default recommend-only.
- **Tutor efficacy is unmeasurable offline** — simulated-learner evals prove mechanics, not
  learning; say so.
- **Scope creep** — Agent 1 is small and high-leverage; Agent 2 is the largest (new entity, UI,
  multi-turn state, hard eval) — sequence accordingly.

---

## 6. Phased roadmap

| Phase | Agent | Why this order |
|---|---|---|
| **P1 (next)** | **Agent 1 — Enrichment** | Smallest blast radius (drop-in `IBookMetadataGenerator`), clearest before/after vs the current single Ollama call, crispest portfolio metric (calibration), reuses everything (loop, tools, gateway, traces, BookMetaGolden). Best showcase. |
| **P2** | **Agent 3 — Librarian** | Medium; reuses Agent 1's `ExternalCatalogClient` + existing search/RAG/ingest; clean precision/recall eval; user-facing. |
| **P3** | **Agent 2 — Tutor** | Largest: new `tutor_session` entity, multi-turn HITL UI (web+mobile), hardest eval. Do last, when the runtime patterns are proven by P1/P2. |

**Net new code is small:** one `ExternalCatalogClient`, ~10 new `ITool`s, 3 thin agent classes,
3 SSE endpoints, 1 entity (`tutor_session`) + provenance columns, 3 eval runners + golden sets.
Everything else — the ReAct loop, tool dispatch, schema validation, routing, budgets, tracing, run
persistence, RAG, search — is **reused as-is** from `TextStack.Ai.*`.
