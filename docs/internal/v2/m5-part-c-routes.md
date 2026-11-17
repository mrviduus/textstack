# M5.1 Part C: pending routes and MCP tools

> **Historical (M6 done 2026-11-17).** The V2 program is finished: one database (`textstack_v2`), the V2 reader only, legacy dropped. Kept as the decision trail; current state: [`docs/STATUS.md`](../../STATUS.md).

Status: Inventory done; owner cut decided 2026-11-16 ([below](#owner-decision-2026-11-16)), shipping as stacked PRs. Part of [#1031](https://github.com/mrviduus/textstack/issues/1031),
[#1346](https://github.com/mrviduus/textstack/issues/1346). Base: Part B (#1363).

Before Part C, in `Database:Mode=v2`, `SelectedDatabaseGuard` answered 503 `v2_compatibility_pending` for every route under
`/me` or `/admin`, and every non-GET route, without `V2SelectedRoute`. Read from the Api's own
`EndpointDataSource` (as `ApiRouteTable`), Test environment, `Features:V2Api` off: **229 routes**.
`/me/v2/*` is marked and not counted. Public GETs (catalog, search, TTS) are not gated: they keep reading
the read-only legacy catalog until M6.

Callers were found by grepping `apps/web/src`, `apps/mobile/{src,app}`, `packages/shared/src` for the path,
then checking whether the call site branches to `/me/v2` (`onV2()`, `v2Enabled()`) or is hidden by
`V2_FEATURES` (`packages/shared/src/api/v2.ts`).

Classes:
- **(a)** called by the new web/Android clients with V2 on → must work on V2.
- **(b) map**: old builds only; same ids (`books.id = user_books.id`) → shim onto an existing V2 service.
- **(b) 410**: old builds only; no V2 counterpart, or catalog-keyed → 410, log `X-App-Version` + route + outcome.
- **(c)**: retire → 410 (no caller, deferred, catalog, or admin catalog tooling).

## Counts

| Class | Routes | Non-trivial ports |
|------|------:|------|
| (a) end-user clients | 31 | ~14 (below) |
| (a) admin panel | 30 | ~5 (AI quality, user uploads, ingestion, settings on V2 tables) |
| (b) map | 25 | 0 new logic; adapters onto `/me/v2` services |
| (b) 410 | 43 | 0 |
| (c) retire | 100 | 0 |
| MCP tools needing a V2 path | 14 of 25 | ~8 bridge ports + 1 new V2 endpoint set (insights) |

Over the ~8-port budget: the owner cut the scope ([decision](#owner-decision-2026-11-16)).

## (a) End-user clients, V2 on (31)

| Route | Caller | Class | V2 target |
|------|------|------|------|
| GET /me/reading/stats, GET /me/reading/stats/daily | web `useReadingStats`, `useQuickStats`; mobile `stats/index`, `useQuickStats` | (a) | port: aggregate `reading_sessions` |
| GET /me/reading/pace | web+mobile `useReadingPace` | (a) | port: `reading_sessions` (`V2PaceTotals` already sums V2 sessions; legacy part goes) |
| GET /me/reading/library-summary | web `useLibraryStatsSummary` | (a) | port: `books` + `reading_state` + `reading_sessions` |
| GET /me/reading/book-stats | web `useBookStats`; mobile stats | (a) | port, partial: V2 books have no genres/catalog authors. Or hide + 410 |
| GET/POST /me/reading/goals, DELETE /me/reading/goals/{id} | web `useReadingGoals`; mobile stats, `useQuickStats` | (a) | **no V2 table**: new migration + repo, or hide + 410 |
| GET /me/reading/achievements | web `useAchievements`; mobile stats | (a) | **no V2 table**: hide + 410, or new table |
| GET /me/vocabulary/stats, GET /me/vocabulary/stats/daily | web `useVocabulary`, `useVocabDailyStats`, `useQuickStats`, VocabularyPage | (a) | port: `vocabulary_words` + `vocabulary_reviews` |
| GET/PUT /me/vocabulary/settings | web+mobile `VocabSettingsModal`; mobile `vocabulary/review` | (a) | **no V2 table**: hide + 410 or a column on `users` |
| GET /me/vocabulary/pending, DELETE …/pending/{id}, POST …/pending/{id}/promote | web `PendingQueueList`; mobile vocabulary tab | (a) | **no V2 table**: hide + 410 |
| GET /me/vocabulary/lookups, DELETE …/lookups/{id}, POST …/lookups/{id}/promote | web `LookupHistoryList`; mobile vocabulary tab | (a) | **no V2 table**: hide + 410 |
| GET /me/vocabulary/concepts | web `ConceptsSection` (stats) | (a) | no V2 clusters (ADR-031 D6): hide + 410 |
| PUT /me/vocabulary/words/{id}/known | web `useV2ReaderVocabulary`, `useReaderVocabulary`; mobile reader | (a)? | `V2_FEATURES.markAsKnown=false`; verify hidden, else hide + 410 |
| GET /me/highlights/all | web HighlightsPage; mobile highlights screen | (a) | port: `annotations` across books (+ book titles) |
| GET/POST /me/highlights/review | web HighlightReviewPage | (a) | no V2 review columns: hide + 410, or port |
| GET /me/library/shelves | web `useLibraryShelves` (home); MCP `get_my_reading` | (a) | port: `books` + `reading_state` |
| GET/POST /me/insights, DELETE /me/insights/{id} | MCP `get_my_insights` / `save_insight` (web hides: `insights=false`) | (a) | port: `book_insight` table exists, no repo/endpoint: new `/me/v2` routes |
| POST /explain, POST /translate, POST /api/translate | V2 reader popups (web `V2ReaderPopups`, mobile `V2ReaderScreen`) | (a) | port: paid AI on V2 identity + `llm_traces` spend (Part B note: do not mark the legacy handler) |

## (a) Admin panel (30)

| Route | Caller | Class | V2 target |
|------|------|------|------|
| /admin/ai-quality/* (18: agent-runs, budgets, drift, evals*, models*, summary, traces*, enrichment/tutor eval) | admin AI Quality | (a)-admin | port to V2 `llm_traces`, `agent_run`, `eval_runs`; or 410 the eval runners (legacy-only data) |
| GET/PUT /admin/settings/session | admin Settings | (a)-admin | V2 `admin_settings` |
| POST /admin/diagnostics/sentry-test, …/sentry-test-error | admin Tools | (a)-admin | no DB: mark `V2SelectedRoute` |
| GET /admin/user-uploads, …/stats, DELETE …/{id}, POST …/{id}/takedown | admin User Uploads | (a)-admin | V2 `books`/`book_files` |
| GET /admin/ingestion/jobs, …/{id}, …/{id}/preview, POST …/{id}/retry | admin Jobs | (a)-admin | V2 `ingestion_jobs` |

## (b) Old builds: map 1:1 (25)

New clients branch these to `/me/v2` (`apps/web/src/api/userBooks.ts`, `vocabulary.ts`, `lib/highlightSync.ts`,
`apps/mobile/src/lib/userBooksApi.ts`). The shim answers the legacy shape from the V2 service.

| Route | Caller | Class | V2 target |
|------|------|------|------|
| GET /me/books/, GET /me/books/{id} | old builds | (b) map | `LibrarySyncService` feed |
| DELETE /me/books/{id}, POST /me/books/bulk/delete | old builds | (b) map | `LibrarySyncService` delete (per id) |
| POST/DELETE /me/books/{id}/complete, POST /me/books/bulk/finish | old builds | (b) map | `PATCH /me/v2/books/{id}` (finished) |
| GET/PUT /me/books/{id}/progress | old builds | (b) map | `ReadingSyncService` reading-state (locator mapping as web `readV2Progress`/`saveV2Progress`) |
| GET /me/books/{id}/chapters/{slug} | old builds | (b) map | `ChapterReadService` (slug → chapter key) |
| GET /me/books/{id}/file | old builds | (b) map | `LibraryContentService` current file |
| PUT /me/books/{id}/read | old builds | (b) map | 204 no-op (reading-state carries "opened") |
| POST /me/reading/sessions | old builds (web beacon off on V2) | (b) map | `ReadingSyncService` session (new client session id) |
| POST/GET/DELETE /me/vocabulary/words, GET …/words/reader, DELETE/PATCH …/words/{id}, GET/POST /me/vocabulary/review | old builds | (b) map | `VocabularySyncService` (as shared `createV2Vocabulary`) |
| POST /me/highlights (userBookId), PUT/DELETE /me/highlights/{id}, GET /me/highlights/userbook/{id} | old builds | (b) map | `AnnotationSyncService` (editionId body → 410) |

## (b) Old builds: 410 (43)

| Route | Caller | Class | V2 target |
|------|------|------|------|
| /me/bookmarks (GET, POST, GET {editionId}, DELETE {id}) | old builds, catalog reader | (b) 410 | catalog retired |
| /me/progress (GET, GET/PUT/DELETE {editionId}) | old builds, catalog reader | (b) 410 | catalog retired |
| GET /me/library, POST/DELETE /me/library/{editionId}, GET /me/highlights/{editionId} | old builds, catalog | (b) 410 | catalog retired |
| GET/POST /me/books/{id}/bookmarks, DELETE …/bookmarks/{bookmarkId} | old builds (V2 returns [] client-side) | (b) 410 | no V2 bookmarks (ADR-031 D6) |
| POST /me/books/upload, PUT …/uploads/{id}/parts/{i}, POST …/uploads/{id}/complete, DELETE …/uploads/{id} | old builds | (b) 410 | V2 upload protocol only |
| POST /me/books/clip | old builds / extension | (b) 410 | no V2 clips |
| GET /me/books/quota | old builds (web throws 404 on V2) | (b) 410 | quota only in 413 |
| GET /me/books/{id}/assets/{assetId} | old reader images | (b) 410 | V2 reader reads the file |
| POST …/{id}/cancel, …/retry, …/enrich, PUT …/metadata, …/tags, POST …/suggested-tags/accept, …/dismiss, GET …/stats | old builds (hidden by `V2_FEATURES`) | (b) 410 | no V2 feature |
| POST /me/books/bulk/tags, …/bulk/collection/{id}/add, …/remove | old builds | (b) 410 | no tags/collections |
| /me/library/collections (7 routes), GET /me/library/tags, GET /me/library/search | old builds (hidden) | (b) 410 | no collections/tags/content search |
| POST /me/vocabulary/words/{id}/unretire | no caller found | (b) 410 | no retired stage |

## (c) Retire (100)

| Route | Caller | Class | V2 target |
|------|------|------|------|
| GET/PUT /me/chapter-review | web `useBookReviews`, mobile; MCP | (c) 410 | deferred (#1345); content stays in legacy |
| GET /me/review-questions/due, POST …/{id}/answer | web `reviewQuestions` | (c) 410 | deferred with #1345 |
| POST /me/tutor/session, …/{id}/answer, …/{id}/feedback | hidden (`tutor=false`) | (c) 410 | no V2 tutor |
| GET /me/vocabulary/clusters, POST …/{id}/complete, …/dismiss, …/start-bonus | hidden (`clusters=false`) | (c) 410 | no V2 clusters |
| GET /me/reading/sessions | no caller | (c) 410 | — |
| /internal/* mutations (13: editions chapters/merge/publish, featured, quality-jobs, seo jobs, ssg rebuild, user-books chapters) | worker, ssg-worker, admin chapter editor | (c) 410 | catalog frozen; V2 chapters are derived |
| /admin catalog tooling (75: authors, genres, editions, chapters, autopublish, seo, ssg, quality, import, reimport, reprocess, restore, sync, books/upload, stats) | admin | (c) 410 | legacy DB read-only; retires at M6 |

## MCP tools (25)

The bridge (`backend/src/Ai/TextStack.Ai.Mcp`) calls the Api over HTTP with the user's token; descriptions
in `Contracts/Mcp/McpManifest.cs`. `TEXTSTACK_MCP_V2` already moves vocabulary and the discussion tools to
`/me/v2`; it must be on in v2 mode.

| Tool | Reads/writes today | Class | V2 target |
|------|------|------|------|
| search_books, get_book, get_chapter | public catalog GETs | works | legacy catalog (read-only) until M6 |
| list_my_vocabulary, add_vocabulary_words, update_vocabulary_word, delete_vocabulary_word | `/me/v2/vocabulary/*` (flag on) | works | — |
| share_chapter, get_shared_chapter, save_checkpoint, list_checkpoints | `/me/v2` shares/checkpoints | works | — |
| get_my_book | GET /me/books/{id} | port | library feed + `…/files/{fileId}/chapters` (no single-book GET on `/me/v2`) |
| get_my_chapter | GET /me/books/{id}/chapters/{slug} | port | `…/files/{fileId}/chapters/{chapterKey}` |
| search_my_library | GET /me/library/search | port | title/author over the library feed (no V2 content search) |
| get_my_reading | GET /me/library/shelves + GET /me/books | port | library + reading feeds |
| get_book_progress, set_book_progress | /me/books/{id}/progress (edition: /me/progress) | port | `…/reading-state` GET/PUT; edition branch → "catalog retired" error |
| list_my_book_highlights | GET /me/highlights/userbook/{id} | port | annotations feed, filtered by book |
| save_my_highlight | POST /me/highlights | port | PUT `/me/v2/annotations/{id}` (text-quote → V2 locator) |
| get_my_insights, save_insight | /me/insights | port + new server | `book_insight`: new repo + `/me/v2` routes |
| list_my_highlights, save_highlight | edition-keyed /me/highlights | retire | tool answers "catalog retired" (count kept) |
| get_chapter_review, save_chapter_review | /me/chapter-review | retire | answers "deferred" (#1345) (count kept) |

## Owner decision (2026-11-16)

The class columns above are the inventory; this is what v2 mode does. Scope cut (v2-plan D6 + Q3): simpler
architecture, **no new tables**.

| Decision | Routes | Where |
|------|------|------|
| **Port**: all-highlights list | GET /me/highlights/all on `annotations` | stacked PR 2 |
| **Port** with V2 spend (guest/user limits, existing V2 tables only) | POST /explain, /translate, /api/translate | stacked PR 3 |
| **Port**: MCP | bridge ports (table above) + `/me/v2` insights on `book_insight` | stacked PR 4 |
| **Port**: new clips | POST /me/books/clip writes a V2 book with one `html` file (same path, extension unchanged) | stacked PR 5 |
| **410 + hide** (UI hidden by a separate frontend change; data stays in legacy, archived) | reading stats/daily/pace/library-summary, vocabulary stats/daily, shelves (retired, Q3), goals, achievements, book-stats, vocabulary settings/pending/lookups/concepts, mark-as-known, highlight review | PR 1 |
| **410, logged** (old builds; no 1:1 map, the owner updates devices first) | every (b) route, map and 410 alike | PR 1 |
| **410** (retire) | every (c) route, incl. chapter review (#1345 deferred); its MCP tools answer an error, tool count unchanged | PR 1 |
| **410** until after M5 | admin AI Quality, User Uploads, ingestion, settings, catalog tooling | PR 1 |

**Mechanism** (`SelectedDatabaseGuard`): in v2 mode a private route or a write without `V2SelectedRoute` answers
410 `{"error":"gone_in_v2"}`, logged at Information as `Gone in V2: {Route} from app {AppVersion}, outcome 410`
(`X-App-Version`; `none` when absent). The ported routes are mapped only in v2 mode by `V2CompatEndpoints`, on
the legacy path and shape, marked and ordered ahead of the legacy handler (`WithOrder(-1)`). While the stack landed,
a `Pending` table in the guard kept the routes not yet ported at 503 `v2_compatibility_pending`; PR 5 emptied and
removed it. Legacy mode is unchanged: neither the guard nor `V2CompatEndpoints` is in its pipeline.

What the ports do:
- **All-highlights:** live annotations in live books, the legacy shape; no covers, `bookType=edition` lists none.
- **Explain / translate:** anonymous as legacy, genre from the caller's V2 book, explain tools off (they read the
  catalog). The daily AI budgets seed from V2 `llm_traces` (`ILlmSpendSource`); per-IP rate limits unchanged.
- **MCP** (`TEXTSTACK_MCP_V2` on): the my-library, progress, reading and insight tools read and write `/me/v2`;
  new `GET/POST /me/v2/books/{id}/insights`. Edition and chapter-review tools answer an error (their routes 410).
- **Clips:** `POST /me/books/clip` imports a V2 book (origin `{kind: clip, sourceUrl}`) and stores the page as its one
  `html` file through the V2 part + complete (V2 quota), and queues its chapter extraction (the html extractor) for the
  assistant tools; the V2 reader reads the page itself. The same page again is the book that holds it (its bytes stored
  if an earlier attempt stopped short). A refusal is legacy's `{error: message}`, 413 for the storage limit, else 400.
  Accepted gap: the extension's recent-clips list (`GET /me/books?shelf=readlater`) and its delete (`DELETE
  /me/books/{id}`) answer 410 in v2 mode; clips are read and removed from the library instead.
