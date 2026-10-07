# ADR-022 — One claim rule for the polled job queues

**Status:** Proposed · **Date:** 2026-10-07 · **Review:** [2026-10 #15](../review-2026-10/00-summary.md),
backend G4, N2, N3, N10 · **Related:** [ADR-023](ADR-023-background-work-runs-in-the-worker.md) (where
consumers run, single-instance rule), review #21 (pollers on the owner's Claude login), #25 (two SEO
engines) · **Implement after:** the Play production launch (~2026-10-16)

## Context

Every queue in TextStack is a Postgres table that something polls. That is the right design for this
size and stays. The problem is that each queue was written on its own day, so each one claims,
recovers and gives up differently. Evidence is against `main` @ `d18f2244`.

Since the review: the catalog retry cap is fixed (#706/#707), the podcast queue is deleted (#692), and
a hung SSG render now ends `Failed` (#757). What is left:

| # | Queue (table) | Consumer | Claim | Stale recovery | Attempts cap | Claim test |
|---|---|---|---|---|---|---|
| 1 | `ingestion_jobs` | Worker `IngestionWorker`, 5 s (`Worker/Services/IngestionWorker.cs:37`) | read, then save: pick `Application/Ingestion/IngestionService.cs:68-73`, mark `:87-92` | `Processing` older than 10 min is picked again (`:38`) | 3, then `Failed` (`:39`, `:50-63`) | `IngestionRetryCapTests` (6, fake `DbSet`) |
| 2 | `user_ingestion_jobs` | same loop, after #1 (`IngestionWorker.cs:48`) | read, then save: `Worker/Services/UserIngestionService.cs:82-87`, `:121-126` | `Processing` older than **2 min** (`:47`) — shorter than a large file can take | 3 (`:49`) | none |
| 3 | `user_books.metadata_enrichment_*` | Worker `MetadataEnrichmentWorker`, 30 s, **plus** an inline `Task.Run` (`UserIngestionService.cs:334`) | **atomic conditional UPDATE** Pending→Running (`UserBookEnrichmentService.cs:27-32`) | `Running` older than 10 min → `Pending` (`MetadataEnrichmentWorker.cs:80-89`) | **none** | gate only (`MetadataWorkerGateTests`) |
| 4 | `ssg_rebuild_jobs` | Node `ssg-worker.mjs`, 5 s | **no claim.** The API sets `Running` at enqueue (`SsgRebuildService.cs:247-248`, `:125-134`); the worker picks `status = 'Running'` (`ssg-worker.mjs:84-95`). "Running" means both "ready" and "in progress" | a restart re-runs the job; `deploy.yml:177` notes "nothing recovers a job left 'Running'" | **none** — a job that kills the process runs again on every restart | `ssgJob.test.mjs` (limits only) |
| 5 | `auto_publish_jobs` | host `seo-publish-poll.sh`, 60 s | `SELECT … LIMIT 1` (`:299`), later `UPDATE status=1` (`:177`) | **none.** A reboot leaves the row `RUNNING`; `auto_create_job` then skips that edition forever (`:142-143`). `finalize_failed_job` (`:92-100`) runs only if the script returns | 5 failures / 24 h per edition (`:144-147`) | none |
| 6 | `seo_backfill_jobs` | host `seo-backfill-poll.sh` → `POST /internal/seo/jobs/claim` | **`UPDATE … FOR UPDATE SKIP LOCKED RETURNING`** (`SeoJobProcessor.cs:49-60`), up to N per call, then run one by one (`seo-backfill-poll.sh:60-70`) | **none.** If the poller dies, every claimed row stays `Running` | admin retry only | none |
| 7 | `book_quality_jobs` | host `quality-poll.sh` | `SELECT … LIMIT 1` (`:547`), then `PUT status=1` over `/internal` (`:334`) | none | none | none |

Not queues, and out of scope: `pending_vocabulary_words` (a backlog the hourly reconciler drains, guarded
by a unique index), `eval_runs` (scheduled, OFF, advisory lock), `drift_centroids` (OFF; delete per
review #29). Fire-and-forget `Task.Run` work is [ADR-023](ADR-023-background-work-runs-in-the-worker.md).

So: **7 claimed queues, 4 claim styles** (read-then-save ×4, conditional UPDATE, SKIP LOCKED, none),
**3 with no stale recovery, 4 with no cap, 1 with tests.** The visible failures are:

- a host reboot strands auto-publish, SEO backfill and quality rows in `Running` for good;
- an SSG job that crashes `ssg-worker` (OOM) is re-run on every restart, with no end;
- user ingestion's 2-min window is shorter than a big upload, so a second worker would parse the same
  file twice;
- none of it is tested, so each fix is a guess.

Today each queue has one consumer, so the read-then-save claims are not racy. That is luck, not design.

## Decision

### The rule

Every queued job row has a **status**, a **`started_at`** (the lease start), an **attempt count**, and
two terminal states, **done** and **`Failed`**. Each queue declares two numbers: a **lease** (longer than
the slowest honest run) and a **max attempts**. Then:

1. **Claim is one atomic statement.** It flips Queued → Running, sets `started_at = now()`, adds one
   attempt, and returns the id. Nothing reads a row and saves it back.
2. **Sweep before claim.** A row in-flight past its lease goes back to Queued if it has attempts left,
   else to `Failed` with the error `lease expired after N attempts`. A Queued row already at the cap goes
   to `Failed` (the #707 rule, kept).
3. **`Failed` is terminal.** Only an admin retry (which resets attempts) brings it back.
4. **One test per queue** pins all of the above.

### The SQL (the only claim pattern)

It is the statement `SeoJobProcessor` already uses, plus the attempt count:

```sql
-- sweep
UPDATE <t> SET status      = CASE WHEN attempts >= @max THEN @failed ELSE @queued END,
               error       = CASE WHEN attempts >= @max THEN 'lease expired after ' || attempts || ' attempts' ELSE error END,
               finished_at = CASE WHEN attempts >= @max THEN now() ELSE finished_at END
WHERE status = ANY(@inFlight) AND started_at < now() - @lease;

-- claim (one row, one statement, safe with two consumers)
UPDATE <t> SET status = @running, started_at = now(), attempts = attempts + 1
WHERE id = (SELECT id FROM <t> WHERE status = @queued
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id;
```

`@inFlight` lists every working status of the queue (auto-publish has `Running`, `GeneratingSeo`,
`Publishing`; quality has `Validating`, `Fixing`). Parked states (`AwaitingReview`, `NeedsReview`) are not
in-flight and never expire. A queue **without** an attempts column has max attempts = 1: its sweep sends
an expired row straight to `Failed`.

### One implementation

- **`Application/Common/JobQueue.cs`**: `SweepAndClaimAsync(QueueSpec spec)` runs the two statements.
  `QueueSpec` is a record of compile-time constants (table, column names, status values, lease, max
  attempts). Identifiers come only from the seven specs in that file, never from input, so the raw SQL
  takes no user text. About 60 lines.
- **`POST /internal/jobs/{queue}/claim`** returns the claimed id or 204. `{queue}` is looked up in the same
  closed set. It replaces `/internal/seo/jobs/claim`, and the three host pollers and `ssg-worker` call it
  instead of running their own `SELECT … LIMIT 1`. All claim SQL then lives in tested C#; the bash and
  Node consumers just do the work and report the result as they do today.
- The Worker calls `JobQueue` directly for queues 1–3.

### Per queue

| Queue | Lease | Max attempts | Schema change | Notes |
|---|---|---|---|---|
| `ingestion_jobs` | 10 min | 3 | none (`attempt_count`) | replaces `GetNextJobAsync`'s two queries and `MarkJobProcessingAsync` |
| `user_ingestion_jobs` | 10 min (was 2) | 3 | none | one number with catalog; after the sweep, one follow-up `UPDATE` marks the `UserBook` of a newly `Failed` job `Failed`, as now (`UserIngestionService.cs:64-78`) |
| `user_books` enrichment | 10 min | 3 | **add `metadata_enrichment_attempts int not null default 0`** | the only migration; delete the inline `Task.Run` kick (`UserIngestionService.cs:334`), the 30 s sweep is the one path |
| `ssg_rebuild_jobs` | 2 h | 1 | none | enqueue leaves the row `Queued`; the worker claims it. Above the worker's own cap (max(60 min, 2 s × routes), #757). Admin's separate **Start** step goes: create = queued |
| `auto_publish_jobs` | 2 h | 1 | none | a stranded `RUNNING` row becomes `Failed`, so the edition is a candidate again under the 5/24 h breaker |
| `seo_backfill_jobs` | 30 min | 1 | none | claim **one** job per call (the poller loops), so the lease covers one job, not N |
| `book_quality_jobs` | 2 h | 1 | none | only if kept — see "Delete or merge" |

`created_at` and `started_at` already exist on all seven. Only the enrichment queue needs a new column.

### Delete or merge before fixing

- **`book_quality_jobs`** — owner decision. It is the riskiest queue: not idempotent (it rewrites,
  merges and deletes chapters through 10 `/internal/*/chapters` routes, `InternalEndpoints.cs:36-51`),
  it sends user-book text to the owner's Claude CLI (review #6, #21), and it can be auto-queued after
  every ingestion (`Worker/Services/IngestionService.cs:450-466`, setting-gated). If it has no real use,
  delete the poller, the entity, the 12 internal routes and the admin page instead of adding a spec.
- **`auto_publish_jobs` vs `seo_backfill_jobs`** — two queues that both write SEO fields through Claude
  CLI. Review #25 picks one engine. Until then, give both the claim endpoint and nothing more.
- **SSG Start step** — merge into create (above). One less status meaning.
- **Enrichment inline kick** — delete (above). One trigger path instead of two.
- **`drift_centroids`** — delete with `DriftDetectionWorker` (review #29; ADR-023).

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | Stranded rows after every reboot and an endless SSG crash loop are live today; the owner sees them only as rows that never finish. |
| **Minimal: patch each queue in place** (review option A: a cap here, a stale `UPDATE` in each bash script) | runner-up | Smallest diff, but it adds a fifth and sixth style, the bash sweeps stay untested, and the next queue copies whichever one is nearest. Choose it only if the owner wants zero C# change. |
| **Per-queue SQL, no shared helper** | rejected | 7 × 2 hand-written statements is exactly how we got 4 styles. |
| **Conditional UPDATE (compare-and-swap) instead of SKIP LOCKED** | rejected as the standard | Same safety, testable on EF, but needs a retry loop when it loses, and that loop would be rewritten in bash and Node. SKIP LOCKED is one statement everywhere and already in the code. `UserBookEnrichmentService`'s CAS for a **known id** (the re-enrich button) stays; it is a different job. |
| **Heartbeat column instead of a fixed lease** | rejected | Every consumer, including bash, would have to update it in its loop. A generous lease plus the SSG worker's own stall check covers the same cases. |
| **A job library** (Hangfire, Quartz, TickerQ) | rejected | A new dependency and dashboard that only covers the C# half; the review already said never. |
| **Move the host pollers into the Worker** | not here | That is review #21 (Anthropic API key instead of the CLI). The claim endpoint makes that move easier later. |

## Consequences

- One claim statement, one sweep statement, one test file. A new queue adds a `QueueSpec` row and a
  test row.
- Every consumer can be restarted at any time: the worst case is one lease of delay, then a retry or a
  visible `Failed`.
- Two consumers of one queue become safe (SKIP LOCKED), but [ADR-023](ADR-023-background-work-runs-in-the-worker.md)
  still says one of each; this ADR does not change that.
- The host pollers and `ssg-worker` depend on the API being up to claim. They already depend on it for
  everything else (`/internal/*`, routes), so no new failure mode.
- SSG: a job that the worker was running during a host crash ends `Failed` after 2 h instead of being
  re-run. The nightly Full rebuild (`backup.yml:122-126`) covers it.
- Lease too short = double work; too long = slow recovery. The leases above are guesses from code and
  should be checked against prod `finished_at - started_at` before PR 2.

## Migration plan (PR-sized)

Each PR: CHANGELOG line, tests first, no behaviour change beyond the row's "Notes".

1. **`JobQueue` + Postgres test harness + queues 1–2.** Replace both ingestion `GetNextJobAsync` paths.
   Move `IngestionRetryCapTests` onto the real statement. The test runs on the migrated Postgres that
   the CI `backend` job already starts (`ci.yml:206-221`); locally it uses the compose `db`.
2. **Enrichment (3).** Migration for the attempts column; spec; delete the inline kick.
3. **Claim endpoint + host pollers (5, 6, and 7 if kept).** `seo-publish-poll.sh`, `seo-backfill-poll.sh`,
   `quality-poll.sh` call `/internal/jobs/{queue}/claim`. Delete `SeoJobProcessor.ClaimNextAsync`. This
   is the PR that fixes the stranded rows; do it first if only one PR fits.
4. **SSG (4).** Enqueue leaves `Queued`; `ssg-worker` claims through the endpoint; delete the admin Start
   endpoint and button. `deploy.yml:184` and `rebuild-ssg.sh:75` already treat `Queued` and `Running` as
   pending, so they need no change.
5. **Docs.** `docs/01-architecture` queue section, STATUS, CLAUDE.md "Book Upload Flow".

Tests (one per queue, as `[Theory]` rows over the specs, each on a real table):
`Claim_TakesOldestQueuedOnce`, `Claim_SecondCallerGetsNothing`,
`Sweep_ExpiredUnderCap_Requeued`, `Sweep_ExpiredAtCap_Failed`, `Sweep_QueuedAtCap_Failed`,
`Sweep_ParkedStatus_Untouched`.

## Open questions (owner)

1. Book quality queue: keep (and fix) or delete? Is anything still using it?
2. OK to drop admin's separate SSG **Start** step?
3. Leases: check prod run times first, or ship these and tune?
4. DB-backed tests inside `TextStack.UnitTests` (skipped without a DB, required in CI), or a new small
   test project?
