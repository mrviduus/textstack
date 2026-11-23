# ADR-033 — The client is the only parser; the server keeps no book text

**Status:** Accepted (owner, 2026-11-17: option A + TOC) · **Date:** 2026-11-17 · **Plan:** [one-parser-plan.md](../../internal/v2/one-parser-plan.md) · **Amends:** [ADR-031](ADR-031-v2-schema.md) (its 2026-11-17 D8 amendment: the replacement exists; `book_chapters` and `ingestion_jobs` are dropped; `book_files.toc` gets a writer), [ADR-032](ADR-032-one-engine-foliate-fork.md) (Decision 5 and its wave-18 amendment "html clips are extracted server-side") · **Supersedes:** [ADR-012](ADR-012-pdf-original-first-lazy-parse.md) (server-side lazy PDF parse for AI) · **Keeps:** ADR-029 (sandbox), ADR-016 (a review lives in its `BookInsight`, by chapter key), ADR-019, ADR-031 locator schemes · **Implementation:** #1426 (P1), one issue per later phase

## Context

V2 has **two parsers that disagree** about one file:

1. **The reader** (ADR-032): our foliate-js fork in the sandboxed page reads EPUB, MOBI, AZW3, FB2, CBZ and PDF.
   Its TOC and chapter rule (`chapters.mjs`, keys `toc-N` / `section-N`) are what the reader shows and what
   "Discuss this chapter" shares (`share_chapter` → `shared_chapters` → `get_shared_chapter`, #1316).
2. **The server** (`TextStack.Extraction` run by `V2IngestionWorker`) reads **EPUB and PDF only** (plus html clips)
   into `book_chapters`, with its own split, keys (slug or `ch-N`), titles and text pipeline. MOBI, AZW3, FB2 and
   CBZ have no chapters for the assistant, and the web shelf shows them as "Failed".

An insight the assistant saves names a server chapter the reader does not know; a chapter the reader shares is not
one the server lists. M6 decision D8 kept the tables until a replacement for their readers exists.

## Decision

1. **The client is the only parser.** A book file is parsed only by the foliate fork in the sandboxed reader page.
   The server stores bytes and checks size, SHA-256 and a cover's magic bytes. It never opens a book.
2. **The server keeps no book text.** The assistant reads a chapter only when the reader shares it, through the
   existing Discuss path. `get_my_chapter` is deleted (MCP: 18 → 17 tools).
3. **The reader syncs the table of contents** of each file version: entries `{key, title, depth, fraction}` in
   reading order, keys by the `chapters.mjs` rule, a few KB, capped at 256 KB. It is stored in the existing
   `book_files.toc` column. The assistant lists chapters from it (`get_my_book`) and asks the user to share one.
   Chapter keys the server accepts (insights, assistant highlights, assistant positions) are checked against it.
4. **Metadata (#1426) is the client's**: read in the sandbox, it reaches the server only through sync.
5. **The book never depends on the server.** Reading, the TOC and Discuss's own text work offline from the file;
   sync stays optional. A book never synced is simply unknown to the assistant.
6. **Deleted:** the extraction worker and `ingestion_jobs`, `book_chapters` and its text, the `TextStack.Extraction`
   library and its tests. The worker's file sweeps (stale parts, orphan bytes) are kept and move to
   `RetentionCleanupWorker`.

## Owner answers (2026-11-17)

- The TOC lives in the existing `book_files.toc` column; it is not in the library feed (served per book).
- A chapter key for a book whose TOC has not synced is refused ("open the book once").
- Insights, highlights and positions saved under the server's old keys stay on their book, unlinked from a chapter.
- Android sends the TOC directly when a book opens online; offline, on a later open.
- `set_book_progress` maps a chapter to its TOC entry's fraction.
- `book_chapters` text is dropped in the last phase, after a backup.
- A clip's TOC is written by the reader on first open.
- No "share the whole book" for now; revisit after the build is tested.

## Consequences

**Positive**
- One parser, one chapter rule: the reader, shares, insights and the assistant use the same keys.
- All six formats have a TOC for the assistant; no format shows "Failed" for want of extraction.
- No book text on the server beyond what the user chose to share: less to store, export, delete and leak.
- The worker loses every parser and its native image stack; the extraction queue, retries and metrics go.

**Costs**
- **The assistant cannot read on its own.** Without a share it knows titles only; summaries of unshared
  chapters need the user to share them.
- **TOC only after a client.** A book is listed with chapters after the reader (or the upload pass) syncs its TOC.
- **Key change.** Insights, assistant highlights and positions saved under server keys (slug, `ch-N`) lose their
  chapter link (prod has one user).
- **A text-less TOC** cannot tell a chapter's length; the assistant sees titles and fractions, no word counts.

## Alternatives considered

- **B. The client pushes every chapter's text** (an earlier draft). Rejected: the server stores whole books again;
  a 2,500-page PDF costs minutes of client CPU and a stream of bridge messages; resumable state on two ends; and
  the assistant rarely needs a chapter the user has not chosen to discuss.
- **C. Headless foliate on the server** (Node or a browser in the worker). Rejected: one rule, but a browser in the
  backend, a second sandbox, CPU on the one small server, and it still keeps book text there.
- **D. Status quo** (server EPUB/PDF extraction, client for the rest). Rejected: two parsers and two key spaces
  forever, four formats invisible to the assistant, and book files still parsed on the server.

## Rollback

- **Until `book_chapters` is dropped:** revert the switch PRs; the enqueue comes back, the worker re-extracts.
- **After the drop:** `make migrate-down` recreates the tables empty (schema first, then the code revert); a
  one-off script enqueues every current EPUB/PDF file. A backup is taken before the drop.

## Done

P5 (#1525): the extraction worker, `TextStack.Extraction`, `book_chapters` and `ingestion_jobs` are deleted
(migration `0010_drop_book_chapters_and_ingestion_jobs`).
