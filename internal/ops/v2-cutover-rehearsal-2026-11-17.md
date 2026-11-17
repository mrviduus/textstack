# V2 cutover rehearsal, 2026-11-17 (M5 Part D, #1031)

Runbook: [v2-cutover.md](v2-cutover.md). Build: `main` @ `554c7c5d6798` (after #1372), images built locally
(`SENTRY_RELEASE=554c7c5d6798`).

**Verdict: green pending the Android re-run.** Every server step, the web and MCP smoke and the rollback passed.
The Android smoke failed (#1374), so the runbook's rollback path ran, as it would in production. The owner
(2026-11-17) accepted this seeded run plus the real-data restore drill as the rehearsal. It is green once the Android
rows pass again on `main` with #1374's fix (#1376). The real dump time is measured live in the production freeze.

## Setup, and what it is not

- **Isolated stack** (`COMPOSE_PROJECT_NAME=tsrehearsal`, api `127.0.0.1:18080`, MCP `:18090`, web dev server
  `:5199`) in a throwaway worktree. The owner's running stack and checkout were not touched. Torn down after:
  containers, volumes, images, data directories.
- **Data: seeded, not a restored backup.** No production backup is reachable from the Mac (the nightly dumps
  live on the server and in R2; the R2 credentials are GitHub secrets only), and the server was out of bounds.
  The legacy database was filled through the legacy API instead: one account (test-auth login), three uploads
  (an EPUB, two PDFs of 1 and 6 pages), reading places on the EPUB (chapter "Letter 1", 11 %) and the 6-page PDF
  (page 4), one highlight with a note, two vocabulary words.
- **Real data, same build, same day:** the ETL half on the latest R2 backup ran in `restore-drill.yml`
  (`etl_rehearsal=true`), run [44013811027](https://github.com/mrviduus/textstack/actions/runs/44013811027) on
  `554c7c5d`: dry run → run → validate → re-run (0 writes) → validate, all exit 0.
- Not in the stack: `ssg-worker`, `ollama`, the host pollers (catalog tooling; nothing in the cutover reads them).
  Their stop commands in the runbook were not executed.
- Sign-in: the test-auth path (`ENABLE_TEST_AUTH=true`) for web and MCP. Android: email + password; the migrated
  account has no password (it was test-auth created), so a bcrypt hash was written to its V2 row in the
  throwaway database for the emulator login.

## Steps

Times UTC. Freeze → unfreeze: **2 min 04 s** (04:01:45 → 04:03:49).

| Step | Time | Result | Evidence |
|---|---|---|---|
| 0 Preconditions | 04:01:21 | pass | build sha = checkout sha; `/health/ready` `mode: legacy`, `v2: off` (flag off), schema ok |
| 1 Freeze | 04:01:45 → 04:01:47 | pass | `POST /auth/test-login` → 503 `{"error":"write_frozen"}`; `/health/ready` 200 |
| 2 Drain, stop worker | 04:01:59 → 04:02:00 | pass | drain query: 0 running, 0 queued in all 6 job tables; worker stopped; 1 idle api session left |
| 3 Archive dump + sha256 | 04:02:07 → 04:02:08 | pass | `pg-dump-checked.sh`: dump-complete trailer, `sha256sum -c` OK (seeded DB: 253 KB) |
| 4 Tag | 04:02:29 | pass | annotated tag on `554c7c5d` (local only, deleted after; production pushes `pre-v2-cutover`) |
| 5a `etl_reader` + LO preflight | 04:02:29 | pass | role provisioned; large-object functions executable by PUBLIC: `0` |
| 5b ETL dry run | 04:02:35 → 04:02:36 | pass | exit 0; 68 checks; 16 targets with writes counted |
| 5c ETL run | 04:02:43 → 04:02:44 | pass | exit 0; 84 checks, 0 failed; users 2, books 3, book_files 3, reading_state 2, annotations 1, book_chapters 33, ingestion_jobs 3, library_files 6, vocabulary_words 2, vocabulary_examples 1 inserted |
| 5d `validate-etl.sql` | 04:02:50 → 04:02:51 | pass | exit 0: 28 `ok`, 8 `report`, **0 `FAIL`** |
| 6 Read-only legacy + flip | 04:02:58 → 04:03:04 | pass | `default_transaction_read_only` = `on`; api/worker/mcp recreated; MCP `TEXTSTACK_MCP_V2=true`; readiness `db ok mode v2`, `legacy ok`, `v2 ok` |
| 6 Frozen checks | 04:03:40 | pass | write → 503 `write_frozen`; `GET /me/bookmarks` → 410 `gone_in_v2`; no read-only (25006) error in api or worker logs |
| 7 Unfreeze | 04:03:48 → 04:03:49 | pass | login 200 |
| 8 Smoke | 04:05 → 04:16 | **fail** (Android) | table below |
| ROLLBACK | 04:16:15 → 04:17:03 | pass | legacy up 04:16:23; readiness `mode legacy`, `v2 off`; MCP `TEXTSTACK_MCP_V2=false`; read-only `off` |
| Legacy data unchanged | 04:16:55 | pass | md5 fingerprint of users, user_books (+ places), user_book_files, user_chapters, highlights, vocabulary_words, user_ingestion_jobs, reading_sessions: identical to the one taken after the freeze |
| Legacy smoke | 04:17 → 04:20 | pass | table below |

Real-data ETL (run 44013811027, latest nightly backup): restore DB 136 s, files 57 s, V2 restore 3 s (27 tables);
build 41 s; dry run 6 s, run 11 s, validate 2.5 s, re-run 4 s (0 writes), validate 2.5 s. All exit 0.

## Smoke on V2 (after the flip)

| Check | Result | Evidence |
|---|---|---|
| Web: sign in (test-auth) as the migrated user | pass | 200 |
| Web: Library shows the migrated books | pass | 3/3 titles |
| Web: EPUB opens in the V2 reader at the carried place | pass | `/read` loads `/reader-v2/frame.html`; status `11% · Chapter 1`. The carried locator is `textstack-position-v1` `{chapterSlug, chapterFraction: 0}` (legacy held no position JSON); the V2 reader resumes such a locator by its book fraction, by design (#1187), so it opens at 11 %, not at the chapter |
| Web: PDF opens at the carried page | pass | status `67%` = page 4 of 6; server locator `{"page":4}`, revision unchanged |
| Web: a highlight saves | pass | `PUT /me/v2/annotations/{id}` 201, green. The migrated highlight is in the annotations feed (API) |
| Web: a word saves | pass | tapped word → `PUT /me/v2/vocabulary/words` 201; the migrated word `delight` is marked in the text |
| Web: a retired page is hidden | pass | no Stats link; `/en/stats` redirects to `/en` |
| Web: a legacy route answers 410 | pass | `GET /me/bookmarks` → 410 `{"error":"gone_in_v2"}` |
| MCP: the 10 ported tools on a migrated book | pass | `search_my_library`, `get_my_book`, `get_my_chapter` (Letter 1 text), `get_my_reading`, `get_book_progress` (`3-letter-1`, 0.11), `set_book_progress`, `list_my_book_highlights` (migrated highlight present), `save_my_highlight`, `save_insight`, `get_my_insights`: all without error, over the MCP server (HTTP, bearer) against the api |
| Android emulator (dev client, current main JS, api via `adb reverse`) | **FAIL** | signed in; Library tab: "Couldn't load your library", toast `ApiError: gone_in_v2`. API log: `Gone in V2: GET /me/library` and `GET /me/progress` from app 1.1.0. Cause: `app/(tabs)/library.tsx` loads the catalog shelf and progress in the same `Promise.all` as the uploads (#1374) |

## Smoke on legacy (after the rollback)

| Check | Result | Evidence |
|---|---|---|
| Web: sign in, Library | pass | 3/3 titles |
| Web: EPUB opens at the carried chapter | pass | Continue Reading → `/read/3-letter-1`, Letter 1 text on screen |
| Web: legacy route served | pass | `GET /me/bookmarks` 200 |
| Places, highlight, words as before the flip | pass | EPUB `3-letter-1` 0.11, PDF `page:4` 0.5; 1 highlight; words `delight`, `petersburgh` |
| V2 writes after the flip are gone from the served data | pass (expected loss) | the 2 web highlights, the word saved in the reader, the MCP place/highlight/insight are not in legacy |
| Android: Library | pass | `3 books`, Frankenstein "Last read just now" |

## Findings

1. **Blocker, #1374:** the Android Library tab fails in V2 mode (above). Web is fine. The owner's phone must run a
   build with the fix before the flip, and the Android rows must be re-run.
2. A legacy-mode quirk seen on the way: the bare `/en/library/my/{id}/read` (no chapter slug) shows "Chapter not
   found" in the legacy web reader; the book page's Continue Reading link carries the slug and works. Not a
   cutover risk (V2 mode serves `/read` with the V2 reader).
3. A carried EPUB place is approximate (book fraction) until the reader writes its own locator: by design (#1187),
   worth knowing when reading smoke row 3.

## Not verified here

- The ETL and validator on a restored real backup **in this stack** (done in the same build's drill run instead;
  the rest of the runbook ran on seeded data).
- The production dump's time and size (the seeded one took 1 s); stopping `ssg-worker` and the host pollers.
- The Android V2 reader on the emulator (blocked by #1374 before any book could open), and a physical device.
- A re-cutover after a rollback (the runbook says to rebuild V2 first; not exercised).
