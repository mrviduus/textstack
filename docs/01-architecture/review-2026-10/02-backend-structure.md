# 02 — Backend structure and data (review, 2026-10-04)

Read-only review. All evidence is `file:line` against branch `docs/architecture-review-2026-10`.
Context: about 0 real users, one owner, one home server, `docker-compose.yml` pins every service
to one container (`container_name:` on api/worker/ssg-worker, lines 62/137/254). So you cannot run "2 replicas"
without changing compose first, and every "at scale" note below assumes that change.

Severity: **High** = can hurt the owner today (legal, data, money). **Med** = a real bug or a tax that
grows with every feature. **Low** = honesty/hygiene.

---

## G1 — Clean Architecture claims vs reality

**What**
- `Domain.csproj` has one package, `Npgsql`, used only for `NpgsqlTsVector` (`Domain/Entities/Chapter.cs:1,31`).
- `Application.csproj` references EF Core, `Npgsql.EntityFrameworkCore.PostgreSQL`, BCrypt, `Google.Apis.Auth`, JWT,
  and the concrete projects `Ai.Llm` and `Ai.Agents`.
- Provider-specific use in Application is small: `EF.Functions.ILike` ×2 and `PostgresException`/SqlState handling (9 sites).
- The real leak is that **`Application/DependencyInjection.cs:75-266` is the composition root for the AI stack**. It
  builds `OpenAiLlmClient`, `OllamaLlmClient`, `TracingDecorator`, `ModelGateway`, `OpenAiEmbeddingClient` and the Sentry alarms.
- Logic also lives in endpoints: 36 of 60 files in `Api/Endpoints` take `IAppDbContext`. There are 90
  `SaveChangesAsync` calls in `Api/Endpoints/*.cs`, and the endpoints hold 12.8k lines against 15.0k in Application.
- `CLAUDE.md:127` says "Domain: Pure C#, no framework deps". `docs/01-architecture/README.md:67` already admits the Npgsql exception.

**Impact.** Today: none at runtime. The cost is only that the docs mislead agents and readers. At scale: none either. You will
not swap Postgres, and `IAppDbContext` exposing `DbSet<T>` is the normal pragmatic choice.

**Severity: Low**

| Option | Cost |
|---|---|
| A. Change the docs to "pragmatic layering". Say that Application depends on EF Core and Postgres, and that endpoints may hold simple CRUD | 15 min |
| B. A plus move the AI wiring from `Application/DependencyInjection.cs` into an `AddAiStack()` in `Ai.Llm` (or into Api/Worker) | ~1 h |
| C. Full purity: map `SearchVector` as a shadow property, remove EF from Application, push all endpoint logic into services | days, no user value |

**Recommendation: A.** Do B only when you next touch the AI DI anyway. Do not do C.

---

## G3 — BackgroundServices hosted in the Api

**What.** The Api registers 9 hosted services (`Api/Extensions/ServiceCollectionExtensions.HostedServices.cs:18-37`,
plus `ServiceCollectionExtensions.Content.cs:75`):

| Service | Cadence | Work | Lock / guard | 2 replicas | Restart mid-run |
|---|---|---|---|---|---|
| EdgeTtsService (startup cleanup) | once | deletes old cache files on disk | none | harmless | harmless |
| SsgPeriodicRebuildWorker | 5 min check | enqueues a Full SSG job if none finished within N h | check-then-insert dedupe (`SsgRebuildService.cs:228-246`) | a race can create 2 Full jobs, so double render time | anchored in the DB, fine |
| AutoRetireSweeperWorker | 6 h | flips mastered words to retired | none | idempotent UPDATE, fine | fine |
| DailyCapReconcilerWorker | 1 h | pending → SRS promotion | unique index `(user,site,word,lang)` (`AppDbContext.Vocabulary.cs:24`) | one side gets a unique violation, which is logged | fine |
| WordFrequencyLoaderWorker | once | seeds 20k rows | `count >= MinRows` check | both may insert, one fails on the unique index | wipes the partial seed and retries, fine |
| ClusterCandidateBuilderWorker | 24 h | Ollama groups recent words | `AnyAsync` pre-check (`ClusterCandidateService.cs:61`) | duplicate clusters | **timer resets on every restart** |
| ConceptClusteringWorker | 7 d | full replace of concept clusters per user | none (`RemoveRange` then add, `ConceptClusteringService.cs:74`) | duplicate or interleaved clusters | **runs ~10 min after every deploy, not weekly** |
| ContinuousEvalWorker | 1 h check, OFF | judge evals | **`pg_try_advisory_lock`** (`ContinuousEvalWorker.cs:221`), the only one | safe | safe |
| DriftDetectionWorker | 1 h check, OFF | embedding centroids | `alreadyToday` check (`DriftDetectionWorker.cs:129`) | duplicate rows | fine |

The Worker adds 9 more (`Worker/Program.cs:71-108`). None of them uses a lock. They rely on the Worker being a single container.

**Impact.** Today: the only visible effect is the timer reset. Deploys go out on every push to `main`, so
`ConceptClusteringWorker` and `ClusterCandidateBuilderWorker` run about 10 min after each deploy rather than weekly or daily.
Both use local Ollama, so the cost is CPU on the home server, not money. At scale: the first time someone adds a second Api replica,
you get duplicate clusters and duplicate SSG jobs, and you also get per-replica in-memory state: rate-limiter partitions, `IMemoryCache` guest-activity debounce
and the site cache. Nothing documents a "single Api instance" invariant.

**Severity: Low** today, **Med** once you scale.

| Option | Cost |
|---|---|
| A. Write down the invariant "Api and Worker are single-instance" (README + a comment in compose) | 10 min |
| B. Move the 8 Api workers into the Worker host, so the Api only serves requests | 2-3 h (their services must be registered in the Worker DI) |
| C. A small `RunExclusive(key)` advisory-lock helper (copy it from `ContinuousEvalWorker.cs:215-240`) around each job, plus last-run time in `admin_settings` | ~2 h |

**Recommendation: A now.** Do B before any second Api replica. Skip C unless the Worker itself ever scales.

---

## G4 — Every queue is a polled Postgres table

| Queue (table) | Consumer | Claim | Stuck recovery | Retry cap | Idempotent re-run |
|---|---|---|---|---|---|
| `ingestion_jobs` (catalog) | Worker `IngestionWorker`, 5 s poll, sequential | **read then save** (`Application/Ingestion/IngestionService.cs:40-48`, `63-69`), no conditional UPDATE | `Processing` older than 10 min is re-picked | **none.** `AttemptCount++` is never checked, so a job that crashes the process is re-picked every 10 min forever | yes, deletes chapters before re-insert (`:86-90`) |
| `user_ingestion_jobs` | same loop, after catalog jobs | read then save (`Worker/Services/UserIngestionService.cs:49-61`) | `Processing` older than **2 min** | 3 (`:47`) | yes (`:187-191`) |
| `user_books.metadata_enrichment_status` | `MetadataEnrichmentWorker` + inline `Task.Run` (`UserIngestionService.cs:297`) | **atomic conditional `ExecuteUpdate` Pending→Running** (`UserBookEnrichmentService.cs:25-30`) | Running older than 10 min → Pending (`MetadataEnrichmentWorker.cs:81-86`) | none | yes, plus a provider-down gate |
| `podcast_generation_jobs` | Worker `PodcastWorker` | read then save (`PodcastWorker.cs:54-66`) | Running past timeout is re-picked | none | yes, the mp3 is overwritten |
| `ssg_rebuild_jobs` | node `apps/web/scripts/ssg-worker.mjs` | no claim: picks `status='Running'` (`ssg-worker.mjs:56-67`). The API flips Queued→Running at enqueue (`SsgRebuildService.cs:246-248`) | restart re-runs the whole job. **No timeout:** a wedged Running Full job blocks every later Full enqueue through the dedupe (`:231`) | none | yes (file writes) |
| `auto_publish_jobs` | host bash `infra/scripts/seo-publish-poll.sh` + Claude CLI | `SELECT … LIMIT 1` then UPDATE (`:299`, `:177`) | **none.** A host reboot leaves the row RUNNING, and `auto_create_job` then excludes that edition forever (`:142-143`) | 3 failed jobs per edition (`:144-146`) | mostly yes; `finalize_failed_job` backstop (`:92-100`) |
| `seo_backfill_jobs` | host bash `seo-backfill-poll.sh` → `/internal/seo/jobs/claim` | **`UPDATE … FOR UPDATE SKIP LOCKED RETURNING`** (`SeoJobProcessor.cs:49-61`), the only proper claim | **none** for a dead poller | admin retry | yes, Before/After snapshot + revert |
| `book_quality_jobs` | host bash `quality-poll.sh` + Claude CLI | `SELECT … LIMIT 1` (`:545`), status via internal PUT | none | none | **no.** It rewrites, merges or deletes chapters through `/internal/*/chapters` |
| `pending_vocabulary_words` | Api `DailyCapReconcilerWorker` | batch, unique-index protected | n/a | n/a | yes |
| `eval_runs` (scheduled) | Api `ContinuousEvalWorker`, OFF | advisory lock | n/a | n/a | yes |
| `drift_centroids` | Api `DriftDetectionWorker`, OFF | "already today" check | n/a | n/a | yes |
| *(not durable)* `Task.Run` fire-and-forget | `VocabularyEndpoints.cs:294` (distractors + hint + embedding), `AdminEndpoints.cs:438,513,579`, `AdminGenresEndpoints.cs:298`, `AdminAuthorsEndpoints.cs:346`, `AdminAiQualityEndpoints.Evals.cs:61` | none | **lost on restart.** Every push to main restarts the Api | none | n/a |

**Impact.** Today: a single consumer per queue makes the read-then-save claims safe, so the real risks are three:
1. A **poison catalog upload** (OOM, or the known arm64 SIGILL) loops forever and keeps reprocessing every 10 min.
2. **RUNNING rows that never end** in the three host-shell queues after a host reboot.
3. **A word saved during a deploy keeps no distractors or embedding.** The review falls back to a random pool, so it is silent.

At scale: any second Worker breaks the read-then-save claims at once. The 2-min user-ingestion stale window is shorter than a large PDF takes,
so two workers would process the same upload in parallel. No test covers any claim or stale path (grep `GetNextJobAsync|ClaimNext` in `tests/` finds nothing).

**Severity: Med**

| Option | Cost |
|---|---|
| A. Minimal: add `AttemptCount < 3` to the catalog `GetNextJobAsync` (copy the user-ingestion pattern). Add a stale-RUNNING sweep (`UPDATE … SET status=Failed WHERE status=Running AND started_at < now()-interval '2 h'`) to the 3 bash pollers. Add a timeout to the SSG Running pickup | ~2 h |
| B. One shared C# claim helper (`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`) + attempts + stale reclaim for the 4 C# queues, with one unit test each | ~1 day |
| C. Adopt a job library (Hangfire / Quartz / TickerQ) | days, new dependency + dashboard; replaces only the C# half anyway |

**Recommendation: A now. Do B only when a second Worker exists. Never C.** The Postgres-table queue is correct for this size.
Leave the fire-and-forget calls as they are. The one that matters (vocab) has a fallback.

---

## G7 — Multisite leftovers

**What**
- 24 entities implement `ISiteScoped`, and there are 24 `HasQueryFilter(x => x.SiteId == _currentSite.Id)`
  (`Infrastructure/Persistence/AppDbContext.*.cs`). SiteId is written by stamping on `SaveChanges` (`AppDbContext.cs:40-53`).
- `site_id` is in nearly every unique index (e.g. `AppDbContext.Vocabulary.cs:24,90,110`).
- `IgnoreQueryFilters` is never used. Raw SQL (Dapper search, SKIP LOCKED claim, ssg-worker, bash pollers) bypasses the filters, which is harmless while the id is a constant.
- `SiteContextMiddleware` (`Api/Sites/SiteContextMiddleware.cs`) costs one `IMemoryCache` hit per request. On a miss (10-min TTL per host) it runs up to 3 small queries (`SiteResolver.cs:40-93`).
  Since the SSG fix, **an unknown host falls back to the default site** (`SiteResolver.cs:85-99`). The middleware can now only 404 if the `sites` table is empty, so it is effectively a constant.
- `sites` / `site_domains` still feed `/api/site/context` (theme, indexing flags), and 16 call sites read `SiteContext` from `HttpContext.Items`.

**Impact.** Today: a negligible CPU cost, plus about 300 lines of code and a dozen index columns. At scale: the same. The SiteId filter
neither helps nor hurts performance.

**Severity: Low**

| Option | Cost |
|---|---|
| A. Keep everything (ADR-007 already decided "filter, not column removal") | 0 |
| B. Replace middleware + resolver with a singleton `SiteContext` loaded once at startup. Keep the columns, tables and filters | 1-2 h, deletes ~150 lines |
| C. Drop `site_id` from 24 tables and their indexes | days + a risky prod migration, no user value |

**Recommendation: A.** Do B only if you are already in that code. Never C.

---

## G8 — Two parallel book models (Edition/Chapter vs UserBook/UserChapter)

**What.** Storage is split in four places:
- `Chapter` vs `UserChapter`
- `Bookmark` vs `UserBookBookmark`
- progress: the `ReadingProgress` table, keyed by `ChapterId` FK (`ReadingProgress.cs:8-9`), vs denormalized `UserBook.Progress*` columns keyed by **slug** (`UserBook.cs:25-43`)
- library: `UserLibrary` vs ownership

Newer per-book tables took a third route, **nullable `EditionId` + `UserBookId` (XOR)**:
Highlight, BookInsight, VocabularyWord, ReadingSession, WordCluster, WordLookup, PendingVocabularyWord, BookQualityJob (8 entities).
`BookCollection` uses a fourth pattern: `BookId` + string `BookType` ('userbook' | 'savedbook'), **no FK** (`Domain/Entities/BookCollection.cs`).

Duplication caused by the split, at the edges:
- MCP: `search_books`/`search_my_library`, `get_book`/`get_my_book`, `get_chapter`/`get_my_chapter`,
  `save_highlight`/`save_my_highlight`, `list_my_highlights`/`list_my_book_highlights` (`McpToolCatalog.cs:147-990`), i.e. 5 pairs out of 21 tools.
- Internal quality API: 5 × 2 routes (`InternalEndpoints.cs:34-45`).
- Reader API: `/me/progress/{editionId}` + `/me/bookmarks` (`UserDataEndpoints.cs:21-30`) vs `/me/books/{id}/progress|bookmarks` (`UserBooksEndpoints.cs:33-37`).
- 27 `EditionId/UserBookId != null` branches in 7 files.

**A real bug from the missing FK.** Deleting an upload (`UserBookService.cs:411`) or removing a saved book (`UserDataEndpoints.cs:543`)
never deletes its `book_collections` rows. `CollectionService.cs:22-26` counts them, so a collection shows more books than it has.
`AddBookAsync` (`CollectionService.cs:95-111`) also never checks that `bookId` belongs to the caller. This is not a leak, only junk rows.

**A fresh look at "R7 won't-do" (July 2026).** That decision said "the meaningful consolidation already happened" in
`BookChunkingService`/`RagIndexLogic`. **That code was deleted with RAG on 2026-09-10**, so that part of the reasoning is gone.
The other part still holds: storage differs for real reasons (quota, takedown, the uploaded original, PDF original-first, clips).
What changed is *where* the duplication grows. It is no longer storage. It is the **surface**: MCP tools, internal routes, client code.
Because of the user-books-first priority, every new reading feature is built twice or picks one of four patterns.

**Impact.** Today: a velocity tax, plus the collection-count bug. At scale: the same tax grows with every feature. There is no performance problem.

**Severity: Med** (tax), with a Low bug inside it.

| Option | Cost |
|---|---|
| A. Status quo | 0, and the tax keeps growing |
| B. **Converge at the edges, not in storage.** Write an ADR: new per-book tables use the XOR pair + CHECK (BookInsight pattern); new endpoints and MCP tools take a `BookRef(kind, id)`. Merge the MCP pairs one at a time when you touch them anyway. Fix the collection orphans: delete them in the 2 delete paths and verify ownership in `AddBookAsync` | ADR 1 h; orphan fix 30 min; tool merges opportunistic |
| C. Unify storage (one chapters table, catalog = shared book) | weeks. It touches the search_vector trigger, SSG, SEO and both clients. No |

**Recommendation: B.** R7's "no storage abstraction" stands. The missing piece is a single rule for *new* code, and that rule is cheap.

---

## G9 — pgvector

**What.** Two `vector(1536)` columns remain (`AppDbContextModelSnapshot.cs:943,4096`). `Edition.Embedding` was dropped in `DropRagSpine`.
- `vocabulary_words.embedding`: **written on every vocab save**, by a fire-and-forget OpenAI embedding call (`VocabularyEndpoints.cs:306-316`),
  and by a CLI backfill (`Api/Program.cs:576-597`). It is **read** weekly by `ConceptClusteringService` (`:50-60,160-171`), which clusters **in memory**
  (no HNSW index, no SQL vector operator) into `WordCluster Kind=concept`. Those clusters are served by `GET /me/vocabulary/concepts`
  (`VocabularyEndpoints.Clusters.cs:48`) to the web `StatsPage` → `ConceptsSection` (`apps/web/src/pages/StatsPage.tsx:88`). Mobile does not use it.
- `drift_centroids`: written only by `DriftDetectionWorker`, which is **OFF** (`appsettings.json:51-53`, `Drift:Enabled=false`). It is read by the admin AI-quality page.
  This is dead in prod unless someone sets an env override.
- The stale comment at `AppDbContext.Vocabulary.cs:37-38` still points to the removed `Edition.Embedding`.

**Impact.** Today: one OpenAI call per saved word (fractions of a cent), plus a hard dependency on the `pgvector/pgvector:pg16` image and 2 packages,
all for a single web widget whose use is unproven with about 0 users. At scale: embedding cost grows linearly, but it is still cheap. The vector
type adds nothing here, because nothing queries by similarity in SQL.

**Severity: Low**

| Option | Cost |
|---|---|
| A. Keep | 0 |
| B. Change both columns to `real[]` and remove the Pgvector packages (keep the image until the migration has run) | ~1-2 h |
| C. Delete Drift (worker, entity, admin tab) now. Ask the owner whether the concept widget earns its keep; if not, delete embeddings + concept clustering + widget | Drift ~1 h; concepts ~2 h; ~1,000 lines |

**Recommendation: C for Drift** (it is off, portfolio-only). **Owner decision for concepts.** If they stay, A is fine. B only saves a dependency.

---

## New gaps

### N1 — Copyrighted books committed to a PUBLIC repo — **High**
`tests/TextStack.Extraction.Tests/Fixtures/Inspired - Marty Cagan.pdf` (9.9 MB, a commercial book) and
`KMK Optometry OSCE E-Workbook.pdf` (21 MB) are tracked in git, and `gh repo view` reports the repo as **PUBLIC**.
This creates DMCA / takedown risk to the repo and account, and adds 31 MB to every clone.
Options:
- A. `git rm` + a synthetic fixture: 30 min. The files stay in history.
- B. A plus a history rewrite (`git filter-repo`) + force-push: 1 h, breaks forks and clones, needs the owner.
- C. Make the repo private: 1 min, but this conflicts with the public portfolio plan.

**Recommendation: A now, then B as an owner decision.**

### N2 — Catalog ingestion has no retry cap (poison loop) — **Med**
See G4: `Application/Ingestion/IngestionService.cs:40-48` never checks `AttemptCount`. Fix: 10 lines, copied from `UserIngestionService.cs:56`.

### N3 — Host-shell queues never recover RUNNING rows — **Med**
See G4: `seo-publish-poll.sh`, `seo-backfill-poll.sh`, `quality-poll.sh`. One stale sweep per poller, ~1 h total.

### N4 — Two SEO-generation engines — **Low/Med**
Prod runs shell + Claude CLI (`seo-generate.sh`, `seo-backfill-generate.sh`). The in-process `SeoCrew`/`AutoPublishCrew`/`FieldCrew`
(`Application/Agents/*`) is still wired and reachable from admin endpoints (`AdminSeoBackfillEndpoints.cs:464`,
`AdminAutoPublishEndpoints.cs:255`). That is two ways to write the same fields, with different prompts and costs. Pick one.
If the CLI stays, the crews, the CrewAb eval and ~1.5k lines are portfolio code.

### N5 — Dead or legacy code — **Low**
- `backend/src/Ai/TextStack.Ai.Rag/` and `backend/src/Epub/TextStack.Epub/` are **untracked local folders with only bin/obj** (not in git). Fix: `rm -rf` locally.
- Three eval projects: `Ai.Evals` (241 lines, used only by `Ai.EvalSuite`), `Ai.EvalSuite` (1.6k), and `tests/TextStack.AiEvals`. Merge `Ai.Evals` into `EvalSuite`.
  `Api.csproj` ships EvalSuite + golden datasets inside the prod API image.
- `MetadataBackfillWorker` (`Worker/Program.cs:100-103`) is a "one-shot heal" for an old env-var bug that is still registered. Delete it.
- The stale `Edition.Embedding` comment (G9).

### N6 — Migrations — **Low**
- 138 migrations, a 21 MB folder, a 5.7k-line snapshot, and 32 migrations with raw SQL (triggers etc.). This is normal for 10 months.
  Squashing is risky because of the raw-SQL triggers (search_vector) and gains little.
- Migrations are applied **twice**, by the `migrator` container (`docker-compose.yml:41-51`) and by `db.Database.Migrate()` at Api startup
  (`Api/Program.cs:71`). Harmless today, because the second run is a no-op. Pick one source (the migrator) so rollback via `MIGRATE_TARGET` cannot be undone by an Api restart.
  Check this: with `MIGRATE_TARGET=0`, the next Api start migrates forward again.

### N7 — Delete order: files before DB commit — **Low**
`UserBookService.cs:400-412` deletes the storage directory, then calls `SaveChangesAsync`. If the save fails, the book row points at missing files.
Swap the order: commit first, then delete files. An orphan file is harmless, a dangling row is not. 5 min.

### N8 — Transactions — **Low**
Explicit transactions exist in only 4 places (account delete, guest merge, model promote ×2). Ingestion uses 4-7
`SaveChanges` per job. A crash between them leaves a partial state, which the stale re-run then repairs, because the chapter re-insert deletes first.
Acceptable. No action.

### N9 — Hot paths / N+1 — **none found**
A scan for queries inside `foreach` loops found them only in background/admin paths (`SeoContentApplier.cs:104-154`,
`TextStackImportService.cs:409`, `ClusterCandidateService.cs:61`). The library shelf uses correlated subqueries, which translate to one SQL statement
(`LibraryShelvesService.cs:60-77`). No action.

### N10 — Tests of critical paths — **Low/Med**
Guest merge has integration tests (`GuestMergeDurabilityTests`, `GuestMergeConflictTests`), and site isolation is tested
(`SiteScopedIsolationTests`). **Nothing tests a queue claim, a stale reclaim, a retry cap, or the collection orphan path.** Add one test with each A-fix in G4/G8.

### N11 — Config sprawl — **Low**
83 distinct config keys are read in code, `Api/appsettings.json` has 163 lines, and compose has 34 `__` env overrides. Manageable for one owner.
`Entitlements` already chose "unset = unlimited, never an outage". Keep that rule and do nothing else.

---

## Ranked gaps

| # | Gap | Severity | Fix now | Cost | Recommendation |
|---|---|---|---|---|---|
| 1 | N1 Copyrighted PDFs in public repo | **High** | yes | 30 min (+1 h history rewrite) | `git rm` + synthetic fixture; owner decides on history rewrite |
| 2 | G4/N2 Catalog ingestion: no retry cap, poison loop | Med | yes | 10 min + test | Copy the `AttemptCount < 3` filter |
| 3 | G4/N3 Shell-queue RUNNING rows never recover; SSG Running has no timeout | Med | yes | ~1-2 h | Stale sweep per poller; timeout in ssg-worker pickup |
| 4 | G8 Four patterns for "a book", MCP/internal surface built twice; R7 RAG premise gone | Med | rule only | ADR 1 h | XOR + `BookRef` as the rule for new code; no storage unification |
| 5 | G8 `book_collections` orphans → wrong counts; no ownership check | Low (bug) | yes | 30 min | Delete in both delete paths + ownership check + test |
| 6 | N4 Two SEO-generation engines (CLI vs in-process crews) | Low/Med | decide | 0-2 h | Keep CLI, delete crews (or the reverse); not both |
| 7 | G3 Api hosts 8 workers, no locks, timers reset on deploy | Low (Med at scale) | doc | 10 min | Document single-instance; move to Worker before any 2nd Api |
| 8 | G9 pgvector for one web widget; Drift off | Low | partly | 1-3 h | Delete Drift; owner decides on concepts |
| 9 | N6 Migrations applied twice (migrator + Api startup) | Low | yes | 15 min | Keep the migrator only; check the `MIGRATE_TARGET` rollback |
| 10 | N10 No tests for queue claim/stale/retry | Low/Med | with 2-3 | inside those fixes | One test per fix |
| 11 | N7 Files deleted before DB commit | Low | yes | 5 min | Swap order |
| 12 | N5 Dead code: untracked Rag/Epub dirs, `Ai.Evals` split, one-shot `MetadataBackfillWorker`, stale comment | Low | yes | 1 h | Delete / merge |
| 13 | G1 Docs claim purity that does not exist | Low | doc | 15 min | Say "pragmatic layering" |
| 14 | G7 Multisite leftovers | Low | no | 0 | Keep (ADR-007); optional singleton SiteContext |
| 15 | N8 / N9 / N11 Transactions, N+1, config | Low / none | no | 0 | No action |

## Open questions for the owner
- History rewrite for the PDFs: yes or no?
- Concept-cluster widget: keep it (and with it pgvector + embeddings) or delete it?
- SEO: CLI or in-process crews, which one survives?
- Is "Api and Worker are single-instance" a rule you accept?
