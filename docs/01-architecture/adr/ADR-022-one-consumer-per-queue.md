# ADR-022 — One consumer per queue; recover at startup, give back on shutdown

**Status:** Accepted · **Date:** 2026-10-07 · **Review:** [2026-10 #15](../review-2026-10/00-summary.md),
backend G4, N2, N3, N10 · **Related:** [ADR-023](ADR-023-single-instance-no-fire-and-forget.md)
(single-instance rule), review #21 (pollers on the owner's Claude login), #25 (two SEO engines) ·
**Implement after:** the Play production launch (~2026-10-16), except the live bug below

## Context

Every queue in TextStack is a Postgres table that one process polls. That design stays. The problem is
that each queue claims, recovers and gives up in its own way. Evidence is against `main` @ `d18f2244`.

Since the review: the catalog retry cap is fixed (#706/#707), the podcast queue is deleted (#692), and a
hung SSG render now ends `Failed` (#757).

| # | Queue (table) | Consumer | Claim | Stale recovery | Attempts cap | Claim test |
|---|---|---|---|---|---|---|
| 1 | `ingestion_jobs` | Worker `IngestionWorker`, 5 s (`Worker/Services/IngestionWorker.cs:37`) | read, then save: pick `Application/Ingestion/IngestionService.cs:68-73`, mark `:87-92` | `Processing` older than 10 min is picked again (`:38`) | 3, then `Failed` (`:39`, `:50-63`) | `IngestionRetryCapTests` (6, fake `DbSet`) |
| 2 | `user_ingestion_jobs` | same loop, after #1 (`IngestionWorker.cs:48`) | read, then save: `Worker/Services/UserIngestionService.cs:82-87`, `:121-126` | `Processing` older than 2 min (`:47`) | 3 (`:49`) | none |
| 3 | `user_books.metadata_enrichment_*` | Worker `MetadataEnrichmentWorker`, 30 s, plus an inline `Task.Run` (`UserIngestionService.cs:334`) | atomic conditional UPDATE Pending→Running (`UserBookEnrichmentService.cs:27-32`) | `Running` older than 10 min → `Pending` (`MetadataEnrichmentWorker.cs:80-89`) | none | gate only (`MetadataWorkerGateTests`) |
| 4 | `ssg_rebuild_jobs` | Node `ssg-worker.mjs`, 5 s | **no claim.** The API sets `Running` at enqueue (`SsgRebuildService.cs:247-248`, `:125-134`); the worker picks `status = 'Running'` (`ssg-worker.mjs:84-95`). "Running" means both "ready" and "in progress" | a restart re-runs the job; `deploy.yml:177` notes "nothing recovers a job left 'Running'" | none | `ssgJob.test.mjs` (limits only) |
| 5 | `auto_publish_jobs` | host `seo-publish-poll.sh`, 60 s | `SELECT … LIMIT 1` (`:299`), later `UPDATE status=1` (`:177`) | **none.** A reboot leaves the row `RUNNING`; `auto_create_job` then skips that edition forever (`:142-143`) | 5 failures / 24 h per edition (`:144-147`) | none |
| 6 | `seo_backfill_jobs` | host `seo-backfill-poll.sh` → `POST /internal/seo/jobs/claim`; **and** the admin crew path (`AdminSeoBackfillEndpoints.cs:513-531`, `MarkRunningAsync`) | `UPDATE … FOR UPDATE SKIP LOCKED RETURNING` (`SeoJobProcessor.cs:49-60`), up to N per call | **none.** If the poller dies, every claimed row stays `Running` | admin retry only | none |
| 7 | `book_quality_jobs` | host `quality-poll.sh` | `SELECT … LIMIT 1` (`:547`), then `PUT status=1` over `/internal` (`:334`) | none | none | none |

Not queues: `pending_vocabulary_words` (a backlog drained by the hourly reconciler, guarded by a unique
index), `eval_runs` (scheduled, OFF), `drift_centroids` (deleted by ADR-023).

### A live bug: every deploy fails the upload in flight

Every push to `main` restarts the Worker. The host cancels `stoppingToken`, the extraction throws
`OperationCanceledException`, and the generic `catch (Exception)` records it as a parse failure:

- uploads: `UserIngestionService.cs:393-405` marks the job and the book `Failed` with *"Could not read this
  file. It may be corrupted or password-protected."* The reader is told their file is broken.
- catalog: `Worker/Services/IngestionService.cs:305-338` marks the job `Failed` (`parse_error`).

The stale re-pick never sees these rows, because they are no longer `Processing`. **This is the first fix.**

### Two consumers are not safe

There is **no fencing** anywhere: a consumer that lost its claim (or thinks it did) keeps writing. That is
acceptable only because each queue has exactly one consumer. These jobs must not run twice at once:

- **book quality rewrite** — rewrites, merges and deletes chapters (`/internal/*/chapters`,
  `InternalEndpoints.cs:36-51`); two runs interleave edits on the same chapters;
- **ingestion** — deletes the old asset files after the save (`UserIngestionService.cs:197`, `:317-321`);
  a second run deletes assets the first one just wrote;
- **enrichment** — a paid OpenAI agent run per book; twice = double spend;
- **auto-publish** — publishes and pings IndexNow; twice = duplicate SSG jobs and IndexNow submissions;
- **SEO apply** — writes the `BeforeSnapshot` for revert; a second run snapshots the first run's output,
  so revert restores AI text instead of the original.

That list is why the rule below is "one consumer", not "any number of consumers with clever claims".

## Decision

### The rule

**Each queue has exactly one sequential consumer** (ADR-023: one Worker, one ssg-worker, one of each
host poller). On top of that:

1. **Startup recovery.** When a consumer starts, nothing of its queue can be in flight, so one `UPDATE`
   ends whatever is: in-flight → `Failed` with `error = 'interrupted (consumer restarted)'`. Ingestion and
   enrichment already recover crashed rows (stale re-pick under a cap) and keep that.
2. **Graceful shutdown gives the claim back.** `catch (OperationCanceledException) when
   (stoppingToken.IsCancellationRequested)` → status `Queued`, **attempt not counted**, no error text.
   A shutdown is never `Failed` and never "corrupted".
3. **`Failed` is terminal.** Only an admin retry brings it back.
4. **One test per consumer** for its startup `UPDATE` and its cancellation path.

No leases, no generic queue helper, no shared claim endpoint: with one consumer, "in flight at my
startup" already means "orphaned".

### Per queue

| Queue | Change |
|---|---|
| `ingestion_jobs`, `user_ingestion_jobs` | Cancellation catch before the generic one → `Queued`, `AttemptCount--` (the claim counted it). The stale re-pick under the cap stays as the crash recovery; no startup `UPDATE` needed. **PR 1, can ship before the launch.** *Shipped 2026-10-07:* the give-back is one set-based `UPDATE` on a fresh context matching the row as this run claimed it (`Processing` at its attempt), so a never-committed claim never un-counts a crash and the half-built book in the change tracker is not flushed; the `UserBook` stays `Processing`. Plus `ThrowIfCancellationRequested` after extraction, because the PDF extractor returns a truncated result on cancel instead of throwing. |
| enrichment | Same cancellation catch (→ `Pending`). The stale reclaim stays. No new column. **Second consumer today** (code review): ingestion's inline kick `_ = Task.Run(() => _enrichmentService.EnrichAsync(bookId, CancellationToken.None))` (`UserIngestionService.cs:334`) runs beside `MetadataEnrichmentWorker`, and with `CancellationToken.None` the cancellation catch can never fire there, so a deploy leaves that row `Running` until the 10-min stale reclaim. Delete the kick: the book is `Pending` and the worker's next tick takes it (≤ its poll interval of extra latency). Then the rule holds and the catch covers every run. *Shipped 2026-10-07 (PR 1), kick deleted.* |
| `ssg_rebuild_jobs` | Enqueue leaves the row `Queued`. `ssg-worker` claims `Queued` itself: `UPDATE … SET status='Running', started_at=now() WHERE id = (SELECT … WHERE status='Queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING …`. At startup it fails `Running` rows. Delete `StartJobAsync`, the admin Start endpoint and its button (create = queued). `deploy.yml:184` and `rebuild-ssg.sh:75` already count `Queued` + `Running` as pending |
| `auto_publish_jobs` | One startup `UPDATE` in `seo-publish-poll.sh`: in-flight (1, 2, 4) → `Failed`. Frees stranded editions for the 5/24 h breaker. Keep `ORDER BY priority DESC, created_at` |
| `seo_backfill_jobs` | Before each claim, `Running` older than 1 h → `Failed`. Not a startup `UPDATE`, because there is a **second consumer**: the crew path. Fix that path to insert its row as `Running` (no `Queued` → `MarkRunningAsync` window the poller can claim) |
| `book_quality_jobs` | Owner decision: **delete** (recommended). If kept: one startup `UPDATE` in `quality-poll.sh` |

### SSG has a second crash loop

`SsgPeriodicRebuildWorker` checks every 5 min and queues a Full rebuild when none **completed** inside the
interval. A Full job that keeps failing is therefore queued again every 5 min, forever. ADR-023 deletes
that worker; `backup.yml` stays the one nightly trigger.

## Alternatives

| Option | Verdict | Why |
|---|---|---|
| **Do nothing** | rejected | Every deploy can tell a reader their book is corrupted; reboots strand host-queue rows. |
| **Multi-consumer-safe claims** (first draft: one SKIP LOCKED helper, leases, a shared `/internal/jobs/{queue}/claim`) | rejected by the consilium | Solves a second consumer we do not run, and without fencing it would still not make the jobs above safe. More code, same safety. |
| **Leases / heartbeats** | rejected | With one consumer, "in flight at startup" is exact; a lease is a guess. |
| **A job library** (Hangfire, Quartz, TickerQ) | rejected | New dependency for the C# half only. |
| **Patch each queue differently** | rejected | That is how we got four styles. |

## Consequences

- A deploy no longer fails uploads. A job interrupted by a deploy simply runs again.
- A crash (not a graceful stop) leaves a job `Failed` at the next start, with a clear error; the admin
  retries. Ingestion keeps retrying under its cap.
- A second consumer stays unsafe, by design. ADR-023 writes that down.

## Migration plan (PR-sized)

1. **Live bug, before the launch if possible:** cancellation catch in both ingestion services and the
   enrichment service. Tests: cancelled job → `Queued`, attempt not counted, `UserBook` not `Failed`.
2. **Host pollers:** startup `UPDATE` in `seo-publish-poll.sh` (and `quality-poll.sh` if kept); 1 h sweep
   in the SEO backfill claim; crew path inserts as `Running`.
3. **SSG:** enqueue leaves `Queued`; `ssg-worker` claims with SKIP LOCKED and fails `Running` at startup;
   delete `StartJobAsync` + endpoint + button.
4. **Docs:** architecture queue section, STATUS.

## Owner decisions (2026-10-07)

All as recommended.

1. **Book quality queue:** delete it (poller, systemd unit, Make targets, entity, the 12 `/internal` routes, admin page, auto-queue).
2. **Admin's separate SSG Start step:** dropped. Creating a job means it is Queued; ssg-worker claims it.
