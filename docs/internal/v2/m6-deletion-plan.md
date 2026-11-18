# M6 deletion plan — retire legacy

Status: **Done 2026-11-17.** Merged: P0 #1395, O1 #1393, I1 #1398, A1 #1397, W1 #1401, M1 #1400, MCP #1399, B1 #1407,
R #1409, B2 #1410, B3 #1412, F3 #1413; legacy database dropped 2026-11-17 18:24 UTC after the restore gate
(the drop note, in git history; the archive: [backup.md](../ops/backup.md#the-legacy-archive-pre-v2)). **Order fix found on the day:**
F step 2 (drop) must come *after* F step 3 (ledger move): until #1413, `api` and `worker` waited on the legacy
`migrator`, which ran against the legacy database, so dropping it first would have stopped the stack starting.
Leftovers: #1406. Base: `main` 27a8b9bc, 2026-11-17. Inputs: `.claude/m6-prompt.md` (deleted; in git history),
[v2-plan §5.5](v2-plan.md#55-retire-m6), [ADR-030](../../architecture/adr/ADR-030-two-databases-one-cutover.md) decided 7,
[ADR-031](../../architecture/adr/ADR-031-v2-schema.md), [ADR-027](../../architecture/adr/ADR-027-retire-public-catalog.md) +
[catalog-retirement-plan §2.5](https://github.com/mrviduus/textstack/blob/f465e6b0afa9fa5df1cc1cc8ca816f1cd22f9e74/docs/internal/legacy/catalog-retirement-plan.md),
[m5-part-c-routes.md](m5-part-c-routes.md). Umbrella #1013.

Rules: one PR per module, code + its tests together, no ports, no new tables, no new tests proving absence. Every PR
updates `tests/TextStack.UnitTests/Routes/routes.public.txt` for public routes it removes. Times below come from the
CI run of 2026-11-17 (step timings); CI wall-clock is the slowest job (`backend` 6–7 min, `e2e` 5–6 min), so a saving
counts only on those two.

## 0. Gates before any deletion

| Gate | Why | Source |
|---|---|---|
| Android store build with the V2 reader + owner device check | the Play build predates #1228 | m6-prompt step 1 |
| Old-client window closed (#1330): no `Gone in V2` line after the owner's devices updated | B2 turns logged 410s into silent 404s; the measurement ends there | ADR-030 decided 6 (amended) |
| Owner confirms the rollback window is closed (D5) | after B2/B3 "flip back" is impossible; recovery = archive restore + tag `pre-v2-cutover` | ADR-030 decided 5 |

## 1. PR order

```
P0 ──┬─ O1 (backups)          ─────────────────────────────┐
     ├─ I1 (SSG/SEO infra)    ─────────────────────────────┤
     ├─ W1 (web) ── B1 (backend catalog) ── B2 ── B3 ──────┼── F (drop + rename + docs)
     ├─ M1 (mobile) ─┐                                     │
     │         W1 ───┴─ R (reader-engine package) ─────────┤
     ├─ A1 (admin app, D2)    ─────────────────────────────┤
     └─ MCP (bridge)          ─────────────────────────────┘
```

Parallel after P0 (file-disjoint): O1, I1, W1, M1, A1, MCP. Stacked: W1 → B1 → B2 → B3 (all touch `Program.cs`,
`Application/DependencyInjection.cs`, `ServiceCollectionExtensions.*`); R after W1 + M1. F last, after everything
and the restore gate. Ownership to avoid conflicts: `packages/shared` → W1 only; `docker-compose.yml` hunks → I1
(ssg-worker), MCP (`TEXTSTACK_MCP_V2`), B3 (`Database__Mode`, `Features__V2Api`), F (migrators, db image).

### P0 — CI runs what production runs

| | |
|---|---|
| Delete | legacy-mode e2e passes: "E2E smoke + reader smoke", "E2E full" and the specs that only test retired routes (`bookmarks`, `reader-smoke`, `reader-mobile`, `reader-pdf`, `search`, `guest-landing`, `vocabulary` (legacy `/me/vocabulary`); `smoke` if it reads the catalog). Integration classes that hit routes 410 in v2 (UserBook*, Highlights, Insights, ChapterReview, ReadingStats/Sessions/Pace/DailyStats/LibrarySummary/BookStats, VocabularyAntiSpiral/Concepts/Embedding/Practice/Spiral/McpWrite, ShelfAfterAssistantProgress, MarkFinishedClientClock, ProgressUnit, ReingestKeepsReaderData, GuestEnrichmentCap, Admin{AgentRuns,Budget,EvalTrend,ModelPromotion,OwnerRules}); the `chapter-review-editions.sql` seed step |
| Change | `ci.yml` `docker` + `e2e` `.env`: `DATABASE_MODE=v2`, `migrator-v2 up` **before** `up -d` (api readiness needs the v2 schema); the "Turn on V2" step goes (always on); `@v2` pass becomes the gate. `docker-compose.yml` default `DATABASE_MODE:-v2`, `FEATURES_V2API:-true`; `.env.example` same. `make up` locally = v2 |
| Why first | every later PR deletes code CI must prove unused in v2 mode; today CI runs legacy mode and would stay green while a v2 path breaks |
| Saves | ~1–1.5 min `docker`, ~1 min `e2e` |
| Note | test deletion ahead of code: deliberate; the code they test is dead in prod and goes in B2 |

### O1 — Backups: V2 is the primary

| | |
|---|---|
| Delete | legacy `pg_dump` in `deploy.yml` "Pre-deploy backup" (legacy is read-only and archived); legacy dump + restic step in `backup.yml`; legacy counts in `restore-drill.yml` (`editions ≥ 1000`, `chapters ≥ 10000`, covers) and `infra/scripts/backup-verify.sh` (`editions` non-empty) |
| Change | V2 pre-deploy dump loses `continue-on-error` (fatal, like legacy's was); `backup.yml` V2 step fatal; drill and verify assert V2 counts (`users`, `books`, `book_files`, `annotations`); `make backup`/`restore` default to V2 |
| Saves | ~2 min per deploy (legacy dump 120 s → V2 ~10 s) |
| Risk | today a failed V2 dump does not stop a deploy, and V2 holds all live data. Fix even if M6 stalls |

### I1 — SSG / SEO infrastructure

| | |
|---|---|
| Delete | `apps/web/scripts/{ssg-worker,ssgJob,ssgRender,ssgSentry,prerender}.mjs` + tests, `apps/web/Dockerfile.ssg-worker`, compose `ssg-worker`, `images.yml` `ssg-worker` entry, `deploy.yml` steps: Wait for SSG rebuild, Snapshot/Restore SSG dir, Queue SSG rebuild, Wait for SSG rebuild, Validate SSG content, `rebuild_ssg` input, ssg-worker scale/pull/tag lines; Verify SEO setup → keep only the CSP check. `infra/scripts/{rebuild-ssg,seo-generate,seo-backfill-generate,seo-backfill-poll,seo-publish-poll,quality-poll}.sh` + `infra/systemd/*.service` (quality poller included: `/internal/quality-jobs` is 410) + "Restart systemd pollers" step; Makefile `rebuild-ssg clean-ssg featured* seo-* quality-poll-*`; `health-check.yml` SSG freshness + crawler-SSG checks; nginx: `$is_bot`/`$ssg_file`/`$seo_render_tag` maps, `location /ssg/`, the four `^/en/(books|authors|genres)…` SSG locations, `/books/*/assets/`, `/sitemap.xml`, `/sitemaps/` |
| Change | nginx catalog prefixes per D1 (recommended: `return 410`); `robots.txt` a static file (no `Sitemap:` line); `prodCsp.check.mjs` if it names a removed location; `restore-ssg-staging.sh` if present |
| Saves | images job ~1 min (the 3–5 GB puppeteer image), deploy ~20 s, disk; health-check cron simpler |

### W1 — Web: catalog UI, legacy reader route, legacy client branches

| | |
|---|---|
| Delete | pages `Books, BookDetail, Reader (catalog), Authors, AuthorDetail, Genres, GenreDetail, Search, Sitemap, ChapterReview, ChapterQuestionReview, Stats, LibraryShelf, HighlightReview, TutorSession`; `DiscoverMenu`, home `StatsBar`/`RecommendedSection`, `bookSeo`/`authorSeo`/`JsonLd`, `DownloadContext` + IndexedDB `chapters`/`cachedBooks`, `SiteContext.tsx` (`/site/context`), IndexNow key files in `public/`, `OffV2` wrapper + every hidden feature it guards, `LegacyRedirect` catalog entries; `packages/shared/src/api/books.ts`, catalog halves of `library.ts`/`readingProgress.ts`/`bookmarks.ts`; `onV2()` branches collapse to the V2 call; `V2_FEATURES` entries that are `false` delete their UI, `true` ones inline |
| Change | `HomePage` → landing (static); `App.tsx` provider tree minus `SiteProvider`, `DownloadProvider`; e2e global setup uploads a fixture book instead of discovering catalog books; header nav |
| Keep | static pages (about, privacy, terms, dmca, **delete-account** (Play requires it), contact, mcp, changelog, oauth consent, device, connect-extension, reset-password), library, upload, V2 reader routes, vocabulary, highlights (`/me/highlights/all`) |
| Saves | web unit tests (75 s today) and e2e full shrink; size unmeasured |

### M1 — Mobile: catalog UI, legacy reader, `v2Enabled()` branches

| | |
|---|---|
| Delete | `app/{books,authors,genres,chapter-review,tutor}.tsx`, `app/{book,author,genre}/`, `app/reader/[bookSlug]/`, `(tabs)/search.tsx`, catalog half of `(tabs)/index`; `src/components/reader/` (legacy `Reader`, `useUserBookReaderSource`, `useEditionReaderSource`), `useBookLibrary`, catalog halves of `useBookActions`/`useBookOffline`, SQLite `chapters`/`cached_books` (+ `offlineDb.web.ts` mirror), `editionIds.ts`, App Links `/en/books`, `+not-found` catalog mapping, `readerEngineScript.generated.ts`, mobile PDF bundle; `v2Enabled()` / V2 probe → always V2 |
| Change | `my-books/read/[bookId]/[chapterSlug].tsx` renders `V2ReaderScreen` only (D4: iOS); stats tab hidden routes; Expo runtime fingerprint moves → store build (OTA cannot carry it) |
| Saves | mobile job ~30 s; Metro bundle size |

### R — `packages/reader-engine` (R8)

| | |
|---|---|
| Delete | `packages/reader-engine/` (+ its `CLAUDE.md`), `.claude/agents/reader-engine.md`, `apps/web/scripts/{build,check}-mobile-{engine,pdf}.mjs`, `mobile-bundles.mjs`, `apps/web/scripts/pdfViewer/` if only the legacy viewer uses it, web `components/reader/{PdfEngineView,ReaderHighlights,ReaderSection,pdfEngineLayout}`, hooks `useHighlightEdit`, `useInBookSearch` (legacy), `useReaderScrollSync`, `useTextSelection`, `lib/readerEngine.ts` + their tests; alias entries in `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, mobile bundler config; `ci.yml` steps "Reader engine unit tests/typecheck", "Drift-check mobile overlay bundle", "Drift-check mobile PDF bundle", "Reader engine geometry"; ADR-025 → Superseded by ADR-032 |
| First | **The V2 page imports the package today**: `apps/mobile/src/lib/v2reader/page.mjs` (`rangeToLocator`, `textNodes` from `src/text`; `SELECTION_SETTLE_MS` from `src/timing`), `bookmarks.mjs` (`blockOf` from `src/engine`; `rangesIn`, `textNodes`), `wordMarks.mjs` (`matchWords`, `rangesIn`, `textNodes`), `selection.test.ts` (`SELECTION_MAX_CHARS`). Move those helpers + their tests (from `text.test.ts`) into `apps/mobile/src/lib/v2reader/`, regenerate `v2ReaderPage.generated.ts` (the drift check gates it), then delete |
| Check | `git grep -n "reader-engine\|readerEngine"` empty outside docs |
| Saves | `frontend` ~40 s, `e2e` ~25 s (geometry) |

### A1 — Admin app: keep the shell (D2 decided 2026-11-17)

| | |
|---|---|
| Delete | every `apps/admin` page except login and an empty home (dashboard, upload, jobs, editions, authors, genres, chapters, SSG, auto publish, SEO, quality pages, tools, settings, user uploads) + their API clients and e2e specs |
| Keep | `apps/admin` app shell, its Dockerfile/compose/nginx `textstack.dev` block/`ci.yml` build, login e2e |
| Backend | `/admin/*` endpoints go in B1 (catalog) and B2 (rest); `/admin/auth` + `V2AdminAuthService` + `AdminAuthMiddleware` + `create-admin` stay (D2 = shell) |
| Keep | `users.role` column (schema change not worth it); `admin_settings` table + repository (knobs edited by SQL) |
| Saves | `frontend` ~20 s, images ~30 s |

### MCP — bridge on V2 only

| | |
|---|---|
| Delete | non-V2 code paths in `backend/src/Ai/TextStack.Ai.Mcp` (`McpBridgeOptions.V2`, `TEXTSTACK_MCP_V2`, legacy route calls), catalog tools `search_books`/`get_book`/`get_chapter`, error-only tools `list_my_highlights`/`save_highlight`/`get_chapter_review`/`save_chapter_review` (D6), `McpRetiredException` |
| Change | `Contracts/Mcp/McpManifest.cs` (descriptions + "Served" no longer reads `Features:V2Api`), the four tool-count tests, server instructions (`McpBridgeCore.cs`), compose `TEXTSTACK_MCP_V2` line, `docs/reference/mcp.md` tool list; owner publishes a new NuGet global tool |
| Saves | MCP tests ~5 s |

### B1 — Backend: catalog, SEO, SSG, Search, crews

| | |
|---|---|
| Delete | endpoints `Books, Authors, Genres, Search, Seo, Ssg, Site, InternalSeo, AdminAuthors, AdminGenres, AdminSsgRebuild, AdminAutoPublish, AdminSeoBackfill, AdminBookQuality`, catalog half of `AdminEndpoints` and `InternalEndpoints` (editions, chapters, featured, quality-jobs, ssg rebuild-all); `Application/{Seo,SsgRebuild,Books,Authors,TextStack,Reprocessing,Ingestion}` (catalog `IngestionService`, `ChapterReconciler`), `Application/Agents/{AutoPublishCrew,SeoCrew,FieldCrew,Researcher,Drafter,Critic,Editor,BaselineField}Agent`, `Ai.EvalSuite/{CrewAb,CriticDefect}*`; `Api/Seo/`, `Api/Sites/` + `SiteContextMiddleware` + `UseWhen(...UseSiteContext)`, `Api/Language/` if only catalog uses it; `backend/src/Search/` + `tests/TextStack.Search.Tests` + `AddTextStackSearchStack`; Worker `IngestionWorker`, `IngestionService`, `TextStackWatcher`, `StuckJobsMetricsWorker`; CLI `import-textstack`, `optimize-images`; `/health/ready` `ssg` component; integration `GenreEndpoint`, `SearchEndpoint`, `SsgRoute*`, `RobotsTxt`; `ci.yml` "Search tests" |
| Change | `Program.cs` Map* list; `Application/DependencyInjection.cs` (SEO, SSG, Books, Authors registrations); `AddTextStackAgents`, `AddTextStackAiEvals`; `ICurrentSite` stays until B3 (EF filters) |
| Keep | `Extraction` (V2 ingestion), `UserStoragePolicy` + `/storage` (avatars, upload covers; `IFileStorageService` is used by `V2AuthService`, `ProfileEndpoints`) |
| Saves | `backend` ~20 s (Search tests, build), `docker` ~15 s |

### B2 — Backend: legacy `/me`, `/admin`, `/internal` handlers (after #1330)

| | |
|---|---|
| Delete | endpoints `UserData, Highlights` (legacy routes), `Insights` (legacy), `ChapterReview, Collections, LibraryShelves, ReadingTracking.*, Tutor, Vocabulary.*` (legacy `/me/vocabulary`), legacy routes in `UserBooks` (all 35; keep `InvalidClip` → move next to `V2CompatEndpoints.Clip`), legacy `/explain` + `/translate` mappings (keep `ExplainEndpoints.ExplainAsync` and the translate helper V2Compat calls), `AdminAiQuality*`, `AdminSettings`, user-uploads/ingestion parts of `AdminEndpoints`, `/internal/user-books/*`; `Api/Mapping/*`; Api hosted services (`AutoRetireSweeper`, `DailyCapReconciler`, `ClusterCandidateBuilder`, `ConceptClustering`, `ContinuousEval` — all off in v2); Application `{ChapterReview, Collections, Library/LibraryShelvesService, ReadingTracking (legacy), UserBooks (legacy), Vocabulary (legacy: budgets, caps, clusters, sweeper, recorder)}`; CLIs `backfill-pdf-page-counts`, `backfill-vocabulary-embeddings`, `cluster-vocabulary`; `Ai.EvalSuite` DB writers if D2 = delete (golden sets + fake-LLM runners in `TextStack.AiEvals` stay); the matching unit/integration tests |
| Change | `SelectedDatabaseGuard`: the 410 branch and `V2SelectedRoute` marker go (no unmarked route left; 404 by routing); the account check (reset/deleted JWT) stays — rename to `AccountGuard`; `V2CompatEndpoints` drops "mapped only in v2" and its `WithOrder(-1)` (no legacy twin) |
| Saves | `docker` ~30 s, `backend` unit tests ~10 s, build |

### B3 — EF Core, `AppDbContext`, legacy identity, `Database:Mode`

| | |
|---|---|
| Delete | `Infrastructure/Persistence/AppDbContext*.cs`, `AppDbContextOptions`, `CurrentSite`, `Legacy/` (Ef* repositories, `LegacySignIn`), `ModelRegistrySeeder`, `Etl/` + `Api/V2/EtlV2Command.cs` + `etl-v2` CLI + `make etl-v2` (the `restore-drill.yml` ETL rehearsal went in O1: it needs the legacy dump); `Application/Common/Interfaces/IAppDbContext.cs`, `ICurrentSite`/`ISiteScoped`, legacy `AuthService`, `AdminAuthService`, `Identity/V2ShadowUsers`, `Api/V2/V2IdentityMirror`, `Ai/{DbLlmTraceWriter,DbAgentRunWriter,RegistryModelRouteProvider,ModelPromotionService}`; Domain legacy EF entities no V2 code references; Worker `GuestCleanupWorker`, `MetadataEnrichmentWorker`, `UserIngestionService`, `UserBookEnrichmentService`, the AppDbContext factory; EF packages in `Directory.Packages.props`, `Application.csproj`, `Infrastructure.csproj`, `UnitTests.csproj`; `SchemaDriftTests`, `SchemaVersionTests` legacy half; `ci.yml` "Migrations round trip" (legacy), "Run migrations", "Schema drift"; Persistence.Tests legacy schema build in `ScratchDatabases`/`PostgresFixture` |
| Collapse | `DatabaseMode` type + `Database:Mode` + `Features:V2Api` (code, compose, `.env.example`; `AuthEndpoints`, `RetentionCleanupWorker`, `WorkerRegistration`, `IdentityRegistration` → V2 ports only); `SelectedDatabaseProbe` → one `V2DataSource`, `CatalogLegacy` + `/health/ready` `legacy` component + startup legacy pending-check go; `health-check.yml` legacy step; `V2Gate` legacy branch; `AddTextStackDataAccess` one data source; `ConnectionStrings:Default` no longer read (D7); `IModelRouteProvider` → config routes (the gateway's existing fallback); `ILlmTraceWriter`/`IAgentRunWriter`/`ILlmSpendSource` → V2 writers unconditionally; `AddTextStackHostedServices` gone |
| Check | `git grep -l "DbContext\|EntityFrameworkCore" backend/` empty (ADR-030 consequence); `dotnet list package` has no `Npgsql.EntityFrameworkCore`, `Pgvector.EntityFrameworkCore` |
| Saves | `backend` ~2 min (legacy round trip 55 s, run migrations, drift, half of Persistence 74 s, build) — the critical path, ~7 → ~5 min |

### F — Drop, rename, docs (last)

| Step | Detail |
|---|---|
| 1. Restore gate | restore `~/archive/textstack-legacy-2026-11-17.sql.gz` into a scratch container (`pgvector/pgvector:pg16`), exact `count(*)` per table on the restore equals the live `textstack_prod` (read-only since the cutover, so they must match; the cutover log holds no per-table counts) and `sha256` of the file matches `1e872b9e…0208`; `pg_stat_activity` shows no connection to the legacy DB; record in an `internal/ops/` note. A second off-box copy of the archive exists |
| 2. Drop (owner, on the server) | `DROP DATABASE <legacy>` after step 1; `data/storage` catalog dirs (`{id[..2]}/{id}/`) archived then removed; user dirs stay |
| 3. Ledger move (PR) | `database/migrations/`, `database/migrate.sh`, `database/tests/`, `database/scripts/` (legacy) deleted; `database/v2/*` → `database/`; `migrator-v2` → `migrator` (one service, `PGDATABASE=${V2_POSTGRES_DB}`), `make migrate-v2*` → `make migrate*`; `Migrator.Dockerfile`, `PostgresFixture`, `ci.yml` "V2 migrations round trip" path; V2 migration `0007_drop_migration_runs` (ETL ledger, ADR-031 "dropped at M6.5") |
| 4. Config | compose `ConnectionStrings__Default` → the V2 db; `POSTGRES_DB` meaning documented; owner edits prod `.env` (removes `DATABASE_MODE`, `FEATURES_V2API`; `POSTGRES_DB` → the V2 db). After the drop every `psql -U textstack_prod` without `-d` fails (default db = user name): `deploy.yml` (SSG wait, pre-deploy dump), `backup.yml` legacy dump and the CLAUDE.md DB-shell line must be gone or name the database before step 2; the `db` healthcheck `pg_isready -d ${POSTGRES_DB}` reports server state, confirm on the scratch container |
| 5. Docs | `CLAUDE.md`: "V2 program" + "Keep the V2 status true" sections go; Architecture/Commands/Storage/Search/Test Projects rewritten for one DB (no EF, no SSG, no catalog, no reader-engine, no admin if D2); `internal/claude/*.md` same; `docs/STATUS.md`; ADR-025/027/030 status → Done/Superseded; `v2-plan.md`, `m5-*`, `r8-parity-audit.md`, `epub-*`, `docs/architecture/v2.md` get a "Historical (M6 done YYYY-MM-DD)" banner; #1013 M6 ticked |
| 6. `/changelog` road | close PR: every `MOVE_STEPS` step `done`, `MOVE_UPDATED`, `MOVE_OPEN` empty. Follow-up PR (a week later): delete the road block in `apps/web/src/lib/changelog.ts` + its UI |
| Optional | #1056: dump V2, restore into a fresh `postgres:16` cluster (no pgvector, collation fixed); the db image pin changes; rename the database here if D7 says so |
| Saves | images: one migrator image fewer; nightly backup single DB |

## 2. Must NOT be deleted

| Thing | Why |
|---|---|
| Identity: `V2AuthService`, `V2AdminAuthService` (unless D2), Dapper identity repos, `JwtTokens`, `ProviderTokens`, guest sessions (ADR-014), device auth, OAuth server, MCP keys, `/me/account`, `/me/profile` | all `V2SelectedRoute` today |
| AI stack: `Ai.Core`, `Ai.Llm` (gateway, tracing, budgets), `Ai.Tools`/`Ai.Agents` used by explain/translate/enrichment, `V2LlmTraceWriter`, `V2AgentRunWriter`, `RollingSpendTracker`, Ollama | explain/translate run on V2 spend |
| MCP server + bridge (V2 path), `McpManifest` | live in prod |
| `/me/v2/*` (library, reading, annotations, vocabulary, discussion, insights), `TextStack.Vocabulary` | the product. Paths keep `/v2` (store clients call them) |
| `V2CompatEndpoints`: `POST /me/books/clip` (extension, unchanged path), `GET /me/highlights/all`, `POST /explain`, `POST /translate`, `POST /api/translate` | new clients call them |
| `/tts` + `EdgeTtsService` | mobile V2 reader uses TTS |
| `/app/config`, `/.well-known/*`, `/mcp` manifest, `/health*` | infra + clients |
| Transitional `book_chapters`, `ingestion_jobs`, `V2IngestionWorker`, `Extraction` | `get_my_chapter`, `share_chapter`, clip extraction need them (D8) |
| `IFileStorageService`, `/storage`, `data/storage/users/*` | avatars, upload covers |
| Public pages: landing, about, privacy, terms, dmca, delete-account, contact, mcp, changelog, oauth consent, device, connect-extension, reset-password, `robots.txt` | static; Play Store links privacy + delete-account |
| Legacy database, `~/archive/textstack-legacy-2026-11-17.sql.gz`, tag `pre-v2-cutover` | DROP only after F step 1; archive + tag forever |

## 3. Owner decisions

| # | Question | Options (recommended first) |
|---|---|---|
| D1 | Catalog URLs `/en/books/*`, `/authors/*`, `/genres/*`, `/search`, `/sitemap`, `sitemap.xml`, `/sitemaps/*` | **(a) nginx `410 Gone`** — crawlers drop them fast; search sent 6 clicks in 90 days (#992). (b) `301` → landing — Google treats mass redirects to home as soft-404 anyway. (c) SPA 404 — 200-status soft-404s (known defect today) |
| D2 | Admin panel (every page but login is 410 in v2) | **(a) delete `apps/admin`, `textstack.dev`, `/admin/*`, `create-admin`**; knobs by SQL. (b) keep login + Settings + User uploads, ported to V2 — a port, against the M6 rule. **Decided 2026-11-17: keep the shell** (login + empty home, no port); pages go |
| D4 | iOS: deleting the legacy mobile reader leaves iOS with none (V2 host is Android-only) | **(a) accept** — iOS never shipped; an iOS host is its own issue. (b) keep the legacy reader for iOS — blocks R and keeps `book_chapters` reading |
| D5 | Rollback window | **(a) closed when B2 merges**; recovery after that = restore archive + deploy `pre-v2-cutover`. (b) closed at F |
| D6 | MCP tools that only answer "retired" | **(a) delete** (25 → 18 tools), new NuGet. (b) keep answering errors |
| D7 | Database name | **(a) keep `textstack_v2`**, map it to `ConnectionStrings:Default`; rename only during the optional #1056 dump/restore. (b) `ALTER DATABASE … RENAME` in F (short downtime) |
| D8 | Transitional tables (ADR-031: "dropped at M6.4") | **(a) keep, out of M6** — MCP chapter tools and clips read them; amend ADR-031. (b) drop with R — MCP loses chapter text. **Decided 2026-11-17: (a) keep** |
| D9 | #1366 is open ("bring back on V2 after M5": goals, achievements, book stats, vocabulary settings/pending/lookups/concepts, highlight review), but W1/M1 delete the hidden UI those features would reuse | **(a) W1/M1 keep that hidden UI** (`OffV2`, `V2_FEATURES` false entries, stats pages) and delete only its legacy API calls; #1366 re-points or deletes it. (b) delete now; #1366 rebuilds from git history. **Decided 2026-11-17: (b) delete now** |

## 4. Risks

- **LLM routing changes at B3.** In v2 mode today `RegistryModelRouteProvider` still reads the Primary rows of legacy `models` (read-only DB). Before B3: `SELECT feature_tag, provider_key FROM models WHERE status = 'Primary'` on the legacy DB must equal the `Ai:Routes` config, or move the difference into config in B3.
- **`/site` resolution reads legacy until B1.** `Api/Sites/SiteResolver.cs` queries `site_domains`/`sites` for every request outside its skip list (`/me`, `/auth`, `/oauth`, `/admin`, `/health`…): explain, translate, tts and `/site/context` included; B1 deletes it, so B1 must also stop `LanguageMiddleware` asking for a site.
- P0: `tests/TextStack.IntegrationTests/AccountDeletionEndpointTests.cs` seeds legacy data (`/books`, `/me/books`, `/me/highlights`, `/me/reading/sessions`, `/me/vocabulary/words`): re-point its seeding to `/me/v2` (the GDPR-delete story stays), do not delete it.
- P0 may surface v2-mode bugs CI never ran (it is the point). Fix forward in P0, or file and skip with an issue.
- B3 is the largest PR (EF out of Application). If review exceeds budget, split: B3a identity/AI writers/DatabaseMode collapse, B3b EF + entities + packages.
- Old store builds get 404 instead of 410 after B2: acceptable after #1330.
- M1 moves the Expo runtime fingerprint: store build, not OTA (#914 single-runtime limit).
- `dotnet format` and route snapshot tests fail on every PR that forgets `routes.public.txt`.
