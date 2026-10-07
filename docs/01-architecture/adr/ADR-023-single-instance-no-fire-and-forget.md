# ADR-023 — Api and Worker are single-instance; no fire-and-forget for real work

**Status:** Proposed · **Date:** 2026-10-07 · **Review:** [2026-10 #16](../review-2026-10/00-summary.md),
backend G3, G4 (fire-and-forget row), G9, N5 · **Related:** [ADR-022](ADR-022-one-consumer-per-queue.md)
(one consumer per queue), review #29 (pgvector / Drift) · **Implement after:** the Play production launch
(~2026-10-16)

## Context

The Api serves requests and also runs **9 hosted services**: 8 in
`Api/Extensions/ServiceCollectionExtensions.HostedServices.cs:18-37` plus `EdgeTtsService`
(`ServiceCollectionExtensions.Content.cs:75`). Request code also starts work it does not wait for. The
Worker has its own 8 (`Worker/Program.cs:71-103`). Every push to `main` restarts both.

**Api hosted services**

| Service | Cadence | Work | Note |
|---|---|---|---|
| `EdgeTtsService` | hourly timer (`EdgeTtsService.cs:26,50`) | sweeps the Api's own TTS disk cache | fine where it is |
| `SsgPeriodicRebuildWorker` | 5 min check | queues a Full SSG job if none **completed** in N h (default 24) | a second scheduler for the nightly rebuild `backup.yml:122-126` already queues, and a crash loop: a Full job that keeps failing is queued again every 5 min |
| `AutoRetireSweeperWorker` | 6 h | retires mastered words | timer restarts with the Api |
| `DailyCapReconcilerWorker` | 1 h | promotes pending words into SRS | **promoted words are never enriched** (below) |
| `WordFrequencyLoaderWorker` | once | seeds 20k `word_frequencies` rows | idempotent |
| `ClusterCandidateBuilderWorker` | 24 h | Ollama groups recent words | waits 10 min, runs, waits 24 h, so it runs ~10 min after every deploy |
| `ConceptClusteringWorker` | 7 d | full replace of concept clusters | same: runs after every deploy, not weekly |
| `ContinuousEvalWorker` | 1 h check, **OFF** | scheduled judge evals | a **session** advisory lock (`pg_try_advisory_lock`, `ContinuousEvalWorker.cs:221,235`) + DB last-run |
| `DriftDetectionWorker` | 1 h check, **OFF** | embedding drift | dead in prod |

**Un-awaited SSG enqueues — 8 sites, one bug**

`EnqueueSsgRebuildAsync` is two small DB writes. Eight request paths start it and do not wait:

- `Task.Run` in 5 endpoints: `AdminEndpoints.cs:438` (cover upload), `:513` (import), `:579` (Standard
  Ebooks sync), `AdminGenresEndpoints.cs:298`, `AdminAuthorsEndpoints.cs:346`;
- `_ = EnqueueSsgSafe(...)` in `AdminService.Editions.cs:268-270` (edition update), `:322` (publish — also
  the auto-publish path through `/internal/editions/{id}/publish`) and `:343` (unpublish).

All of them use the request's scoped `ISsgJobService` (`Application/DependencyInjection.cs:270`) and its
`DbContext` after the request may have ended, and swallow errors in an empty `catch`
(`AdminService.cs:109-125` and each `Task.Run`). So the rebuild after an admin edit or a publish can
silently not happen. Worse, `EnqueueSsgRebuildAsync` saves the job `Queued` and then flips it `Running`
in a second save (`SsgRebuildService.cs:247-248`). If the context dies between the two, the row stays
`Queued` forever, and the duplicate check (`:228-245`) then refuses **every later enqueue of that mode and
those slugs** — for a Full job, `rebuild-all` answers "skipped" every night. Prod check:

```sql
select mode, status, count(*) from ssg_rebuild_jobs where status = 'Queued' group by 1, 2;
```

**Vocabulary enrichment**

`QueueEnrichment` (`VocabularyEndpoints.cs:342-400`) is a `Task.Run` that embeds the word and asks Ollama
for distractors, hint and explanation. It is called from three endpoint paths (`:273`, `.Pending.cs:84`,
`.Lookups.cs:137`), but **not** from `DailyCapService.ReconcileUserAsync` (`:129-148`), so words promoted
by the hourly reconciler never get any of it. A deploy during the call also loses it. The review falls
back to random distractors either way.

**Other fire-and-forget:** admin "run evals now" (`AdminAiQualityEndpoints.Evals.cs:61`), the budget alert
email (`RollingSpendTracker.cs:188`), trace rows (`TracingDecorator.cs:125`), shadow calls
(`ModelGateway.cs:295`), tag suggestions in the Worker (`UserIngestionService.cs:339`).

**Instances.** `docker-compose.yml` gives `api`, `worker` and `ssg-worker` a fixed `container_name`
(`:82`, `:165`, `:295`), so `--scale` cannot run, and each host poller is one systemd unit. Nothing says
this is a rule, yet a lot depends on it: per-process rate limits, the `IMemoryCache` guest debounce and
site cache, the static `_evalRunning` flag, timers without locks, and every queue in ADR-022.

**Small doc drift:** `Worker/Program.cs:84` says guest cleanup runs "every 6h"; the code runs every 2 h
(`GuestCleanupWorker.cs:15`), as CLAUDE.md says. The comment is wrong.

## Decision

### 1. Single-instance is the rule

**One Api, one Worker, one ssg-worker, one of each host poller.** It is the real constraint of one home
server. Write it in `docker-compose.yml` (a comment by each `container_name`) and in
`docs/01-architecture/README.md`, with what a second instance would need:

| Second… | Needs |
|---|---|
| Api | rate limits in nginx or a shared store (or accept N× limits); the eval flag in the DB; timers moved out or locked |
| Worker | ADR-022 says no: queues have no fencing. It would need fenced claims first |
| ssg-worker | separate output directories; do not |

### 2. Real work is awaited or durable, never fire-and-forget

Work a user would miss if it were lost is either awaited in the request or a durable row. Fire-and-forget
is allowed only for best-effort telemetry and alerts (traces, shadow calls, budget email) and for
admin-started runs the admin can see and repeat (run evals now).

### 3. Per item

| Item | Decision |
|---|---|
| SSG enqueue, 8 sites | **Await it.** Keep a `try/catch` that **logs** the error (never empty), so a committed publish or edit never turns into a 500 |
| `SsgPeriodicRebuildWorker` | **Delete**, with the two `ssg.periodicRebuild*` settings and their admin form. `backup.yml` is the one nightly trigger |
| `DriftDetectionWorker` | **Delete**, with `drift_centroids` (migration) and its admin tab (review #29) |
| `MetadataBackfillWorker` (Worker) | **Delete** — a one-shot heal for an old env-var bug that still calls Ollama on every Worker start |
| Reconciler gap | **Owner decision.** Smallest fix: `ReconcileUserAsync` calls the same enrichment enqueue as the endpoints (needs a native language, read from the profile). Durable enrichment in the Worker (a column + a loop) is **deferred** |
| The 5 timers (`AutoRetire`, `DailyCap`, `ClusterCandidate`, `ConceptClustering`, `WordFrequency`) | **Stay in the Api, unchanged.** The reset after each deploy is accepted: it costs local CPU (Ollama), not money or data |
| `ContinuousEvalWorker` | Stays as is |
| `EdgeTtsService` cache sweep | Stays |
| Guest cleanup comment | Fix `Worker/Program.cs:84` to "every 2h" |

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | The SSG enqueue bug can block rebuilds for good; the reconciler gap is live. |
| **Only document single-instance** (review option A) | not enough | Leaves both bugs. |
| **Move all timers into one `ScheduledJobsWorker`** (first draft) | dropped by the consilium | Real code for a cosmetic gain: the reset costs local CPU only. |
| **Durable vocab enrichment now** (first draft: two columns + a Worker loop) | deferred | A migration and a new loop for a feature whose value is unproven (review #29); the one-line reconciler call closes the gap. |
| **Advisory locks around every job** (review option C) | rejected | For a second instance we will not run. |

## Consequences

- An admin edit or publish either queues its rebuild or logs why not; the stuck-`Queued` trap is gone
  (ADR-022 also moves the claim into `ssg-worker`, so enqueue becomes one write).
- Three dead workers and one admin form fewer.
- Timers still restart with the Api. Accepted and written down.

## Migration plan (PR-sized)

1. **SSG enqueue:** await the 8 sites with logging; run the prod SQL above and clear any stuck `Queued` row.
2. **Deletions:** `SsgPeriodicRebuildWorker` + settings + form, `DriftDetectionWorker` + table + tab,
   `MetadataBackfillWorker`; fix the guest comment; write the single-instance rule in compose and the
   architecture README.
3. **Reconciler enrichment** if the owner says yes.

## Open questions (owner)

1. Accept "one Api, one Worker" as a written rule?
2. Delete the admin SSG periodic-rebuild settings and trust `backup.yml` alone?
3. Reconciler-promoted words: add the one enrichment call, or leave them on the fallback pool?
