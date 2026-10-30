# ADR-027 — Retire the public catalog (interim migration)

**Status:** Proposed — deferred into V2 (owner, 2026-10-28); no interim migration. · **Date:** 2026-10-28 · **Issues:** [#992](https://github.com/mrviduus/textstack/issues/992),
[#926](https://github.com/mrviduus/textstack/issues/926) · **Plan:** [catalog-retirement-plan.md](../catalog-retirement-plan.md)
· **Supersedes:** the 2026-10-26 "catalog kept" decision of the database cleanup; the SSG parts of
[ADR-023](ADR-023-single-instance-no-fire-and-forget.md)'s amendment

> **Deferred research proposal:** the interim migration below is not scheduled. The catalog stays frozen while the [V2 target model](../v2-target-model.md) is discussed.
>
> **Original proposed scope: an interim migration, not the V2 architecture.** This ADR removes the public catalog and
> moves the user data attached to it into the personal library as it exists today. Server-side
> `user_chapters` are **transitional**. The V2 target is local reading, where the device holds the book
> and MCP sees only chapter context the reader explicitly shares. That target needs its own ADR. Nothing
> here may deepen the dependency on server-held chapter text: new provenance is keyed by chapter
> **slug** and chapter **number**, not by `user_chapters.id`.

## Context

TextStack runs two products on one schema:

1. **A public catalog**: 1,433 admin-curated editions (40,722 chapters, 2.6 GB — the largest table), author
   and genre pages, an LLM SEO pipeline (auto publish, SEO backfill, crews), a prerender worker (SSG),
   sitemaps, IndexNow, and host pollers that drive them.
2. **A personal library**: a reader's own uploads (`user_books` …), read in the same reader, synced
   offline-first, reachable from the reader's assistant over MCP.

The catalog does not pay for itself. Search Console, 90 days to 2026-10-25: 6 clicks, 295 impressions
(#992). It costs ~4k lines of SSG, ~4.5k backend lines of SEO + crews (+3.1k tests), ~270 lines of
`deploy.yml`, ~140 lines of nginx, ~75 lines of health checks, four host pollers, 16 admin pages, four
incidents since 2026-08-11, and 21 of the 58 server tables. The SSG has been frozen since #993.

Readers did use it. Catalog books carry their data: saved books, progress (with a monotonic
furthest-read chapter), bookmarks, highlights, reading sessions, vocabulary (with the chapter a word came
from), assistant insights and chapter reviews, collections. Some of it belongs to books the reader never
saved (a highlight, a looked-up word). That data must survive **without silent loss**.

External book discovery (e.g. an OPDS feed) is a different feature and is out of scope.

## Decision

1. **The public catalog is retired**: catalog publication, ingestion, SEO, SSG, sitemaps, the public book,
   author, genre and search pages, the catalog half of the reader, and the catalog MCP tools.
2. **Personal import and reading stay** and become the only reading model for this interim period:
   `user_books` + `user_chapters` + `user_book_files` + `user_book_bookmarks`, with progress on `user_books`.
3. **Every catalog book a user touched becomes that user's personal book** ("materialized"). That means:
   - a `user_books` row with `source_edition_id`;
   - its chapters copied to `user_chapters`;
   - its cover and inline images copied;
   - **its original source file copied to `user_book_files`** wherever one exists (§5);
   - every user row re-pointed to it.

   "Touched" = any **intent** row: `user_libraries`, `reading_progresses`, `bookmarks`, `highlights`,
   `vocabulary_words`, `pending_vocabulary_words`, `word_lookups`, `word_clusters`, `book_insight`, or a
   `savedbook` in `book_collections`. Session-only pairs are an open decision (plan §10, D1).
   Materialized books never count against `MaxBooks` or `StorageUsedBytes` (Guest `MaxBooks` = 1).
4. **Nothing the reader built is dropped by default.** These are preserved explicitly:
   - **Furthest-read frontier**: new `user_books.progress_max_chapter_number`, copied from
     `reading_progresses.max_chapter_number`. From then on it is maintained monotonically for *all*
     uploads, as catalog progress already is. Otherwise the copied value would freeze, and
     `ChapterFrontier` would trust a stale maximum.
   - **Vocabulary chapter provenance**: new `chapter_slug` on `vocabulary_words`,
     `pending_vocabulary_words` and `word_lookups`, filled from the catalog chapter. Slug, not a
     `user_chapters` FK, so it outlives server chapters (the same choice as `book_insight.chapter_slug`).
   - **Original files**: §5.
5. **Source files.** Each source is inventoried and preserved where it exists:
   - admin-uploaded originals in `book_files` (EPUB and **PDF**) → `user_book_files`, with `sha256` and
     `file_size` computed. That gives PDFs their original-first layout, a "download original", and the
     re-attach trail of #983.
   - Standard Ebooks imports (`text_stack_imports`, 1,409) were built from a host source folder
     (`TextStack:WatchPath`), not from storage. Whether that folder still exists is checked in step
     C0.1. How to fill the gap if it does not is an open decision (D4).
6. **The migration is a resumable, ledgered job, not a schema migration**:
   - A transitional table `catalog_materializations(user_id, edition_id, user_book_id, state, …)` is the
     ledger. It records each pair as materialized, reverted or deleted-by-user. It is the idempotency
     key, the revert map, the guard against resurrecting a book the user deleted, and the audit trail.
     It is dropped with the catalog tables.
   - Each pair runs under a per-pair advisory lock in one transaction. Files are copied to deterministic
     paths before the commit, and leftovers from an interrupted run are cleaned on the next run.
   - Catalog-only rows (`user_libraries`, `reading_progresses`, `bookmarks`) are **copied**, and stay
     intact until the drop, so a revert can restore them.
   - Shared rows (highlights, sessions, vocabulary, insights, collections) are **re-pointed**, because
     their CHECKs allow one owner. A revert re-points them back, including rows users created after the
     migration.
   - The job is proven by fault-injection, retry, concurrency and revert-after-new-data tests (plan §6),
     not by deterministic ids alone.
7. **Old clients are handled per write type, with every loss case named** (plan §7):
   - An edition-keyed write is translated to the materialized book. Before the drop, a write for an
     unmaterialized pair materializes that pair first.
   - A write that cannot be mapped is **accepted without a book** where the table allows it (sessions,
     vocabulary), so it is never answered with a 4xx that a client queue drops.
   - It is answered with a **visible** error where the client shows one (highlights, bookmarks).
   - The remaining loss case is server sync of progress for a book that was never materialized, after
     the drop. Compatibility is **not** called complete while a supported client can still hit it. The
     catalog drop is gated on telemetry or on an explicit decision (D8).
8. **MCP keeps reading and discussion working**, proven by end-to-end scenarios run against migrated
   data, not by tool counts (plan §8):
   - the upload-backed tools serve migrated books;
   - existing callers get a dated transition: alias, then deprecate with a pointer, then remove;
   - the five catalog tools go last (21 → 16).
9. **Order**: one reviewable issue per step.
   1. Verified backup.
   2. Additive schema and the job.
   3. Validate the data, then update clients.
   4. Disable publication and SEO jobs.
   5. Retire code.
   6. Drop the tables, last, only after the dependency, code-reference and client-compatibility gate.

   Before any drop: a git tag and a permanent dump kept outside restic retention.
10. **A simple landing page** replaces the catalog home page. Static pages stay. Open decisions: where
   the blog lives (D6), and whether catalog URLs answer 410 or 301 (D5).

**Table milestones:** 58 today → 59 while the ledger exists → **39** after this slice drops 19 catalog
tables and the ledger → **37** after `sites` + `site_domains` go with #946. V2 target ≤ 20.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep the catalog, freeze SEO/SSG** (status quo after #993) | Keeps 19 tables, ingestion and admin surfaces, and a second reading model everyone maintains |
| **Keep catalog content as hidden shared storage** (personal rows reference shared `editions`/`chapters`) | Stores each book once, but keeps two reading models, dual APIs and dual MCP tools, and it adds a server-content dependency that V2 moves away from |
| **Export data and ask readers to re-upload** | Breaks annotation targets unless the re-upload is matched. Most catalog books were imports the reader has no file for |
| **Materialize per user (chosen)** | Duplicates content per reader for touched books only (measured in C0.1). One model; data keeps its meaning without the catalog. Interim: the server copies go away with V2's local reading |
| **Materialize with deterministic ids only, no ledger** | Cannot tell "never materialized" from "the user deleted it", so a re-run or an old-client write would resurrect deleted books. A revert cannot see which rows it moved |
| **Force-update everyone, no compatibility handling** | iOS and Android builds before #743 have no update gate, and their session queue silently drops 4xx |

## Consequences

**Good**
- One reading model, one set of APIs and MCP tools. 19 tables go in this slice and 2 with #946.
  `chapters` (2.6 GB) goes, so backups shrink.
- Deleted: the SSG worker, the SEO pipeline and crews, host pollers, admin catalog pages, catalog
  ingestion and Standard Ebooks sync, the public search provider (`TextStack.Search`), sitemaps/IndexNow.
- Every book row has an owner.
- Two upload gaps close on the way: a monotonic frontier, and chapter provenance for vocabulary.

**Costs and risks (none accepted silently)**
- Content is duplicated per reader for touched books. The size is measured before the run.
- Three additive columns on retained tables (`progress_max_chapter_number`, 3 × `chapter_slug`). They
  count against nothing in the table budget, but the V2 ADR must account for them.
- A transitional ledger table, and a compatibility shim with a dated removal issue.
- Catalog URLs and Android App Links for `/en/books` stop working.
- Public discovery is gone until a separate feature brings it back.
- Imports without a recoverable original file (D4) stay without one. That is reported per pair, not
  hidden.

**Rollback**
- Before the drops: code rollback, plus the job's `--revert`. Revert restores the catalog-only rows
  (they were copied, not moved), re-points shared rows back including post-migration ones, and reports
  every row it could not map.
- After the drops: down migrations (empty tables) and a restore of the permanent dump.
- Per-step conditions are in the plan.
