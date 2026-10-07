# ADR-023 — Background work runs in the Worker; Api and Worker are single-instance

**Status:** Proposed · **Date:** 2026-10-07 · **Review:** [2026-10 #16](../review-2026-10/00-summary.md),
backend G3, G4 (fire-and-forget row), G9, N5 · **Related:** [ADR-022](ADR-022-one-claim-rule-for-job-queues.md)
(queues), review #29 (pgvector / Drift) · **Implement after:** the Play production launch (~2026-10-16)

## Context

The Api serves requests, and also runs **9 hosted services**: 8 in
`Api/Extensions/ServiceCollectionExtensions.HostedServices.cs:18-37` plus the TTS cache cleanup
(`ServiceCollectionExtensions.Content.cs:75`). It also starts **7 fire-and-forget `Task.Run`s** from
request handlers. The Worker has its own 8 (`Worker/Program.cs:71-103`). Every push to `main` restarts
both.

**Api hosted services**

| Service | Cadence | Work | Problem |
|---|---|---|---|
| `EdgeTtsService` cleanup | once at start | deletes old TTS cache files | none — it is the Api's own disk cache |
| `SsgPeriodicRebuildWorker` | 5 min check | queues a Full SSG job if none completed in N h (default 24) | **a second scheduler for the same job**: `backup.yml:122-126` already queues the nightly Full rebuild |
| `AutoRetireSweeperWorker` | 6 h | retires mastered words | timer starts at boot |
| `DailyCapReconcilerWorker` | 1 h | promotes pending words into SRS | **promoted words never get distractors, hint, explanation or embedding** — only the endpoint path queues them (see below) |
| `WordFrequencyLoaderWorker` | once | seeds 20k `word_frequencies` rows from an embedded file (Infrastructure assembly) | none, idempotent |
| `ClusterCandidateBuilderWorker` | 24 h | Ollama groups recent words | waits 10 min, runs, waits 24 h — so it **runs ~10 min after every deploy**, not daily |
| `ConceptClusteringWorker` | 7 d | full replace of concept clusters | same: **runs after every deploy, not weekly** (`RemoveRange` + add, `ConceptClusteringService.cs:74`) |
| `ContinuousEvalWorker` | 1 h check, **OFF** | scheduled judge evals | already safe: advisory lock + DB last-run (`ContinuousEvalWorker.cs:27,107,135-140,221`) |
| `DriftDetectionWorker` | 1 h check, **OFF** | embedding drift | dead in prod; review #29 says delete |

All the services they call (`RetirementSweeper`, `DailyCapService`, `ClusterCandidateService`,
`ConceptClusteringService`, `SsgRebuildService`) are in **Application** and registered by
`AddApplication()` (`Application/DependencyInjection.cs:50-53,270`), which the Worker already calls
(`Worker/Program.cs:54`). Moving them is registration, not refactoring.

**Fire-and-forget `Task.Run` in the Api**

| Where | Work | Lost on restart? | Note |
|---|---|---|---|
| `VocabularyEndpoints.cs:342-400` (`QueueEnrichment`, called from `:273`, `.Pending.cs:84`, `.Lookups.cs:137`) | OpenAI embedding + Ollama distractors/hint/explanation for a saved word | **yes** | the review's "lost on every deploy"; the review screen silently falls back to random distractors |
| `AdminEndpoints.cs:438,513,579`, `AdminGenresEndpoints.cs:298`, `AdminAuthorsEndpoints.cs:346` | queue an SSG rebuild after a cover upload, an import, a Standard Ebooks sync, a genre or author edit | — | **bug:** the task uses the request's scoped `ISsgJobService` (`DependencyInjection.cs:270`) and its `DbContext` after the request ends; `catch { }` hides the `ObjectDisposedException`. The enqueue is a single insert, so there is nothing to run in the background at all |
| `AdminAiQualityEndpoints.Evals.cs:61` | admin "run evals now", minutes long | yes | admin-started, status in a static flag (`:17`) |
| `Application/Ai/RollingSpendTracker.cs:188` | budget alert email | yes | best-effort alert |
| `Ai.Llm/TracingDecorator.cs:125` | write a sampled `llm_trace` row | yes | best-effort telemetry |
| `Ai.Llm/ModelGateway.cs:295` | shadow model call + its row | yes | best-effort telemetry |

The Worker has two more: the enrichment kick (`UserIngestionService.cs:334`, deleted by ADR-022) and tag
suggestions (`:339`).

**Instances.** `docker-compose.yml` gives `api`, `worker` and `ssg-worker` a fixed `container_name`
(`:82`, `:165`, `:295`), so `--scale` is impossible today, and the host pollers are single systemd units.
Nothing written down says this is a rule, and several things depend on it: per-process rate-limit
partitions, the `IMemoryCache` guest-activity debounce and site cache, the static `_evalRunning` flag,
the periodic jobs above (no lock), and `ssg-worker` swapping one output directory.

## Decision

### 1. Single-instance is the rule

**One Api, one Worker, one ssg-worker, one of each host poller.** This is the honest constraint of one
home server, not a temporary state. Write it in `docker-compose.yml` (a comment next to each
`container_name`) and in `docs/01-architecture/README.md`.

What a second instance would need, so nobody has to rediscover it:

| Second… | Needs |
|---|---|
| Api | no hosted services (this ADR does it); rate limits moved to nginx or a shared store, or accept N× the limit; the eval-run flag in the DB; caches are fine (duplicate writes are harmless) |
| Worker | queue claims are already safe after ADR-022 (SKIP LOCKED); scheduled jobs need `pg_try_advisory_xact_lock(<job>)` around each run (one line; the pattern is in `ContinuousEvalWorker.cs:215-240`) |
| ssg-worker | not possible without separate output directories; do not |

### 2. Background work runs in the Worker

The Api answers requests. Work that is **scheduled**, **slow** or **must not be lost** runs in the Worker.
Two exceptions stay in the Api, by name:

- **Best-effort telemetry and alerts** (`TracingDecorator`, `ModelGateway` shadow, `RollingSpendTracker`):
  they belong to the LLM call that made them, and losing one on a restart costs nothing a user sees.
- **The Api's own startup housekeeping** (`EdgeTtsService` cleanup).

Anything a user would miss if it were lost must be a durable row (ADR-022), not a `Task.Run`.

### 3. Per item

| Item | Decision |
|---|---|
| Admin SSG enqueue ×5 | **`await` it in the handler.** Delete the five `Task.Run`s. Fixes the disposed-context bug |
| `SsgPeriodicRebuildWorker` | **Delete.** `backup.yml` is the one scheduler for the nightly rebuild. Remove the two `ssg.periodicRebuild*` settings and their admin form |
| `DriftDetectionWorker` | **Delete** (with `drift_centroids` and its admin tab, review #29) |
| `MetadataBackfillWorker` (Worker) | **Delete** — a one-shot heal for an old env-var bug (review N5) |
| Vocab enrichment `Task.Run` | **Durable, in the Worker.** Add `vocabulary_words.enrichment_claimed_at` (null = to do) and `native_language` (what the save used; today it is not stored). A Worker loop every 30 s claims words with `enrichment_claimed_at IS NULL` (one `UPDATE … RETURNING`, max 1 attempt — a miss falls back to the random pool, as now) and runs the same code. It also covers words the reconciler promotes. The migration stamps existing rows so old words are not re-enriched. Pause the drain while Ollama is down, like `MetadataEnrichmentWorker.ShouldDrainPending`. The Worker gains a reference to `TextStack.Vocabulary` |
| `AutoRetireSweeperWorker`, `DailyCapReconcilerWorker`, `ClusterCandidateBuilderWorker`, `ConceptClusteringWorker`, `WordFrequencyLoaderWorker` | **Move to the Worker as one `ScheduledJobsWorker`**: a list of (name, interval, delegate); every 5 min it runs each job that is due by `ContinuousEvalWorker.IsDue` against `admin_settings["job:<name>:lastRunAt"]` (`AdminSettingsService.GetAsync/SetAsync`). That fixes the "after every deploy" runs and replaces five ~40–120-line files with one loop. If the owner drops concepts (#29), `ConceptClusteringWorker` is deleted instead |
| `ContinuousEvalWorker` | **Owner decision.** It is OFF and already multi-instance-safe. Keep in the Api as a named exception, or move it into `ScheduledJobsWorker` (the Worker then references `Ai.EvalSuite`), or delete it |
| Admin "run evals now" (`Evals.cs:61`) | **Keep in the Api**, named exception: admin-started, visible, and a lost run is rerun with one click. Revisit with `ContinuousEvalWorker` |
| Tag suggestions (`UserIngestionService.cs:339`) | **Fold into the enrichment run** (`UserBookEnrichmentService`, same claim): one job per book, durable by ADR-022 |
| `EdgeTtsService` cleanup | Keep (exception above) |

After this the Api has **one** hosted service (TTS cleanup) and **zero** `Task.Run` that a user would
miss.

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | The SSG enqueue bug and the un-enriched reconciler words are live; the "after every deploy" runs waste Ollama CPU on every push. |
| **Only document single-instance** (review option A) | not enough | Cheap and part of this ADR, but it leaves the two bugs and the timer resets. |
| **Move all 8 Api services 1:1 into the Worker** (review option B) | rejected as written | Moves the timer-reset bug with them, keeps five copies of the same loop, and moves Drift instead of deleting it. |
| **Advisory lock around every job, keep them in the Api** (review option C) | rejected | Solves a second instance we do not have; the Api still restarts on every push. |
| **A queue table for vocab enrichment** | rejected | A column on the word is the queue; a new table adds joins and cleanup for the same thing. |
| **Hangfire / Quartz for scheduling** | rejected | A new dependency for five timers. |

## Consequences

- Api restarts lose nothing a user would notice. The Api no longer calls Ollama for vocabulary.
- New-word distractors arrive up to ~30 s after a save instead of ~2 s. A word is not reviewed that fast
  in practice; the fallback pool covers it if it is.
- The Worker image gains `TextStack.Vocabulary` (small, no native code).
- Scheduled jobs run on their interval across deploys; the first run after this ships happens at once
  (no stamp yet), then on schedule.
- The admin SSG settings form loses two fields.

## Migration plan (PR-sized, by risk × value)

1. **Bugs and deletions** (S, no migration): `await` the five SSG enqueues; delete
   `SsgPeriodicRebuildWorker` + its settings, `DriftDetectionWorker` + `drift_centroids` (migration) + tab,
   `MetadataBackfillWorker`. Write the single-instance rule in compose and the architecture README.
2. **Vocab enrichment durable** (M): migration (2 columns, stamp existing rows), Worker loop, delete
   `QueueEnrichment`. Tests: a promoted-by-reconciler word gets enriched; a claimed word is not claimed
   twice; Ollama down → nothing claimed.
3. **`ScheduledJobsWorker`** (M): move the five, delete five files. Tests: due/not-due from the stamp; one
   job's exception does not stop the others.
4. **Tag suggestions into the enrichment run** (S), after ADR-022 PR 2.
5. **`ContinuousEvalWorker`** per the owner's answer.

## Open questions (owner)

1. Accept "one Api, one Worker" as a written rule?
2. Delete the admin SSG periodic-rebuild setting and trust `backup.yml` alone?
3. Concept clusters (#29): keep (then they move) or delete with embeddings?
4. `ContinuousEvalWorker`: keep in Api, move to Worker, or delete?
5. Store the native language on each vocabulary word (needed for a durable enrichment)?
