# Catalog retirement — inventory and phased plan (interim migration)

> **Proposed — deferred into V2 (owner, 2026-10-28); no interim migration.** The catalog stays frozen. The original proposal below is research input for the [V2 target model](v2-target-model.md), not an implementation plan to execute now.

Decision and alternatives: [ADR-027](adr/ADR-027-retire-public-catalog.md). Tracking: #926, #992.
Audited 2026-10-28 against `main` @ `586a9d30` (ledger 0000–0016). Row counts are from 2026-10-26
([data-model.md](data-model.md)); step C0.1 re-counts production.

**This is an interim migration.** It moves catalog-linked user data into today's personal library.
Server-side `user_chapters` are transitional. V2 targets local reading, with chapter context shared
with MCP only when the reader chooses (separate ADR). New provenance is therefore keyed by chapter
slug and number, never by `user_chapters.id`.

## 1. Baseline and table milestones

| Milestone | Tables |
|---|---|
| Baseline `0000` | 63 |
| Dropped since: `0005` notes, `0006` ssg_rebuild_results, `0007` shadow_runs, `0009` word_frequencies, `0010` lint_results. No `CREATE TABLE` after `0000`; the runner's `schema_migrations` is not counted | −5 |
| **Today** | **58** |
| C1.1 adds the transitional ledger `catalog_materializations` | 59 |
| **After this slice** (C5.3 drops 19 catalog tables + the ledger) | **39** |
| **After #946** (`sites`, `site_domains`) | **37** |
| V2 target | ≤ 20 |
| Gap | 19 after this slice; 17 after #946 (§9) |

**21 vs 22.** The 22 estimate counted `book_quality_jobs` as catalog. It is not:
- it holds exactly one of edition or upload (`ck_book_quality_jobs_owner`);
- the Worker enqueues upload jobs (`IngestionService.cs:427`);
- `quality-poll.sh` calls the `/internal/user-books/*` routes;
- admin BookQuality lists both kinds.

It is retained; only its `edition_id` column goes. The removal list is 21: 19 here, 2 in #946.

## 2. Inventory

### 2.1 Retired tables

| Group | Tables | Rows | Dropped by |
|---|---|---|---|
| Content | `works`, `editions`, `chapters`, `authors`, `edition_authors`, `genres`, `edition_genres`, `book_assets` | 1,433 / 1,433 / 40,722 / 725 / 1,437 / 58 / 2,134 / 5,011 | C5.3 |
| Ingestion | `book_files`, `ingestion_jobs`, `text_stack_imports` | 22 / 25 / 1,409 | C5.3 (originals copied first, §4) |
| SEO / SSG | `auto_publish_jobs`, `seo_templates`, `seo_backfill_jobs`, `seo_backfill_settings`, `ssg_rebuild_jobs` | 2,993 / 24 / 12 / 1 / 11,659 | C5.3 |
| Catalog reading | `user_libraries`, `reading_progresses`, `bookmarks` | 246 / 435 / 9 | C5.3 (copied, not moved, before) |
| Transitional | `catalog_materializations` | — | C5.3 |
| Site | `sites`, `site_domains` | 1 / 4 | #946. 14 retained tables still FK `site_id → sites` |

These also go with `chapters`:
- the trigger `chapters_search_vector_update`;
- the functions `chapters_search_vector_trigger()` and `get_fts_config()`, which have no caller outside
  the baseline (checked);
- the baseline seed rows for works, editions, chapters, authors, genres and the seo tables. Fresh
  databases (CI, local, e2e) lose their example books.

### 2.2 Retained tables with catalog references

| Table | Catalog column(s) | FK on delete | Handling |
|---|---|---|---|
| `highlights` | `edition_id`, `chapter_id` | SET NULL (composite FK `0016`) | re-pointed to `user_book_id`, `user_chapter_id` |
| `reading_sessions` | `edition_id` | SET NULL | re-pointed for materialized pairs; session-only pairs per D1 |
| `book_insight` (+ `review_question` via FK) | `edition_id` | **CASCADE**: dropping editions first deletes insights and chapter reviews | re-pointed; `chapter_slug` stays valid (slugs copied) |
| `vocabulary_words`, `pending_vocabulary_words`, `word_lookups` | `edition_id`, `chapter_id` (FK → catalog `chapters`) | SET NULL | `edition_id` → `user_book_id`; **`chapter_id` → new `chapter_slug`** (provenance kept) |
| `word_clusters` | `edition_id` | SET NULL | → `user_book_id` |
| `book_collections` | `book_id` where `book_type='savedbook'` (no FK) | — | → materialized id, `book_type='userbook'` |
| `agent_run` | `edition_id` (no FK; written by SEO crews) | — | left; rows deleted after 30 d; column dropped |
| `book_quality_jobs` | `edition_id` | CASCADE | edition rows per D10; `user_book_id` becomes NOT NULL |

C5.2 drops 13 columns: `highlights` ×2, `reading_sessions`, `book_insight`, vocabulary ×6,
`word_clusters`, `agent_run` and `book_quality_jobs`. Their indexes and constraints go with them:
- `ck_highlights_owner`, `ck_highlights_chapter_owner`, and the composite FK to `chapters`;
- `ck_reading_sessions_owner`, `ck_book_insight_target`, `ck_book_quality_jobs_owner`;
- `ck_book_collections_book_type`.

### 2.3 Additive columns (C1.1)

| Column | Why |
|---|---|
| `user_books.source_edition_id` uuid NULL, unique partial `(user_id, source_edition_id)`, no FK | Provenance and the shim's lookup key; survives the drop |
| `user_books.progress_max_chapter_number` int NULL | The furthest-read frontier (chapter-review spoiler gate). Catalog progress keeps it monotonic (`UserDataEndpoints.cs:275`). Uploads only derive it from the current position (`ChapterFrontier`). From C1.2 on, the upload progress write maintains `max(old, current)` for every upload, or a copied value would freeze and `ChapterFrontier` (`if MaxChapterNumber is {} max return max`) would trust it forever |
| `chapter_slug` varchar(300) NULL on `vocabulary_words`, `pending_vocabulary_words`, `word_lookups` | Vocabulary chapter provenance. Uploads send no chapter id today (`vocabChapterId` returns `undefined` for uploads), so this also closes the gap for uploads (C1.3) |

### 2.4 Retained, untouched in shape (37 at the end)

| Area | Tables |
|---|---|
| Accounts (11) | `users`, `user_refresh_tokens`, `admin_users`, `admin_refresh_tokens`, `password_reset_tokens`, `device_authorizations`, `oauth_clients`, `oauth_authorization_requests`, `oauth_grants`, `mcp_access_keys`, `admin_settings` |
| Library (7) | `user_books`, `user_chapters`, `user_book_files`, `user_ingestion_jobs`, `user_book_bookmarks`, `collections`, `book_collections` |
| Reading (6) | `highlights`, `reading_sessions`, `reading_goals`, `user_achievements`, `book_insight`, `review_question` |
| Vocabulary/tutor (7) | `vocabulary_words`, `vocabulary_reviews`, `user_vocabulary_settings`, `pending_vocabulary_words`, `word_lookups`, `word_clusters`, `tutor_session` |
| AI (5) | `llm_traces`, `agent_run`, `models`, `model_promotions`, `eval_runs` |
| Quality (1) | `book_quality_jobs` |

`user_books.seo_source` is the enrichment overwrite guard, not SEO, and is kept.

### 2.5 Code: retired / rewired / kept

Line counts are `wc -l` as of today.

| Area | Retired | Rewired | Kept |
|---|---|---|---|
| API public | `/books` (+ assets), `/authors`, `/genres`, `/search`, `/search/suggest`, `SeoEndpoints` (robots, sitemaps), `/ssg`; `/site` with #946 | — | `/app/config`, auth, MCP manifest |
| API `/me` | `/me/progress/{editionId}`, `/me/bookmarks`, `/me/library/{editionId}`: shim (C1.7), then removed (C5.5) | `/me/highlights`, `/me/insights`, `/me/chapter-review`, `/me/review-questions`, `/me/reading` (sessions; stats genre/author from `user_books`; achievements), `/me/library/shelves`, collections, vocabulary, `/explain` genre, tutor `GetChapterTool` | upload routes |
| API `/admin`, `/internal` | Editions, chapters, authors, genres, catalog upload, autopublish, seo, ssg; `/internal/seo/*`, `/internal/ssg/rebuild-all`, `/internal/editions/*`, `/internal/featured` | `/admin/quality` (uploads only) | `/internal/user-books/*` |
| Worker | catalog `IngestionService`, `TextStackWatcher` + Standard Ebooks sync, SEO/SSG/ingestion metrics, ssg purge | `GuestCleanupWorker` filter | `UserIngestionService`, enrichment, quality |
| SEO + crews | ~4.5k lines (Application/Seo, Api/Seo, agents, prompts, AutoPublish, `CrewAb`/`CriticDefect` runners) + 3,123 test lines | `AdminAiQualityEndpoints.EvalRunners` | other evals |
| SSG | `apps/web/scripts/ssg*` + `prerender.mjs` (2,643), `Dockerfile.ssg-worker` (71), `restore-ssg-staging.sh`, `rebuild-ssg.sh`, compose service, `images.yml` entry, backend SSG (642), docs (419) | — | — |
| Infra | ~268 lines of `deploy.yml`, ~137 lines of nginx, ~76 lines of `health-check.yml`, `seo-*.sh` (801) + 2 systemd units, Makefile `rebuild-ssg`/`clean-ssg`/`featured*`/`seo-*` | robots, `$private_route_robots` | `quality-poll.sh` + its unit |
| Search | `TextStack.Search` + tests | — | `UserBookSearchService` |
| CLI | `import-textstack`, `optimize-images` | — | `backfill-pdf-page-counts` (reused for copied PDFs), others |
| MCP | `search_books`, `get_book`, `get_chapter`, `list_my_highlights`, `save_highlight`, after the transition (§8) | `get_book_progress`, `set_book_progress`, `save_insight`, `get_my_insights`, `get_chapter_review`, `save_chapter_review`, `get_my_reading`; server instructions (`McpBridgeCore.cs:88`) | upload and vocabulary tools |
| Web | catalog pages, `DiscoverMenu`, `Search`, home `StatsBar`/`RecommendedSection`, `bookSeo`/`authorSeo`/`JsonLd`, catalog `DownloadContext` + IndexedDB `chapters`/`cachedBooks`, IndexNow keys | `HomePage` → landing; `LibraryPage`/`useLibrarySource`; `ReaderPage` (userbook mode only); sync libraries keyed by editionId; vocabulary save sends `chapterSlug` | `SeoHead`, static pages |
| Admin | Editions, EditEdition, EditChapter, Authors ×3, Genres ×3, Upload, Jobs, Tools, SeoBackfill, AutoPublish, SsgRebuild, SsgRebuildJob | Dashboard, BookQuality | UserUploads, AiQuality, Settings, Login |
| Mobile | catalog tabs and screens, `useEditionReaderSource` + its hooks, `useBookLibrary`, catalog halves of `useBookActions`/`useBookOffline`, SQLite `chapters`/`cached_books`, `editionIds.ts`, App Links `/en/books`, `+not-found` catalog mapping | `(tabs)/index`, `library.tsx` (no all-or-nothing `Promise.all`), highlights list, chapter-review launch, insights, continue-reading, collections, vocabulary `chapterSlug` | uploads reader, offline uploads |
| Shared | `api/books.ts`; catalog halves of `library.ts`, `readingProgress.ts`, `bookmarks.ts` | `highlights.ts`, `readingTracking.ts`, `vocabulary.ts`, `insights.ts`, `collections.ts` | rest |
| Tests | e2e global setup discovers catalog books (bookmarks, guest-landing, reader-mobile, reader-smoke, smoke, search) | global setup uploads a fixture book | — |
| Backups | — | `backup-verify.sh` (requires `editions`/`chapters` non-empty), `restore-drill.yml` (editions ≥ 1000, chapters ≥ 10000, 200 edition covers) | everything else |

## 3. Which pairs are materialized

**Pair** = (user, edition). It is materialized when it has an **intent** row: `user_libraries`,
`reading_progresses`, `bookmarks`, `highlights`, vocabulary ×3, `word_clusters`, `book_insight`, or
`book_collections` (`savedbook`). Books never explicitly saved are covered: a highlight or a looked-up
word is enough.

**Session-only pairs are an open decision (D1).** If they are materialized, every bounced guest gains a
`user_books` row, and `GuestCleanupWorker` keeps any guest that owns one, so those guests become
permanent. If they are not, their sessions stay attached to no book (still counted in stats, the same
trail a deleted upload leaves).

### 3.1 Content

| Target | Source | Rule |
|---|---|---|
| `user_books` | edition + first author + first genre | `id` from the ledger (deterministic `md5('ub' ‖ user ‖ edition)`); `source_edition_id`; slug = edition slug, suffixed on a `(user_id, slug)` collision; Ready; `toc_json` from chapters; `metadata_enrichment_status` Completed (no LLM spend); `seo_source` `manual`; `total_word_count` |
| `user_chapters` | `chapters` | `id` = `md5(user ‖ chapter_id)`, so the shim and the revert can map catalog chapter ids by recomputing; number, slug, title, html (asset URLs rewritten), plain text, word count, PDF page bounds |
| `user_book_files` | `book_files` (§4) | copied file, `sha256` + `file_size` computed, `format` kept; PDFs then get `page_count` from `backfill-pdf-page-counts` |
| cover, inline images | `editions.cover_path`, `book_assets.storage_path` | copied to `users/{u[..2]}/{u}/books/{ub}/cover.<ext>` and `…/assets/{assetId}.<ext>`; html `/books/{editionId}/assets/{id}` → `/api/me/books/{ub}/assets/{id}` |

### 3.2 User rows

| Source | Destination | Mode | Notes |
|---|---|---|---|
| `reading_progresses` | `user_books.progress_*` | copy | chapter slug via `chapter_id`; locator, `position_json`, percent (same `book` unit on both sides), `completed_at` (+ `is_read`/`read_at`), client and server timestamps; **`max_chapter_number` → `progress_max_chapter_number`**. Newer `client_updated_at` wins if the shim already wrote |
| `bookmarks` | `user_book_bookmarks` | copy | `id` = `md5('bm' ‖ id)`; mapped chapter; locator, title |
| `user_libraries` | the `user_books` row | copy | `created_at` |
| `highlights` | same row | re-point | one `UPDATE` sets the upload keys and NULLs the catalog keys (CHECKs `0012`/`0013` and FKs `0016` hold) |
| `reading_sessions` | same row | re-point | partial unique `(user_id, user_book_id, started_at)` cannot collide (fresh book) |
| `book_insight` | same row | re-point | partial unique cannot collide |
| vocabulary ×3 | same row | re-point | `edition_id` → `user_book_id`; `chapter_slug` from `chapter_id`; `chapter_id` → NULL |
| `word_clusters` | same row | re-point | — |
| `book_collections` | same row | re-point | → materialized id, `userbook` |

**Quota**: `CheckQuotaAsync` excludes rows with `source_edition_id IS NOT NULL` from `MaxBooks`; their
bytes are not added to `StorageUsedBytes`.

**Guest → account merge** (`AuthService.cs:239-340`): if both sides materialized the same edition, the
account's copy wins. The guest's annotations, sessions and insights move onto it, the newer progress
and the higher frontier win, the guest's copy is deleted, and its ledger row is marked merged.

**User deletes a materialized book**: `UserBookService.DeleteAsync` sets the ledger row to `deleted`.
After that, neither the job nor the shim materializes that pair again.

### 3.3 The ledger: `catalog_materializations`

| Column | Purpose |
|---|---|
| `user_id`, `edition_id` (PK) | the pair |
| `user_book_id` | the copy |
| `state` | `materialized` · `reverted` · `deleted` · `merged` |
| `run_id`, `materialized_at`, `updated_at` | audit, ordering |
| `source_counts` jsonb | rows copied or re-pointed per table: input to validation and revert reporting |

Each pair takes `pg_advisory_xact_lock(user, edition)` and does all of its rows plus the ledger row in
**one transaction**. The job and the shim both take that lock, so they cannot double-materialize.

**Files**:
1. Copy to the book's deterministic folder before the commit. The copy is idempotent: it overwrites
   and verifies size and sha256.
2. Commit.
3. On a later run, a deterministic folder with no ledger row is an interrupted pair; it is cleared and
   redone.

### 3.4 Count query (C0.1, on a restored backup)

```sql
WITH intent(user_id, edition_id) AS (
  SELECT user_id, edition_id FROM user_libraries
  UNION SELECT user_id, edition_id FROM reading_progresses
  UNION SELECT user_id, edition_id FROM bookmarks
  UNION SELECT user_id, edition_id FROM highlights               WHERE edition_id IS NOT NULL
  UNION SELECT user_id, edition_id FROM vocabulary_words         WHERE edition_id IS NOT NULL
  UNION SELECT user_id, edition_id FROM pending_vocabulary_words WHERE edition_id IS NOT NULL
  UNION SELECT user_id, edition_id FROM word_lookups             WHERE edition_id IS NOT NULL
  UNION SELECT user_id, edition_id FROM word_clusters            WHERE edition_id IS NOT NULL
  UNION SELECT user_id, edition_id FROM book_insight             WHERE edition_id IS NOT NULL
  UNION SELECT c.user_id, bc.book_id FROM book_collections bc
        JOIN collections c ON c.id = bc.collection_id WHERE bc.book_type = 'savedbook'),
sessions_only AS (
  SELECT DISTINCT user_id, edition_id FROM reading_sessions WHERE edition_id IS NOT NULL
  EXCEPT SELECT * FROM intent)
SELECT u.is_guest,
       count(*)                                           AS pairs,
       count(DISTINCT i.user_id)                          AS users,
       count(DISTINCT i.edition_id)                       AS editions,
       count(*) FILTER (WHERE NOT e.is_public_domain)     AS non_pd_pairs,
       count(*) FILTER (WHERE u.last_active_at < now() - interval '30 days') AS inactive_pairs,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM book_files f WHERE f.edition_id = i.edition_id)) AS pairs_with_book_file,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM book_files f WHERE f.edition_id = i.edition_id AND f.format = 1)) AS pairs_pdf,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM text_stack_imports t WHERE t.edition_id = i.edition_id)) AS pairs_standard_ebooks,
       sum((SELECT sum(pg_column_size(ch.html) + pg_column_size(ch.plain_text))
            FROM chapters ch WHERE ch.edition_id = i.edition_id)) AS bytes_copied,
       (SELECT count(*) FROM sessions_only)               AS session_only_pairs
FROM intent i JOIN users u ON u.id = i.user_id JOIN editions e ON e.id = i.edition_id
GROUP BY u.is_guest;
```

## 4. Source files

| Source | Where it lives | In backups? | Plan |
|---|---|---|---|
| `book_files` (22: admin uploads, EPUB + PDF) | storage, `storage_path` | yes (storage is in restic) | copied to `user_book_files` per materialized pair; each file's existence checked in C0.1 |
| Standard Ebooks imports (`text_stack_imports`, 1,409) | built from a host source folder (`TextStack:WatchPath`, `identifier` = folder name); never stored | **unknown**; checked in C0.1 | if the folder exists: package the EPUB per touched edition into `user_book_files`. If not: **D4** |
| Covers, inline images | storage | yes | copied (§3.1) |
| Everything above, whole | — | — | the permanent archive (C0.2) holds all catalog storage + the host source folder if present |

## 5. Steps — one issue each

Every schema step follows ADR-026 (headed up/down, `data-model.md` row in the same PR). Every PR gets
`/code-review`, and findings are fixed before merge.

### Phase 0 — backup and facts

| # | Issue | Done when | Rollback |
|---|---|---|---|
| C0.1 | **Verified restore + counts + source-file inventory.** Dispatch `restore-drill.yml` from a throwaway branch with an extra step: §3.4, the existence of every `book_files.storage_path`; on the server: whether `TextStack:WatchPath` exists, its size, and whether restic includes it | drill green; numbers on the issue; D1–D4 have their data | n/a |
| C0.2 | **Permanent archive**: `pg_dump`, catalog storage, the Standard Ebooks source folder if present, to a location outside restic retention (D7); a restore of the dump proven; git tag `pre-catalog-removal` | restore proven; checksums recorded | n/a |

### Phase 1 — additive schema, job, shim

| # | Issue | Done when | Rollback |
|---|---|---|---|
| C1.1 | **`0017`**: §2.3 columns + ledger table | roundtrip green | `migrate-down 16` (all empty) |
| C1.2 | **Frontier for all uploads**: the upload progress write keeps `progress_max_chapter_number = max(old, current chapter_number)`; `ChapterFrontier` reads it | tests: going back keeps the frontier; existing uploads (NULL) keep today's fallback | code revert |
| C1.3 | **Vocabulary `chapter_slug`**: saves from both readers send it; the API stores it on all three tables, and pending → word promotion (`DailyCapService`) carries it | tests per table | code revert (column stays empty) |
| C1.4 | **Quotas skip materialized books** | a guest with 2 materialized books can still upload 1 | code revert |
| C1.5 | **Materialize content** (§3.1, §3.3): service + CLI `materialize-catalog-books [--dry-run] [--user] [--revert]`, ledger, locks, files | §6 tests T1–T4, T7 | `--revert` |
| C1.6 | **Re-point and copy user rows** (§3.2) inside the same pair transaction | §6 T5, per-table tests incl. CHECKs/FKs `0012`–`0016` | `--revert` |
| C1.7 | **`--revert`**: delete the copy + files; re-point shared rows back, *including rows created after the migration* (catalog chapter id recomputed from `md5(user ‖ chapter_id)` over the source edition, vocabulary `chapter_slug` → `chapter_id`); write newer copy progress and frontier back to `reading_progresses`; copy bookmarks created on the copy back to `bookmarks`; report every row it cannot map (e.g. a highlight on a book the user deleted); ledger → `reverted`. Valid only while catalog tables exist | §6 T6 | — |
| C1.8 | **Guest merge + delete hook** (§3.2) | tests: both sides materialized; one side; delete → no resurrection by job or shim | code revert |
| C1.9 | **Edition-id compatibility shim**, per §7. Logs every hit with `X-App-Version`, route and outcome (translated / materialized-on-demand / accepted-without-book / rejected) | tests per route with old-client payload fixtures from `packages/shared` | flag off → old behaviour (catalog live) |

### Phase 2 — validate, then clients

| # | Issue | Done when | Rollback |
|---|---|---|---|
| C2.1 | **Validation script** `database/scripts/validate-catalog-migration.sql` (§6.2). Run the job + script on a restored backup through the drill, then on production | 0 failures on the backup, then on production; report on the issue | `--revert` on production |
| C2.2 | **MCP transition stage 1** (§8): dual tools accept old ids; scenario suite S1–S10 green on the migrated backup | §8 suite green | code revert |
| C2.3 | **Web**: landing page; library and reader uploads-only; flush pending catalog syncs, then drop the IndexedDB catalog stores; catalog routes per D5; e2e uploads a fixture book | e2e green on uploads | code revert |
| C2.4 | **Mobile build**: catalog screens out; guests land on library/upload. One-time local step: push newer AsyncStorage catalog progress and any unsynced catalog data through the shim, *then* delete the catalog SQLite rows (the copy re-downloads on Wi-Fi). Library no longer fails whole on a catalog error; App Links `/en/books` removed | Internal → Production; then raise `MOBILE_MIN_SUPPORTED_BUILD` after the D8 window | OTA / store rollback; the shim still serves old builds |

### Phase 3 — disable publication

| # | Issue | Done when | Rollback |
|---|---|---|---|
| C3.1 | **Stop SEO and catalog jobs**: disable the `seo-publish-poller` and `seo-backfill-poller` units; remove `ssg-worker` from compose; turn off `rebuild_ssg` and the SSG steps in `deploy.yml`; remove the SSG and catalog smokes from `health-check.yml`; stop catalog ingestion (`TextStackWatcher`, the catalog queue, admin upload) | a deploy with no SSG/SEO step; health check green | re-enable / revert |
| C3.2 | **Public catalog off**: `/books`, `/authors`, `/genres`, `/search*`, sitemaps → 410; robots minimal; nginx catalog paths per D5; `routes.public.txt` updated; run the job a final time + C2.1 (expect a delta of 0) + MCP stage 2 (§8) | validation + §8 suite green; a `curl` matrix of old URLs | revert (tables intact) |

### Phase 4 — retire code (pure deletions)

| # | Issue |
|---|---|
| C4.1 | SSG (§2.5 row) |
| C4.2 | SEO pipeline, crews, AutoPublish, two eval runners, admin SEO pages, pollers, Makefile targets |
| C4.3 | Catalog backend: endpoints, admin catalog services, catalog ingestion, import, CLIs, `TextStack.Search`; rewire stats, achievements, explain, tutor, chapter review, shelves and `GuestCleanupWorker`; remove catalog entities (the shim reads only `user_books`, `user_chapters` and the ledger) |
| C4.4 | Web, admin, mobile and shared dead code |
| C4.5 | **Backups**: `backup-verify.sh` + `restore-drill.yml` assert `user_books`/`user_chapters` and upload covers. Must merge before C5.3, or the drill fails (or passes on nothing) |

### Phase 5 — drop, behind a gate

| # | Issue | Done when | Rollback |
|---|---|---|---|
| C5.1 | **Pre-drop gate** checklist: no code reference (entities, DbSets, table names); the `pg_depend`/FK query shows the 19 tables referenced only among themselves + the §2.2 columns; ledger has no pair in a failed state; **the shim log meets the D8 criterion**; MCP stage 3 done; fresh C0.2 dump + tag | checklist signed on the issue | — |
| C5.2 | **`0018`** drops the §2.2 columns. Guard: refuses while `highlights`, vocabulary ×3, `word_clusters` or `book_insight` hold a non-NULL `edition_id` | roundtrip green | `migrate-down 17` + values from the dump |
| C5.3 | **`0019`** drops the 19 tables + ledger + trigger + 2 functions. Guard: refuses if an intent pair has no ledger row in `materialized`/`deleted`/`merged`. Down recreates the empty schema | roundtrip + drill green | down + restore the C0.2 dump |
| C5.4 | Delete catalog storage after the D9 delay | drill green | archive |
| C5.5 | Remove the shim (§7 exit criterion) | — | code revert |
| C5.6 | #946: `sites`, `site_domains`, `site_id` → 37 tables | — | per #946 |

## 6. Migration tests

Deterministic ids and conflict-skipping are necessary, not sufficient. C1.5–C1.8 ship with these,
running against a Testcontainers Postgres seeded from a fixture that mirrors production shapes: every
intent kind, guests, PDFs, a missing asset, a slug collision.

### 6.1 Test matrix

| # | Scenario | Expectation |
|---|---|---|
| T1 | **Interrupted run**: kill at each fault point (after the file copy, after the `user_books` insert, mid-chapters, mid re-point, between pairs; injected through a test hook) | rerun → the end state equals a clean run's (normalized dump of the affected tables + file tree hash); no orphan folder; no half pair visible |
| T2 | **Retry after partial completion**: N of M pairs done | done pairs untouched (`updated_at`, row hashes unchanged); the rest done |
| T3 | **Concurrent runs** (two jobs, and job vs shim on the same pair) | exactly one copy; the loser sees the ledger row and returns it |
| T4 | **Re-run idempotency**: the job k times | runs 2..k: 0 inserts, 0 re-points, 0 file writes |
| T5 | **Writes between runs**: the shim translates old-client writes; new clients write to the copy; then the job runs again | no duplicate; newer progress and the higher frontier win; sessions re-sent by old clients dedupe on `(user, user_book, started_at)` |
| T6 | **Revert after users create new data**: after the migration, add a highlight, bookmark, vocabulary word, insight, chapter review, collection entry and progress on the copy; rename it; delete another copy | revert: every row is back on the edition with correct catalog chapter ids, or listed in the revert report; **0 silent losses**; deleted copy not resurrected; rename reported as lost metadata; a later re-run gives the same state as before the revert |
| T7 | **Failure isolation**: a missing source asset, a storage write error, a slug collision | the failing pair rolls back and is reported; others finish; retry after the fix completes it |
| T8 | **Guest merge after migration** (both sides, one side) | one copy, all rows on it, ledger `merged` |
| T9 | **User deletes a copy**, then the job re-runs and an old client writes for that edition | nothing recreated; the shim answers per §7 |
| T10 | **Revert after a drop** | refused |

### 6.2 Validation script (C2.1; all must be 0 except reports)

1. **No duplicates**: a second run changes nothing; no duplicate `(user_id, source_edition_id)`.
2. **Completeness**: for every intent pair, a ledger row exists, and 0 rows remain with that
   `(user_id, edition_id)` in the re-pointed tables.
3. **Ownership**: every re-pointed or copied row's `user_id` = its `user_books.user_id`; collections too.
4. **Annotation targets**:
   - `user_chapter_id` belongs to the same book (FK `0016`);
   - every migrated highlight's `anchor_json` exact text is found in its chapter's `plain_text`;
   - chapter counts and `plain_text` hashes match per pair.
5. **Resume**:
   - the slug exists among the book's chapters;
   - `position_json`, percent, `completed_at` and frontier equal the source;
   - manual check: the owner + 2 accounts open a migrated book on web and Android and land on the same
     chapter and anchor.
6. **Provenance**: every migrated vocabulary row with a source `chapter_id` has the matching
   `chapter_slug`.
7. **Files**: every asset link in migrated html resolves; every cover exists; every copied original's
   sha256 equals its source.
8. **Stats**: per-user reading seconds, streaks and achievement count are unchanged.
9. **Guests**: the set `GuestCleanupWorker` would delete is unchanged.
10. **Reports** (not failures): pairs without an original file, session-only pairs (per D1),
    non-public-domain pairs.

## 7. Old-client writes

"Old client" means a build that still sends edition-keyed calls. Android builds since #743 can be forced
past it (`MOBILE_MIN_SUPPORTED_BUILD`); **iOS and Android before #743 cannot**, and builds ≤ 20 are on a
frozen runtime. Web reloads into the current bundle.

Old-client client-side behaviour, from the audit:
- sessions are queued, and every 4xx except 401/408/429 is **dropped silently**; 5xx is kept up to 6 days;
- progress has no queue: a failure is logged, and the device keeps it, unsynced;
- a highlight or bookmark failure shows a toast;
- vocabulary is retried 3× in memory, then fails visibly.

| Write (old client) | Shim, catalog live (C1.9 → C5.2) | After the drop, shim still on (C5.3 → C5.5) | Loss? |
|---|---|---|---|
| Progress `PUT /me/progress/{editionId}` | translated to the copy (chapter via `md5(user ‖ chapterId)`); pair not yet materialized → materialize first | translated if the copy exists; else 410 | **Server sync lost for a book never materialized**. The device keeps its position. Not visible to the user |
| Highlight create (`editionId`, `chapterId`) | translated / materialize first | translated; else 410 → toast "Could not add" | visible failure, not silent |
| Highlight update/delete (by id) | ids unchanged (rows re-pointed in place) | same | none |
| Bookmark create / delete | create translated to `user_book_bookmarks`; delete maps old id → `md5('bm' ‖ id)` and deletes both rows | translated; else 410 → rollback + toast | visible |
| Session `POST /me/reading/sessions` (`editionId`) | translated / materialize first | translated; else **accepted with no book** (201, the deleted-upload trail) | none: stats keep it |
| Vocabulary save (`editionId`, `chapterId`) | translated; `chapter_slug` from the chapter | translated; else **accepted with no book**, `book_title` kept | none; the chapter is lost only if unmappable |
| `POST /me/library/{editionId}` (save) | materialize | 410 (catalog gone) | visible |
| `DELETE /me/library/{editionId}` (unsave) | **no-op 204**. Old semantics removed only the shelf entry, never progress or annotations; deleting the copy would delete them | same | none |
| Collection add (`savedbook`) | mapped to the copy | mapped; else 404 | visible |
| Reads `/me/library`, `/me/progress` | empty catalog part for materialized users (no duplicate next to the copy, which old clients already list as an upload) | same | — |

**Compatibility is complete only while every old-client write is translated or accepted.** That holds
until the drop. After it, one silent loss case remains: server sync of progress for a book the user
first opened from an old offline download after their pairs were migrated.

Exit criteria:
- **C5.3 (drop)**: by D8, either the shim log shows zero 410s on progress for a set window, or this
  residual case is accepted explicitly.
- **C5.5 (shim off)**: every edition-keyed write becomes a 4xx, so old sessions are dropped silently.
  The shim is removed only when its log has been silent for the D8 window. Until then, those clients
  are counted as supported and nothing is called complete.

**Offline downloads**:
- **Mobile, new build**: C2.4 syncs, then deletes the catalog SQLite rows; the copy re-downloads (uploads
  are offline by default).
- **Mobile, old build**: catalog downloads keep opening from SQLite (the reader reads the device first
  and ignores a failed refresh); writes follow the table above.
- **Web**: C2.3 flushes, then drops the IndexedDB catalog stores.

## 8. MCP: capability parity and the transition

### 8.1 Parity scenarios

Parity is proven by scenarios, not by the tool count. They run as an over-the-wire suite
(`TextStack.Ai.Mcp.Tests`) against the migrated restored backup with a real OAuth grant, plus a
recorded manual session in the Claude connector. Each must pass at C2.2, at C3.2, and after each
transition stage.

| # | Scenario (what a reader does) | Must hold |
|---|---|---|
| S1 | "What am I reading?" | `get_my_reading` lists the migrated book with its progress |
| S2 | Open a chapter to discuss (id line `book <bookId>, chapter <slug>`) | `get_my_chapter` returns the same text the catalog chapter had (hash) |
| S3 | **Old id line from an old client** (`catalog <slug>` / `edition <id>`, chapter slug) | resolves to the caller's copy (stage 1–2) or a clear "use bookId X" error (stage 3); never another user's book |
| S4 | Earlier conclusions before discussing | `get_my_insights` (bookId) returns pre-migration insights |
| S5 | Save a conclusion | `save_insight` lands on the copy; visible in the app |
| S6 | Chapter review | `get_chapter_review` respects the migrated **frontier** (a chapter past it is spoiler-gated, one before it is not); `save_chapter_review` lands; earlier reviews returned |
| S7 | "Save these words" | `add_vocabulary_words` stores the book and **chapter slug**; `list_my_vocabulary` shows them |
| S8 | Highlights | `list_my_book_highlights` includes migrated highlights; `save_my_highlight` on a migrated chapter anchors correctly |
| S9 | Progress | `get_book_progress` / `set_book_progress` by bookId round-trip; the frontier never decreases |
| S10 | Search my library | `search_my_library` finds a phrase from a migrated book |
| S11 | **Authorization** | another user's bookId or editionId → not found; an unauthenticated `get_book`/`get_chapter` → "catalog retired" after stage 2 |

### 8.2 Transition for existing callers

Callers: the Claude connector (OAuth), ChatGPT (connect key), local stdio. They cache the tool list and
server instructions, and their conversations hold slugs and edition ids.

| Stage | When | Tools | Server instructions + manifest |
|---|---|---|---|
| 1 Alias | C2.2 | dual tools accept `editionId`/slug → the caller's copy; responses carry the `bookId` + a deprecation note. `get_book`/`get_chapter` for an authenticated caller who has a copy → that copy | stop recommending catalog tools; describe the id line as `book` only |
| 2 Deprecate | C3.2 | the 5 catalog tools stay listed and return a structured error naming the replacement tool and `bookId` | same |
| 3 Remove | after the D12 window, before C5.1 | 21 → 16; manifest + the 4 count tests (`McpManifestEndpointTests`, `McpStdioSmokeTests`, `McpOverTheWireTests`, `McpManifestDriftTests`) change together | `mcp.md`, CHANGELOG |

**V2 note**: `get_my_chapter` keeps reading server-side `user_chapters` in this interim. Under local
reading it becomes explicitly shared chapter context (separate ADR). These scenarios are the
acceptance suite for that change too.

## 9. Remaining gap to ≤ 20 (report only — not this slice)

39 after this slice (19 to go), 37 after #946 (17 to go). Candidates already marked *Decide* in
`data-model.md`, none of them decided:

| Candidate consolidation | Tables saved |
|---|---|
| `admin_users` + `admin_refresh_tokens` → `users` role | −2 |
| `password_reset_tokens`, `device_authorizations`, `oauth_authorization_requests` → one short-lived-code table | −2 |
| `mcp_access_keys` → `oauth_grants` | −1 |
| `pending_vocabulary_words` + `word_lookups` → states of `vocabulary_words` | −2 |
| `models` + `model_promotions` → config | −2 |
| `eval_runs` | −1 |
| `collections` + `book_collections` → `user_books.tags` | −2 |
| `user_book_bookmarks` → a `highlights` kind | −1 |
| `user_book_files`, `user_ingestion_jobs` → `user_books` columns | −2 |
| `reading_goals`, `admin_settings` → columns / config | −2 |
| **Total** | **−17** |

V2's local reading may remove `user_chapters` as well. Auth, vocabulary and model consolidation are
excluded from this slice by decision.

## 10. Open decisions

**Product (open):**

| # | Decision |
|---|---|
| D1 | Session-only pairs: leave the sessions attached to no book, or materialize the book? |
| D2 | Guests inactive more than 30 days: materialize, or leave them to cleanup? |
| D3 | Non-public-domain editions a user touched: materialize? |
| D4 | Standard Ebooks originals if the source folder is gone: re-fetch the EPUB by identifier from standardebooks.org (an outbound fetch), or no original file? |
| D5 | Old catalog URLs: 410, or 301 to the landing page? |
| D6 | Blog: none in the repo (About links outside) — keep the link, or build one? |
| D8 | Old-client policy: window length; is iOS in production; may the drop proceed with the residual progress-sync loss (§7)? |
| D12 | MCP deprecation window length |

**Operational (open):**

| # | Decision |
|---|---|
| D7 | Permanent archive location (outside restic) |
| D9 | Delete catalog storage after how many days? |
| D10 | `book_quality_jobs` edition rows: delete, or keep as history until the drop? |
| D11 | Vocabulary provenance key: `chapter_slug` (proposed; outlives server chapters), or an FK to `user_chapters`? |
| D13 | Accept the transitional ledger table (59 until the drop)? |
| D14 | Frontier maintained for all uploads (proposed; this changes today's spoiler gate for existing uploads). Confirm |
