# One parser = the client, A + TOC: audit and phases (ADR-033)

**Status:** approved by the owner 2026-11-17 (answers in [ADR-033](../../architecture/adr/ADR-033-client-is-the-only-parser.md)). P1 = #1426.

Paths: backend = `backend/src`, tests = `tests`. "Formats today" = what differs by format now.

## 0. Where the TOC lives (recommendation)

**The existing `book_files.toc jsonb` column** (baseline): already in `BookFileRequest`/`BookFileDto`, validated
as an opaque JSON array ≤ 256 KB (`SyncValidation.Toc`), never written by any client today. No storage migration.
- Shape (client-defined, server checks it): `[{ key, title, depth, fraction }]`, array order = reading order
  (index = the ordering number; titles shown, numbers never, CLAUDE.md rule). Keys = `chapters.mjs` `chapterKey`.
- Written: at import (the #1426 upload pass returns it) and by a new `PUT /me/v2/books/{id}/files/{fileId}/toc`
  (overwrite, unversioned: derived data; last writer wins).
- Read: `GET …/files/{fileId}/chapters` (kept, served from the column, same `ChapterHeadingDto`; wordCount null).
  Omitted from the library feed (feed rows stay small; clients have the file).
- Key checks become `EXISTS (SELECT FROM jsonb_array_elements(f.toc) e WHERE e->>'key' = @key)`.
- Rejected: a new `book_toc` table (a migration + repository for a few KB per file); `book_chapters` slimmed to
  titles (keeps a transitional table alive, rows per entry for no query that needs them).

## 1. Audit re-mapped

### Producer side
| Component | Today | Under A + TOC | Formats today |
|---|---|---|---|
| `LibraryContentService.EnqueueExtractionAsync` / `ReplayAsync` | enqueue job after `complete` | deleted (P4) | epub/pdf/html only |
| `V2IngestionService.ProcessAsync`, extractors DI in `Worker/Program.cs` | extract → `book_chapters` | deleted (P5) | three different splits |
| `V2IngestionService.SweepAsync` / `SweepOrphansAsync` | stale parts + orphan bytes | **kept**, moved to `RetentionCleanupWorker` (P2, first) | all |
| `V2IngestionWorker`, `WorkerRegistration` | loop: sweeps + jobs | deleted after the move (P5) | — |
| `TextStack.Extraction` (+ VersOne.Epub, PdfPig, PDFtoImage); unused ref in `Application.csproj` | parsers, pipeline, `BookTitleCleaner` | deleted (P5); title rules already in shared TS (P1) | EPUB, PDF, HTML |
| `TelemetryConstants` (`MeterName` from Extraction, `ingestion_jobs_*`) | metrics | own meter constant; ingestion metrics deleted | — |
| `ingestion_jobs`, `IIngestionJobRepository`, `FileIngestionJob` | queue + shelf status | dropped (P5 migration) | rows for 3 formats |

### Store and server readers
| Component | Today | Under A + TOC | Formats today |
|---|---|---|---|
| `book_chapters`, `IBookChapterRepository`, `BookChapterRepository`, `Domain/Transitional/BookChapter*` | chapter text | dropped (P5) | 3 formats |
| `ChapterReadService` + `GET …/chapters` | TOC + job status | reads `book_files.toc`; status gone | none for 4 formats |
| `GET …/chapters/{key}` | chapter html | deleted (P4) | — |
| `InsightSyncService` List/Save | order + title from `book_chapters`; unknown key → `ChapterNotFound` | from `toc`; unknown key → `ChapterNotFound`; toc not synced → see Q2 | MCP insights only on 3 formats |
| `AnnotationSyncService` + `AnnotationRepository` JOIN (`textstack-anchor-v1`) | key must exist in `book_chapters` | key must exist in `toc` | same |
| `ReadingSyncService` + `ReadingStateRepository` EXISTS, `TransitionalLocators` | `textstack-position-v1`/`anchor-v1` key must exist | same rule against `toc` (the reader reads such a position by fraction, #1187); `TransitionalLocators` keeps only `ChapterKeyOf` | same |
| `AccountMergeRepository(.Library/.Discussion)` | reparents both tables | those parts deleted (P5) | — |
| Library feed `ingestion`, `chapterCount`, `wordCount` (`LibraryRepository` subqueries, `BookFile`, `BookFileDto`) | shelf status + counts | `ingestion` + `wordCount` removed (P5, after clients stop reading them in P2); `chapterCount` = `jsonb_array_length(toc)` | missing → "Failed" for 4 formats |
| `ClipService` (html clip) | server extraction for MCP | nothing; reader writes the clip's TOC (`section-0`) on first open | html |
| `shared_chapters`, `DiscussionSyncService`, checkpoints | client text by client key | unchanged: the only book text the server holds | all text formats |

### MCP (`TextStack.Ai.Mcp`)
| Tool / part | Under A + TOC |
|---|---|
| `get_my_chapter` | **deleted**: `McpToolCatalog`, `McpManifest`, 4 count tests (17), `McpBridgeCore` instructions ("Read books with get_my_book / get_my_chapter"), `McpReadToolsTests`, `NativeIdentityApiTests`, `README`, `docs/reference/mcp.md`, `.claude/skills/operations/SKILL.md` |
| `get_my_book` | chapters from `GET …/chapters` (toc): key, order, title; status "Ready"; no word counts; says "ask the user to share a chapter" when asked for text |
| `save_insight` / `get_my_insights` | key checked against toc |
| `save_my_highlight` | finds chapter in toc; writes quote-only `textstack-anchor-v1` (shown as a quotation, never drawn) |
| `get_my_reading`, `get_book_progress` | chapter = position-v1 key, else toc entry at the state's fraction |
| `set_book_progress` | chapter → toc entry's `fraction` (Q6) |
| `share_chapter`, `get_shared_chapter`, checkpoints | unchanged |

### Clients
| Component | Under A + TOC |
|---|---|
| page `opened.toc` / `describe` | entries gain `key` + `fraction`; one builder for upload and open |
| shared `ingestionStatus`, `shelfFileSummary`, `v2Books` chapter cache, `getChapter` | status = file present; `getChapter` deleted; `getChapters` kept (book page list) |
| web `getV2UserBookChapter`, `UploadModal` polling, `UserBookCard`/`UploadBookListItem`/`BookActionMenu` status gates | chapter html path deleted; no polling; readable = has file (fixes 4-format "Failed") |
| mobile `my-books/[id]`, `ResumeButton`, `bookRoutes`, `useBookOffline`, `autoDownloadPolicy` | status = file present; chapters from toc list |
| mobile `DownloadContext` chapter cache + `offlineDb` chapter tables (+ `.web.ts` twin) | deleted: reading uses the retained file |

### Tests and docs
Extraction.Tests (move `Fixtures/frankenstein.epub` first: `docs/start/run-3-open-a-book.md` names it), UnitTests
(`TextProcessingTests`, `V2IngestionWorkerTests`, `ChapterReadServiceTests`, `LibraryContentServiceTests`, `V2Fakes`),
Persistence (`BookChapterRepositoryTests`, `IngestionJobRepositoryTests`, `MergeReparentTests`), Integration
(`V2ContentEndpointTests`, `V2FeedEndpointTests`, `V2TransitionalLocatorEndpointTests`, `V2ApiFixture`), e2e
`v2-sync.spec.ts` (waits for worker chapters) and CI "Extraction tests" step. Docs: CLAUDE.md (Worker line,
libraries, test list, "Extraction Pipeline", "MCP has 18 tools" rule), `architecture/index.md`, `backend/CLAUDE.md`
(key files, "Extraction"), `guides/testing.md`, `v2-sync-protocol.md` (toc writer), `m6-deletion-plan.md` D8, ADR-012/031/032.

## 2. Phases

### P1: #1426 metadata (as planned)
Title rules → page `describe` → web upload → backfill on open → Android upload. The `describe` builder emits the
TOC from the start (unused until P3). Risks: PDF cover cost, staging race, page budget. Rollback: revert per PR.

### P2: keep the sweeps, stop depending on extraction status (no behaviour loss)
1. Move `SweepAsync` / `SweepOrphansAsync` into `RetentionCleanupWorker` (+ its test); the ingestion worker keeps only jobs.
2. Clients: shelf/card/mobile status = file present; `UploadModal` stops polling; mobile chapter cache + `offlineDb` chapter tables deleted (twin kept in step).
Risks: a sweep interval changed by the move (keep 1 min / daily); mobile JS change → OTA. Rollback: revert; the worker still owns everything.

### P3: TOC sync
1. Page/`chapters.mjs`: TOC entries `{key, title, depth, fraction}`; shared `tocForServer` (fits 256 KB: deepest levels dropped first).
2. Server: `PUT …/files/{fileId}/toc` (shape check: keys ≤ 200, titles ≤ 500, fraction 0–1); `GET …/chapters` served from `toc` when present, else `book_chapters` (transition); toc omitted from the feed.
3. Hosts: import carries the TOC (upload pass); on open, PUT when the server's TOC is missing (one GET + one PUT, never on the reading path).
Risks: a 5,000-entry TOC over 256 KB (trim); stale keys after a fork bump changes the rule (overwrite on open). Rollback: revert; column back to null, `book_chapters` still serves.

### P4: switch the consumers
1. Key checks (Insight, Annotation, ReadingState SQL) against `toc` (Q2 for a missing TOC).
2. MCP: delete `get_my_chapter` (17; manifest, 4 tests, bridge text, docs); `get_my_book`, `save_my_highlight`, `get_my_reading`, `get_book_progress`, `set_book_progress` on the TOC.
3. Delete `GET …/chapters/{key}` and its shared/web callers; stop the enqueue.
Risks: old insights/highlights under server keys unlinked (Q3); assistant prompts that relied on reading. Rollback: revert; tables still full.

### P5: delete
1. Backup (`make backup`), then delete `V2IngestionService/Worker`, job and chapter repositories/domain, `TransitionalLocators` remnants, metrics, merge parts, feed `ingestion`/`wordCount`, their tests.
2. Delete `TextStack.Extraction` + tests + package refs + CI step; move the fixture; docs and CLAUDE.md.
3. Migration `NNNN_drop_book_chapters_and_ingestion_jobs` (down recreates both empty); comment on `book_files.toc`.
Order: code first, schema last. Risks: text gone for good (backup); a route snapshot or count test missed. Rollback: `make migrate-down` (schema first), revert code, re-enqueue script; restore from backup for old text.
