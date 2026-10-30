# ADR-031 — V2 schema: textstack_v2

**Status:** Proposed · **Date:** 2026-10-30 (decisions appended 2026-10-30) · **Plan:** [v2-plan.md](../v2-plan.md) §4 · **Builds on:** [ADR-030](ADR-030-two-databases-one-cutover.md), ADR-026, ADR-028 · **Keeps:** ADR-014 (guest sessions), ADR-016 (chapter review in book_insight) · **Adopts:** [v2-library-draft.sql](../v2-library-draft.sql) with the deltas below

## Context

ADR-030 put V2 in its own database, `textstack_v2`, whose `0000_baseline` *is* the schema. This ADR
says what that baseline contains and what happens to each of the 58 live legacy tables
([data-model.md](../data-model.md)).

The nine-table [draft](../v2-library-draft.sql) (books, files, reading state, annotations,
vocabulary ×3, shares, checkpoints) was executed on PostgreSQL 16.15 with generated fixtures:
32 checks passed after its provenance FKs were made `DEFERRABLE INITIALLY DEFERRED`
([v2-schema-validation.md](../v2-schema-validation.md)). It deliberately left out auth, insights,
sessions, operations and server chapters; this ADR adds them.

Owner decisions this schema encodes (plan §1.3): **D5** catalog books a user touched become V2
`books` rows with no file, positions reset; **D6** of the optional features only vocabulary
(words, examples, reviews) survives; **D7** `admin_users`/`admin_refresh_tokens` fold into
`users.role`, `models`/`model_promotions` become configuration, `eval_runs`/`llm_traces`/`agent_run`
stay. Defaults taken from the plan's recommendations: **Q2** accept a transitional `book_chapters`
with a written sunset; **Q3** retire collections; **Q5** keep guest sessions (ADR-014); **Q6** keep
`admin_settings`.

## Decision — schema rules (`database/v2/README.md`)

1. **One table, one owner module, one lifecycle** — the table's `COMMENT` names both.
2. **Ownership in the key.** Every user-owned table has `user_id`; references are composite
   `(user_id, …)` FKs, so a row cannot point at another user's row. Queries still filter `user_id`
   (ADR-028 §5).
3. **Client-generated UUIDs**; the server never renumbers.
4. **Soft removal only where the product needs it**: `books.removed_at`, `annotations.deleted_at`,
   `vocabulary_words.deleted_at`. Everything else hard-deletes.
5. **Idempotency on every replayable write**: `operation_id` unique per user; `revision` guards
   last-writer-wins (stale → 409).
6. **Locators are envelopes** `{"version":1,"scheme":…,"value":…}` (schemes below; `epub-cfi` adds
   `quote`). SQL checks the shape; the application validates the content.
7. **Enums are `text` + CHECK; times are `timestamptz`.** `created_at`/`updated_at` are set by the
   repository — no triggers.
8. **No JSON for anything queried by.** JSON only for opaque client payloads (locators, checkpoint
   sections, `book_insight.review_json`, `books.origin`).
9. **Account deletion = `DELETE FROM users` cascading.** Provenance FKs are
   `DEFERRABLE INITIALLY DEFERRED`; tests end with `SET CONSTRAINTS ALL IMMEDIATE`.
10. **`database/v2/migrations/0000_baseline.up.sql` reads top to bottom**, grouped by module, each
    table preceded by a 1–3 line comment. `data-model.md` mirrors it. No `site_id` anywhere (ADR-007).

## Decision — tables

**24 permanent + 2 transitional = 26** at baseline (plus the runner's `schema_migrations` and the
ETL's `migration_runs`, dropped at M6). After M6.4, `\dt` lists the 24 (plan §10).
"Draft" = the table is in the validated draft; "legacy" = not in the draft, defined as the legacy
shape minus `site_id` plus the delta shown.

| Module | Table | A row is | Key / unique / FK essentials | Delta |
|---|---|---|---|---|
| Identity | `users` | an account: reader, guest (ADR-014) or staff | PK `id`; `email`, `google_subject`, `apple_subject`, `is_guest`, `tier`, `native_language` as legacy | legacy + **`role text NOT NULL DEFAULT 'reader' CHECK (role IN ('reader','admin'))`**; `admin_users` fold in by email (decided item 7) |
| | `user_refresh_tokens` | a session | FK `user_id` → `users` CASCADE; `token_hash`, `previous_token_hash` (reuse detection) | legacy; **admin sessions are rows here** (`admin_refresh_tokens` gone) |
| | `password_reset_tokens` | a reset code | FK `user_id` CASCADE | legacy |
| | `oauth_clients` | a registered MCP client (ADR-017) | PK `id`, unique `client_id` | legacy; not user-owned |
| | `oauth_authorization_requests` | a pending OAuth authorization | `user_id` nullable | legacy + **`user_id` real FK → `users` CASCADE** (legacy has none and survives account delete) |
| | `oauth_grants` | an MCP OAuth token pair | FK `user_id` CASCADE | legacy |
| | `device_authorizations` | a device-flow login attempt | `user_id` nullable FK CASCADE | legacy |
| | `mcp_access_keys` | a `tsk_…` connect key | FK `user_id` CASCADE; `key_hash` | legacy minus `site_id`; kept until explicitly retired |
| Library | `books` | a library entry | PK `id`, `UNIQUE (user_id, id)`; `removed_at`; `checkpoint_saving_enabled` | draft + **`origin jsonb NOT NULL`** (`{"kind":"upload"}` / `{"kind":"catalog","editionSlug":…}` / `{"kind":"clip","sourceUrl":…}`; hidden provenance) + **`cover_key text`** (relative key on the volume) + **`tags text[] NOT NULL DEFAULT '{}'`**, **`description text`**, **`genre text`**, **`published_year int`** (carried from `user_books`, decided item 3) |
| | `book_files` | an exact file version | FK `(user_id, book_id)` → `books`; `UNIQUE (user_id, book_id, id)`; one `is_current` per book (partial unique); `sha256` lowercase hex | draft + **`format CHECK (format IN ('epub','pdf','html'))`** (draft: epub only; 22+ PDF uploads exist; `html` = clips, decided item 1) + **`page_count int`**, **`toc jsonb`** (both nullable, from `user_books`); `server_storage_key` = relative path. A legacy file with null `sha256` is hashed from disk; a missing file means no row (decided item 2) |
| Reading | `reading_state` | the accepted state for one book | PK `(user_id, book_id)`; FK `(user_id, book_id, file_id)` → `book_files`; `revision`; frontier pair | draft; legacy `is_read`/`read_at` → `completed_at`; scroll-only legacy progress keeps its chapter (decided item 5) |
| | `reading_sessions` | a reading interval | FK `user_id` CASCADE; **`UNIQUE (user_id, client_session_id)`** | legacy reshaped: **`book_id` nullable** (deleted-book trail kept, still counted), replaces `edition_id`/`user_book_id`; `duration_seconds`, `words_read`, `start/end_percent` kept |
| Annotations | `annotations` | a highlight + note, or an unanchored quotation | FK `(user_id, book_id)` CASCADE; `(user_id, book_id, file_id)` deferred; `locator` requires `file_id` | draft |
| Vocabulary | `vocabulary_words` | one card per owner/language/word_key | `UNIQUE (user_id, language, word_key)` incl. tombstones; due index | draft — i.e. **no `embedding`, cluster, tutor, distractor or zipf columns** (D6), and no `total_reviews`/`correct_reviews` (derived from `vocabulary_reviews`). Case variants merge on `word_key`; `is_retired`/`retired_at` → `deleted_at` (decided item 4) |
| | `vocabulary_examples` | a source sentence for a card | FK `(user_id, word_id)` CASCADE; `UNIQUE (user_id, operation_id)`; `book_title` snapshot | draft; migrated `payload_sha256` per decided item 4 |
| | `vocabulary_reviews` | one answer | FK `(user_id, word_id)` CASCADE; `UNIQUE (user_id, operation_id)` | draft; migrated `payload_sha256` per decided item 4 |
| Discussion | `shared_chapters` | an explicit, immutable chapter snapshot for MCP | `UNIQUE (user_id, book_id, id)`, `UNIQUE (user_id, operation_id)` | draft |
| | `discussion_checkpoints` | one saved stage of a discussion | `UNIQUE (user_id, operation_id)`; optional share link (deferred) | draft |
| | `book_insight` | an assistant conclusion or a chapter review (ADR-016) | one row per `(user_id, book_id, chapter_slug)` `NULLS NOT DISTINCT`; FK `(user_id, book_id)` → `books` CASCADE | legacy reshaped: **single `book_id`** replaces `edition_id`/`user_book_id` and `ck_book_insight_target`; `review_json` kept |
| | `review_question` | a self-check question with its SRS state | FK `book_insight_id` CASCADE; unique `(book_insight_id, prompt_hash)` | legacy minus `site_id` |
| Ops | `llm_traces` | one LLM call (cost, latency, scrubbed text) | `user_id` nullable, no FK (writers record none) | legacy |
| | `agent_run` | one agent run and its steps | `user_id` nullable FK CASCADE | legacy **minus `edition_id`** |
| | `eval_runs` | one eval score | — | legacy |
| | `admin_settings` | one runtime knob edited from the admin panel | PK `key` | legacy (Q6: kept; moving it to config makes every tweak a deploy) |
| **Transitional** | `book_chapters` | a server-extracted chapter of one file version | `(id, user_id, book_id, file_id, chapter_key, chapter_number, title, html, plain_text, word_count, source_start_page, source_end_page, created_at)`; composite FK `(user_id, book_id, file_id)` → `book_files` CASCADE; `UNIQUE (user_id, file_id, chapter_key)` | from `user_chapters`, keyed by **file version**, not book. `chapter_key = COALESCE(slug, 'ch-' \|\| chapter_number)` (decided item 6). `chapter_number` orders, never displays |
| | `ingestion_jobs` | a server extraction job for one uploaded file | FK `(user_id, book_id, file_id)` → `book_files` CASCADE; `status text` CHECK | from `user_ingestion_jobs` (legacy `ingestion_jobs` is the catalog queue — name reused, see disposition) |

Both transitional tables carry this `COMMENT ON TABLE`: *"Transitional. Dropped at M6.4 once the V2
reader serves EPUB and PDF on all clients; see ADR-031."* They feed the legacy reader,
`get_my_chapter` and `shared_chapters` snapshots, and nothing new may depend on them.

`book_chapters` needs `book_id` as well as `file_id`: `book_files`' referencable key is
`(user_id, book_id, id)`.

### Locator schemes

Allowed in `reading_state.current_locator` / `frontier_locator` and `annotations.locator`:

| Scheme | `value` | Written by |
|---|---|---|
| `epub-cfi` | an `epubcfi(...)` string, plus a sibling **`quote`**: the first ≤64 characters of text at the CFI — `{"version":1,"scheme":"epub-cfi","value":"epubcfi(...)","quote":"…"}`. `quote` is **required** in `reading_state.current_locator` (resume restores only if the text at the CFI still starts with it) and **optional** in `annotations.locator` (annotations carry `selected_text`) | the V2 EPUB reader (ADR-029, R0); CFIs are not sortable, so fractions sit beside them |
| `pdf-page` | position: `{"page":N}` (1-based). Annotation: legacy `PdfAnchor` `{page, rects:[{x,y,w,h}], exact}`, page-relative unscaled rects (`pdfHighlightAnchor.ts`) | the PDF viewer; ETL from legacy `page:<n>` progress and `kind:'pdf'` highlights |
| `textstack-position-v1` | legacy `TextPosition` `{chapterSlug, anchor:{prefix,exact,suffix,startOffset,endOffset}, charOffset, chapterFraction}` — a 64-char quote with 30 chars of context each side; offsets are hints (`textPosition.ts`) | ETL from `user_books.progress_position_json`, or from a scroll-only locator as `{chapterSlug, chapterFraction}` with no `anchor` (decided item 5); resolves only against `book_chapters` |
| `textstack-anchor-v1` | legacy `TextAnchor` `{chapterKey, prefix, exact, suffix, startOffset, endOffset}` — `chapterKey` is the chapter slug (legacy `chapterId` replaced; ids change on re-ingest) (`textAnchor.ts`) | ETL from reflow `highlights.anchor_json` on uploads |

The two `textstack-*` schemes exist only for migrated rows and the transitional reader; no V2
writer produces them.

`quote` on `epub-cfi` (added 2026-10-30) resolves ADR-029's contradiction 1: its position model
verifies a 64-character quote at the CFI, which the envelope as first written could not store.

## Decision — disposition of every legacy table

Numbering and rows (2026-10-26) from [data-model.md](../data-model.md). "Archived" = in the cutover
`pg_dump` (ADR-030 §5), then dropped with the legacy database.

| # | Legacy table | Rows | V2 | Carried / note |
|---|---|---:|---|---|
| 1 | `sites` | 1 | retired (data archived only) | live fields already config (ADR-007) |
| 2 | `site_domains` | 4 | retired (data archived only) | |
| 3 | `works` | 1,433 | retired (data archived only) | |
| 4 | `editions` | 1,433 | retired (data archived only) | user-touched pairs become `books` rows (via #38); title, author, slug snapshotted into `books`/`origin` |
| 5 | `chapters` | 40,722 | retired (data archived only) | catalog text is not migrated; re-import the EPUB to read |
| 6 | `authors` | 725 | retired (data archived only) | |
| 7 | `edition_authors` | 1,437 | retired (data archived only) | author names → `books.author` for pairs |
| 8 | `genres` | 58 | retired (data archived only) | |
| 9 | `edition_genres` | 2,134 | retired (data archived only) | |
| 10 | `book_files` (catalog) | 22 | retired (data archived only) | the V2 name means an upload's file version |
| 11 | `book_assets` | 5,011 | retired (data archived only) | |
| 12 | `ingestion_jobs` (catalog) | 25 | retired (data archived only) | the V2 name is the transitional upload queue |
| 13 | ~~`lint_results`~~ | — | already dropped (`0010`) | |
| 14 | `text_stack_imports` | 1,409 | retired (data archived only) | |
| 15 | `auto_publish_jobs` | 2,993 | retired (data archived only) | |
| 16 | `book_quality_jobs` | 67 | retired (data archived only) | PDF quality cleanup is not a V2 feature |
| 17 | `seo_templates` | 24 | retired (data archived only) | |
| 18 | `seo_backfill_jobs` | 12 | retired (data archived only) | |
| 19 | `seo_backfill_settings` | 1 | retired (data archived only) | |
| 20 | `ssg_rebuild_jobs` | 11,659 | retired (data archived only) | |
| 21 | ~~`ssg_rebuild_results`~~ | — | already dropped (`0006`) | |
| 22 | `users` | 357 | → `users` | every column; `role = 'reader'`; guests stay guests |
| 23 | `user_refresh_tokens` | 170 | → `user_refresh_tokens` | sessions survive the cutover |
| 24 | `admin_users` | 1 | → `users` (reshaped) | matched by email (case-insensitive) or inserted with its `password_hash`; `role = 'admin'` (legacy `Admin/Editor/Moderator` all collapse) |
| 25 | `admin_refresh_tokens` | 0 | → `user_refresh_tokens` (reshaped) | shape folded; nothing to copy |
| 26 | `password_reset_tokens` | 0 | → `password_reset_tokens` | |
| 27 | `device_authorizations` | 4 | → `device_authorizations` | |
| 28 | `oauth_clients` | 3 | → `oauth_clients` | |
| 29 | `oauth_authorization_requests` | 1 | → `oauth_authorization_requests` (reshaped) | `user_id` gains its FK |
| 30 | `oauth_grants` | 3 | → `oauth_grants` | MCP connections survive |
| 31 | `mcp_access_keys` | 1 | → `mcp_access_keys` | minus `site_id` |
| 32 | `admin_settings` | 6 | → `admin_settings` | |
| 33 | `user_books` | 96 | → `books` (reshaped) | same id; title, author, language, cover → `cover_key`, `origin {"kind":"upload"}` (clips `{"kind":"clip","sourceUrl":…}`); `tags`, `description`, `genre`, `published_year` kept; `page_count`, `toc_json` → `book_files`; `progress_*`, `is_read`/`read_at` → `reading_state` |
| 34 | `user_chapters` | 2,710 | transitional → `book_chapters` | keyed to the book's one file; `slug` → `chapter_key` (null → `'ch-' \|\| chapter_number`); generated `search_vector` not carried |
| 35 | `user_book_files` | 96 | → `book_files` (reshaped) | same id, `sha256` kept (null → hashed from disk; file missing → no row); `storage_path` → `server_storage_key`; int `format` → text (`Html` → `html`) |
| 36 | `user_ingestion_jobs` | 100 | transitional → `ingestion_jobs` | int status → text |
| 37 | `user_book_bookmarks` | 18 | retired (data archived only) | D6 |
| 38 | `user_libraries` | 246 | → `books` (reshaped) | catalog pairs (D5): `uuid_v5` id, no file, `origin {"kind":"catalog",…}` |
| 39 | `collections` | 1 | retired (data archived only) | Q3 |
| 40 | `book_collections` | 3 | retired (data archived only) | Q3 |
| 41 | `reading_progresses` | 435 | retired (data archived only) | D5: catalog positions reset; still used to select pairs |
| 42 | `bookmarks` | 9 | retired (data archived only) | D6 |
| 43 | `highlights` | 39 | → `annotations` (reshaped) | `selected_text`, `note_text`, `color`, `version` → `revision`; uploads anchored (`textstack-anchor-v1` / `pdf-page`), catalog unanchored |
| 44 | ~~`notes`~~ | — | already dropped (`0005`) | |
| 45 | `reading_sessions` | 587 | → `reading_sessions` (reshaped) | one nullable `book_id`; `client_session_id` = legacy `id` |
| 46 | `reading_goals` | 1 | retired (data archived only) | D6 |
| 47 | `user_achievements` | 154 | retired (data archived only) | D6 |
| 48 | `book_insight` | 7 | → `book_insight` (reshaped) | `edition_id`/`user_book_id` → `book_id`; text, question, source, `review_json` kept |
| 49 | `review_question` | 11 | → `review_question` | SRS state kept |
| 50 | `vocabulary_words` | 1,824 | → `vocabulary_words` (reshaped) | word, translation, definition, stage, interval, `consecutive_correct`, next/last review; legacy `sentence` + `book_title` + book → one `vocabulary_examples` row; case variants merged (decided item 4) |
| 51 | `vocabulary_reviews` | 461 | → `vocabulary_reviews` | `operation_id = uuid_v5(legacy id)`; `client_recorded_at = created_at` |
| 52 | `user_vocabulary_settings` | 0 | retired (never had durable data) | D6 |
| 53 | `pending_vocabulary_words` | 0 | retired (never had durable data) | D6 |
| 54 | `word_lookups` | 65 | retired (data archived only) | D6 |
| 55 | ~~`word_frequencies`~~ | — | already dropped (`0009`) | |
| 56 | `word_clusters` | 100 | retired (data archived only) | D6 |
| 57 | `tutor_session` | 6 | retired (data archived only) | D6 |
| 58 | `llm_traces` | 3,852 | → `llm_traces` | |
| 59 | `agent_run` | 104 | → `agent_run` (reshaped) | minus `edition_id` |
| 60 | ~~`shadow_runs`~~ | — | already dropped (`0007`) | |
| 61 | `models` | 8 | retired (data archived only) | D7: routing lives in `Ai:Routes` |
| 62 | `model_promotions` | 0 | retired (never had durable data) | D7 |
| 63 | `eval_runs` | 34 | → `eval_runs` | |

**Tally (58 live):** 23 carried into a V2 table (11 of them reshaped), 2 transitional, 33 retired
(30 archived only, 3 never held durable data); 5 rows already dropped.

## Decision — data deliberately NOT carried

Owner exceptions, written here so the ETL's validation can treat them as expected, not as loss.
Every row below is in the cutover `pg_dump` archive (outside restic retention, tag `pre-v2-cutover`)
and can be read back from it; none is silently lost.

| Data | Why |
|---|---|
| Catalog positions (`reading_progresses`) | D5: positions reset; the book row survives without a file |
| `bookmarks`, `user_book_bookmarks` | D6. Annotations require `selected_text`; a location-only bookmark does not fit them (see Alternatives) |
| `reading_goals`, `user_achievements` | D6 |
| `pending_vocabulary_words`, `word_lookups`, `user_vocabulary_settings`, `word_clusters`, `tutor_session`, and the cluster/tutor/embedding columns of `vocabulary_words` | D6: only words, examples and reviews survive |
| `collections`, `book_collections` | Q3: 3 rows, polymorphic `book_id` with no FK |
| `models`, `model_promotions` | D7: configuration (`Ai:Routes`) |
| `book_quality_jobs` | catalog/PDF quality pipeline, not part of V2 |
| `user_books.takedown_at`/`takedown_reason`, metadata-enrichment status fields, `total_word_count`, `seo_source`, `suggested_tags*` | decided item 3: catalog/SEO/enrichment machinery, not library data |
| `vocabulary_words.total_reviews`/`correct_reviews` | decided item 4: derived from `vocabulary_reviews` |
| The losing card of a case-variant vocabulary merge (its SRS state) | decided item 4: its examples and reviews move to the survivor |
| All catalog, SEO and SSG content (#1–#20) | D3: the public catalog is retired within V2 |

## Consequences

**Positive**
- The baseline is the final schema: 26 tables grouped by module, no `site_id`, no polymorphic keys,
  no second user table, no second reading model.
- Every legacy table has exactly one recorded fate (above); the ETL validation checks the carried
  ones and expects the rest.
- Ownership is enforced by the schema (composite FKs), not only by query filters.

**Costs**
- **Transitional tables.** `book_chapters` + `ingestion_jobs` and their repository/worker live until
  R8; the sunset is in the table comment and gates M6.4.
- **Catalog highlights become unanchored quotations** (text and note kept, no locator, no `file_id`).
  No legacy-to-CFI conversion is attempted.
- **Catalog books are readable only after re-import**: a `books` row with no `book_files` row.
- **Guests are unchanged**: ADR-014 sessions are `users` rows; local-first reading still needs no
  session. The merge is rewritten per aggregate (plan §6.1).
- **`mcp_access_keys` stays** beside `oauth_grants` until an explicit retirement decision.
- Legacy positions on uploads survive only as `textstack-position-v1`/`pdf-page` and resolve only
  while `book_chapters`/the PDF viewer exist; the V2 EPUB reader starts those books from the fraction.

## Alternatives considered

- **≤20 tables by merging token tables** (refresh, reset, OAuth, device, MCP keys into one). They
  have different lifecycles and security rules (reuse detection, PKCE, device polling); one bucket
  table needs a `kind` column and nullable fields per kind. Rejected; ~20 is a guide, not a cap.
- **Vocabulary as one JSON table.** Breaks rule 8: reviews and due dates are queried. Rejected.
- **Keeping both reading models** (catalog `reading_progresses` beside upload state). The point of
  V2 is one book model; D5 resets catalog positions. Rejected.
- **Bookmarks as location-only annotations.** `annotations.selected_text` is `NOT NULL` with a
  non-blank CHECK — the property that makes a legacy quotation survive without a locator. Making it
  nullable for bookmarks weakens every annotation. Rejected; D6 retires bookmarks.
- **EF Core for V2 tables.** ADR-030 §2: V2 is Dapper-only; EF leaves with the legacy database.

## Open items handed to M1.1 (and M3)

Mechanical (M1.1):
- Exact DDL review of the 17 non-draft tables against the legacy columns; the index set (draft
  indexes + legacy indexes still queried); `COMMENT ON` every table (rule 1).
- Seed for `oauth_clients` (pre-registered clients, if any) vs ETL copy — one, not both.
- `migrate.sh` cannot `CREATE DATABASE`; `migrator-v2` needs an idempotent step against the
  maintenance database (ADR-030 costs).
- `/health/ready`, `health-check.yml`, `backup.yml`, the pre-deploy dump, `make backup` and
  `restore-drill.yml` must cover both databases before V2 holds anything worth keeping (ADR-030).

## Decided 2026-10-30 (were open items 1–7)

Owner decisions on the substantive items found reading the legacy DDL. The table rows above carry
the schema deltas; these are the ETL rules M3 implements and validates.

1. **Clips stay, as HTML.** `book_files.format CHECK (format IN ('epub','pdf','html'))`. Clips
   (`user_books.is_clip`, `user_book_files` format `Html`, `UserBookService.ClipAsync`) migrate as
   they are; `source_url` moves to `books.origin` as `{"kind":"clip","sourceUrl":…}`.
2. **Null `sha256` → hash the bytes on disk.** If the file is missing, the book migrates **without a
   `book_files` row** — the same state as a catalog book ("file not imported") — and is listed in
   the ETL report. Never a hard failure.
3. **Orphan `user_books` columns.** Carried: `tags` → `books.tags text[] NOT NULL DEFAULT '{}'`;
   `description`, `genre`, `published_year` → nullable `books` columns (text, text, int);
   `page_count` → `book_files.page_count int`; `toc_json` → `book_files.toc jsonb` (both nullable);
   `is_read`/`read_at` fold into `reading_state.completed_at`. Retired (archive only):
   `takedown_at`, `takedown_reason`, the metadata-enrichment status fields, `total_word_count`,
   `seo_source`, `suggested_tags*`.
4. **Vocabulary case merge.** Legacy cards that collapse onto one `(user_id, language, word_key)`
   merge: the survivor is the card with the higher `total_reviews`, tie → newer `updated_at`; the
   examples and reviews of both attach to it; `word` keeps the survivor's spelling.
   `is_retired`/`retired_at` → `deleted_at`. `total_reviews`/`correct_reviews` are not stored —
   derived from `vocabulary_reviews`. For migrated rows, `vocabulary_reviews.payload_sha256` and
   `vocabulary_examples.payload_sha256` = lowercase-hex sha256 of the **canonical JSON** of the
   migrated payload: keys sorted, UTF-8, no insignificant whitespace.
5. **Scroll-only upload progress is kept.** A `scroll:<slug>:<px>` locator with no
   `progress_position_json` becomes a `reading_state` row with `textstack-position-v1` carrying
   `chapterSlug` and `chapterFraction` only, no `anchor`; the row's `book_fraction` column comes
   from the legacy progress. The chapter is never dropped.
6. **Chapter-key fallback.** `book_chapters.chapter_key = COALESCE(slug, 'ch-' || chapter_number)`;
   the same fallback applies wherever a legacy chapter is referenced from annotations or examples.
7. **`admin_users` → `users` by email.** Match case-insensitively on email to an existing user and
   set `role = 'admin'`; no match → insert a `users` row with the admin's `password_hash`. Legacy
   Editor/Moderator map to `admin` (production has one admin).

Related: [v2-plan.md](../v2-plan.md) · [ADR-030](ADR-030-two-databases-one-cutover.md) ·
[ADR-028](ADR-028-dapper-and-repositories.md) · [ADR-026](ADR-026-sql-first-migrations.md) ·
[ADR-014](ADR-014-guest-sessions.md) · [ADR-016](ADR-016-chapter-review-lives-in-book-insight.md) ·
[v2-library-draft.sql](../v2-library-draft.sql) · [data-model.md](../data-model.md).
