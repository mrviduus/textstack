# etl-v2 runbook — rehearsals (M3.5) and the cutover (M5)

How to run the legacy → `textstack_v2` ETL ([v2-plan §5.2](../01-architecture/v2-plan.md)) safely. The
cutover runbook (M5.2, `v2-cutover.md`) links here for the ETL step; it does not repeat it.

**Nothing here has been run against production.** Creating `etl_reader` on production is its own
explicit operation, done later, on the owner's go-ahead.

## 1. The source role: `etl_reader`

The ETL reads legacy as a SELECT-only role. The read-only connection default
(`default_transaction_read_only=on`, set by etl-v2 on every source connection) stays as a second
safeguard; the role is the one that holds when a session switches that default off.

`etl_reader` has: LOGIN, CONNECT on the source database, USAGE on `public`, SELECT on exactly the tables
etl-v2 reads (the list in the script: every step's declared `Sources`). It has no ownership, no
SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS, NOINHERIT and no role membership. The application
role's privileges are not touched.

### Provision

Against the legacy database the run reads (a restored rehearsal copy, or production at the cutover), as
a role that may create roles. No password on any command line, and none in shell history: every
secret below is typed into `read -rs` (silent, not echoed, never in history) and passed by name.

Preferred: the script without a password, then psql's `\password`, which hashes on the client and sends
only the SCRAM verifier, so no log can hold the password. It needs a terminal (no `-T`):

```sh
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d <legacy db> -f -' \
  < database/scripts/etl-reader.sql        # prints: no password set
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d <legacy db> -c "\password etl_reader"'
```

Scripted (no terminal): the script reads the password from `ETL_READER_PASSWORD` (`\getenv`, psql 16+)
and sends it in `ALTER ROLE … PASSWORD`. That statement is plain text on the wire, and the server logs it
when `log_statement` is `ddl` or `all` (`SHOW log_statement` first; the default `none` logs nothing):

```sh
read -rs ETL_READER_PASSWORD && export ETL_READER_PASSWORD
docker compose exec -T -e ETL_READER_PASSWORD db sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d <legacy db> -f -' < database/scripts/etl-reader.sql
unset ETL_READER_PASSWORD
```

Idempotent: re-running forces the attributes again (and the password, when given) and re-grants. The role is
cluster-wide, so `textstack_v2` in the same cluster sees it too; it has no grant there beyond PUBLIC's.

A mapper (M3.2/M3.3) that reads one more legacy table adds it to the script's GRANT list in the same PR.

### Verify

etl-v2 audits the source login (`session_user`, not the current role: `RESET ROLE` would hand a writer
login connected with `-c role=etl_reader` its powers back; such a session is refused outright) at the
start of every run and refuses it, before taking the lock or writing the ledger, if it can write in any
way: a role attribute, membership in any role (inherited or SET ROLE-able), ownership of any object of
any kind in any database (`pg_shdepend`), CREATE on any
database or user schema, INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any user table or column
(PUBLIC's grants included), USAGE/UPDATE on any sequence, or EXECUTE on a SECURITY DEFINER function owned
by another role. `etl-v2 --dry-run` is the check:

```sh
read -rs ConnectionStrings__Default && export ConnectionStrings__Default   # Host=db;Database=<legacy db>;Username=etl_reader;Password=…
make etl-v2 ARGS=--dry-run
```

Exit 1 with `source login … can write (…)` lists what to fix (up to 5 items).

**Not covered by the audit, by decision.** PUBLIC holds both by default, so the audit cannot refuse
them without refusing every login:
- `TEMP` on the database: temporary tables die with the session and never persist. Left as is.
- The large-object functions (`lo_create`, `lo_from_bytea`, …): EXECUTE is granted to PUBLIC. They fail
  in a read-only transaction, which is etl-v2's default; a session that switched that off could create
  a large object. Closed by the preflight below (owner 2026-11-08).

### Preflight (every rehearsal and the cutover)

Before the first `--dry-run`, on the legacy database the run reads, as its owner or a superuser. The
application stores nothing in large objects, so it loses nothing:

```sql
-- every large-object function PUBLIC may execute (17 on postgres 16; lo_import/lo_export are superuser-only already)
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = 'pg_catalog'::regnamespace AND (p.proname LIKE 'lo\_%' OR p.proname IN ('loread', 'lowrite'))
             AND has_function_privilege('public', p.oid, 'EXECUTE')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
-- check: must print 0
SELECT count(*) FROM pg_proc p
WHERE p.pronamespace = 'pg_catalog'::regnamespace AND (p.proname LIKE 'lo\_%' OR p.proname IN ('loread', 'lowrite'))
  AND has_function_privilege('public', p.oid, 'EXECUTE');
```

Checked 2026-11-08 on the compose image (pgvector pg16): 0 left, and a plain role's `lo_create(0)` is
`permission denied`. Run that `lo_create(0)` probe only AFTER the REVOKE: a probe before it
succeeds and leaves a large object the source audit then refuses (unlink it as a superuser,
`SELECT lo_unlink(oid) FROM pg_largeobject_metadata`, if that happens). On production the revoke stays after the cutover (legacy is read-only from then on);
undo it (`GRANT EXECUTE … TO PUBLIC` per function) only if the rollback (plan §5.3 step 8) puts legacy
back in service and something needs it.

### Clean up

After the rehearsal, or after the cutover's validation:

```sql
-- in each database etl_reader was granted on (the legacy database it read):
DROP OWNED BY etl_reader;   -- it owns nothing; this revokes its grants here, CONNECT on the database included
-- then, once per cluster:
DROP ROLE etl_reader;
```

`DROP ROLE` refuses while any database still holds a grant to it; that is the check that cleanup is complete.

## 2. Credentials

No password goes in process arguments, logs or the ledger.

- **Env**: `ConnectionStrings__Default` (source) and `ConnectionStrings__V2` (target). `make etl-v2` passes
  each one that is set by name (`docker compose run -e NAME`), so the value never appears on a command
  line; without them, the compose file's values are used. Set them with `read -rs` + `export`, never
  `export NAME='…'`, which lands in shell history.
- **pgpass file**: put `Passfile=<path>` in the connection string, without a password; the file is
  libpq's format (`host:port:db:user:password`, mode 0600). Through `make etl-v2` the path is inside the
  api container.
- `--source`/`--target` with `Password=`, `PWD=`, `PSW=` or `SSL Password=` is refused (exit 2):
  argv is visible to every user on the host (`ps`).

Output never carries a password: the report shows connection strings without them, and stderr messages
are scrubbed. The ledger records a failure as `{"error":{"type":…,"sqlState":…}}` only, never message text.

## 3. A run

```sh
read -rs ConnectionStrings__Default && export ConnectionStrings__Default   # Host=db;Database=<legacy db>;Username=etl_reader;Password=…
make etl-v2 ARGS='--dry-run'
make etl-v2 ARGS='--source-dump-sha <sha256 of the restored backup>'
unset ConnectionStrings__Default
```

`make etl-v2` runs in a one-off container of the api image (`docker compose run --rm --no-deps`), its
own process with signals proxied, not inside the serving api. **No merge to `main` while a run is in
flight**: a deploy recreates services and may take the run's network or image with it.

A run succeeds only if its steps ran validation checks and every one passed. A real run with no check
fails closed (`NoValidationChecks`). A dry run writes no gate row, so with 0 checks it exits 0 with its
report and warns `0 validation checks ran (no step ran a check)` on stderr. In a dry run, steps compute
and count what they would write (`writes` in the report: inserted / updated / unchanged per target);
nothing is written (not even rolled back: a rolled-back transaction still advances sequences). A dry
run whose checks fail exits 1, and prints the checks (failing ids only), orphans and cleanups on stdout:
that is the pre-flight's report.

Once any check has failed, the later steps still compute and report, but write nothing. Every write of a
step runs in one transaction that holds the run's own `migration_runs` row `FOR SHARE` (the fence): a
run that lost its lock and was closed as `interrupted` by another finds its row closed and writes nothing.

The run holds its advisory lock on one target connection (TCP keepalive on) and checks it is still held
before every step and before the final ledger write; a lost lock (`lock lost: another run may be
writing`) aborts the run, which then never reaches `succeeded`. The ledger's own INSERT and finish run
to completion whatever the cancel says (60 s bound): a run whose success finish committed is
`succeeded`, even if Ctrl+C arrived during it.

| Exit | Meaning |
|---|---|
| 0 | done; the JSON report is on stdout |
| 1 | refused (same database, source login can write, another run holds the lock), failed (ledger `failed`, incl. `NoValidationChecks`/`ValidationFailed`), or cancelled before its ledger row (`cancelled; nothing recorded`) |
| 2 | usage: unknown flag, bad `--source-dump-sha` (64 lowercase hex), password on the command line |
| 130 | cancelled by the first Ctrl+C after its ledger row was written; ledger `failed`, error type `OperationCanceledException` |

A second Ctrl+C ends the process (checked 2026-11-07: dotnet as PID 1 in the api base image exits 130 on
the second SIGINT). If it does not (a run stuck where no signal reaches it), `docker ps` and
`docker kill <the etl-v2 run container>`; the row stays unfinished and the next run closes it as
`interrupted`.

A run killed outright leaves its ledger row unfinished; the next real run, once it holds the lock,
closes it as `interrupted` and lists it in `interruptedRuns`. Nothing is ever deleted.

## 3.1 Validate

After every real run (each rehearsal, and the cutover's run before the flip), re-check it from SQL alone with
`database/v2/scripts/validate-etl.sql`. It is read-only on both databases; the legacy side may be `etl_reader`.
It checks the newest `migration_runs` row unless given `run_id`. No password on the command line: a pgpass
file, or `PGPASSWORD` set by `read -rs` for the session.

```sh
psql -X -d 'host=db dbname=<legacy db> user=etl_reader' -v v2='host=db dbname=textstack_v2 user=<v2 owner>' \
  [-v run_id=<uuid>] -f database/v2/scripts/validate-etl.sql
```

One row per check: `check | status | details`. `ok` holds; `FAIL` is a mismatch (per table: count, owner and
mapped columns legacy vs V2; the ledger's counts and writes vs now; the invariants of plan §5.2); `report` is a
report-only category from §4 (takedowns, non-ready uploads, files with no bytes, the deleted-upload trail,
dangling and session-only pairs, V2-only rows): listed, never a failure, as long as the ledger names the same
rows the SQL finds (else that row is `FAIL`). Exit 0 = no `FAIL`; exit 3 = `validate-etl: N check(s) FAILED` on
stderr (or no `-v v2`). A run is accepted only at exit 0 (plan §5.1: three in a row on rehearsals).

## 4. What a run carries (M3.2: users and uploads; M3.3: catalog pairs, vocabulary, insights, sessions)

Steps, in order: `users` (legacy `users`, `admin_users` → `users`), then `uploads` (`user_books`,
`user_book_files`, `user_chapters`, upload `highlights`, `user_ingestion_jobs` → `books`, `book_files`,
`reading_state`, `annotations`, `book_chapters`, `ingestion_jobs`), then M3.3's `catalog`, `vocabulary`,
`insights`, `sessions` and `unknown-users` (below). Ids are legacy's (an admin with no user keeps its `admin_users` id), so a
second run over the same source writes nothing and reports the same counts. The steps write with their
own inline SQL (data-access.md rule 13) in the fenced transaction, not through the API's repositories:
those stamp `created_at`/`updated_at` with `now()`, refuse a second book with the same bytes and open
their own transactions. Every CHECK and composite FK of the schema still applies. `book_chapters` is
written by binary `COPY`.

### Conflict rules

What a run does when V2 already holds a row of the same key. Never a blanket `ON CONFLICT DO NOTHING`
(a unit test scans the ETL sources for it).

| Aggregate (V2 key) | V2 has no row | V2 row equal to the mapping | V2 row differs from the mapping |
|---|---|---|---|
| `users` (`id`) | insert | unchanged | **update** every legacy column (M2.2's shadow rows are filled, counted as `updated`, not drift); `role` stays `admin` if V2 has it; `credentials_reset_at` is V2's own, never touched |
| `users` (`lower(email)`) | — | — | an email V2 holds under **another id**: check `users: email held by another V2 id` fails (`legacyId/v2Id`), nothing overwritten |
| `books` (`id`) | insert | unchanged | check `books: V2 row differs from its legacy mapping` fails; the V2 row is kept |
| `book_files` (`id`) | insert | unchanged | same rule (`book_files: …`) |
| `reading_state` (`user_id, book_id`) | insert | unchanged | same rule (`reading_state: …`) |
| `annotations` (`id`) | insert | unchanged | same rule (`annotations: …`) |
| `book_chapters` (`id`, compared by md5 of `html`/`plain_text`) | COPY | unchanged | same rule (`book_chapters: …`) |
| `ingestion_jobs` (`id`) | insert | unchanged | same rule (`ingestion_jobs: …`) |
| library bytes (the V2 key) | copied | unchanged (same SHA-256) | check `library_files: V2 key already holds other bytes` fails; the V2 bytes are kept |

V2 users with no legacy row are listed in `cleanupActions`; no run deletes them, and they are not a
failure (owner 2026-11-08). A guest (the identity mirror's leftover, #1094) comes with the `DELETE` a human
may run (it cascades to that user's V2 rows); a non-guest account comes with none: a human reviews it.

### Mapping, and what fails instead of being guessed

- **Users** (ADR-031 rows 22, 24, item 7): every column; legacy's `''` `google_subject` becomes NULL.
  An active `admin_users` row matching a user's email case-insensitively makes that user `admin`; with no
  match it becomes a user (`password_hash`, `role = 'admin'`, tier `Free`). Fails: two legacy emails
  equal but for case (#1027: no merge rule decided), an **inactive** admin (no rule decided), an
  admin id held by a user of another email, a tier outside V2's set.
- **Books** (row 33, items 1, 3): `origin` `{"kind":"upload"}` or `{"kind":"clip","sourceUrl":…}`;
  `tags`, `description`, `genre`, `published_year` carried; the cover is copied to
  `library/…/{bookId}/cover.{ext}` (missing on disk: `cover_key` NULL, listed). Fails: a blank title.
- **Taken-down uploads** (`user_books.takedown_at` set; owner 2026-11-08): the book is carried **hidden**,
  `books.removed_at = takedown_at` (the library lists only `removed_at IS NULL`); its file row gets
  `content_removed_at = takedown_at` and `server_storage_key` NULL (the API serves no content without a
  key). No bytes are copied (file or cover; `cover_key` NULL): legacy keeps them as the rollback, and a
  null `sha256` is hashed from them read-only. Its chapters are not carried; its reading state,
  annotations and jobs are. Its anchored annotations are quote-checked against legacy's chapters, as
  every one is. Each such book is listed in `orphanCandidates`, on a dry and a real run. Not a failure.
  A carried takedown annotation keeps its `textstack-anchor-v1` locator and `file_id` while V2 holds no
  chapter for that file: anything that later resolves anchors must expect one that names no chapter.
- **Non-ready uploads** (`user_books.status` Processing or Failed; owner 2026-11-08): carried with their
  bytes as any upload (it is the user's file), and each listed in `cleanupActions` for a human. Not a failure.
- **Files** (row 35, item 2): `sha256` lowercased; a null one is hashed from the bytes; a file whose bytes
  are not on disk gets **no row** and its book migrates without a file (listed). `page_count`,
  `toc_json` move here. Fails: more than one legacy file for a book, format Other (Fb2 carried as `fb2`
  since `0005`), bytes that differ from the recorded `sha256`, a path outside
  `Storage:RootPath`, a non-positive size or blank name.
- **Reading state** (items 3, 5): `progress_position_json` → `textstack-position-v1` as-is; `page:<n>` →
  `pdf-page`; `scroll:<slug>:<px>` alone → `textstack-position-v1` `{chapterSlug, chapterFraction: 0}`
  (a pixel offset has no chapter length to divide by); `book_fraction` = `progress_percent` (NULL → 0);
  `completed_at` = `completed_at`, else `read_at` (else `updated_at`) when `is_read`; no frontier. A book
  with no file row keeps no state (listed: its position resets, as a catalog book's). Fails: progress
  with no locator V2 can resume from (a percent or a "read" mark alone), `pdf-page` on a non-PDF, a
  percent outside 0..1.
- **Annotations** (row 43, item 6): a PDF anchor → `pdf-page` as-is; a reflow anchor → `textstack-anchor-v1`
  with `chapterId` replaced by `chapterKey`. An anchor whose chapter is gone, or on a book with no file
  row, is not carried: the annotation is a quotation (listed). A highlight with no book and no edition (a
  deleted upload's trail) is not carried (listed in `orphanCandidates`). Catalog highlights are M3.3's.
  Fails: highlight owner ≠ upload owner, an anchor that is not an object, a blank text, a version below 1.
- **Chapters** (row 34, item 6): `chapter_key = COALESCE(slug, 'ch-' || chapter_number)`, keyed to the
  book's file; a book with no file row's chapters are not carried (listed). `html` is carried byte for
  byte: its images keep their legacy `/storage/…` URLs and no image asset is copied (owner 2026-11-08;
  `book_chapters` is transitional until R8). Fails: a blank key, two chapters of a file with one key.
- **Ingestion jobs** (row 36): status `0..3` → `queued`/`processing`/`succeeded`/`failed`; `source_format`
  lowercased (as the V2 worker writes it); keyed to the carried file. A job whose file got no row is not
  carried (listed). Fails: another status, or a source format outside `epub`/`pdf`/`html`/`fb2`/`unknown`.

`orphanCandidates` and `cleanupActions` carry ids only, never an email or a text.

### Validation (plan §5.2 parts 1–3)

Before the write, on a dry and a real run: `annotations: selected_text not in its chapter's plain_text`
for every `textstack-anchor-v1` annotation, against legacy's chapters (V2's are their md5 copies, so it
holds there too; a failure stops the write). After the write, per target: `<table>: parity` (every mapped
row is in V2, equal to its mapping: count and content, owner included). The quote comparison collapses every whitespace run to one space on both sides
first (owner 2026-11-08) and drops whitespace before closing punctuation (`. , ; : ! ? …` and `) ] } » ” ’ ›`) on both
sides (owner 2026-11-09: the first isolated rehearsal on a restored backup failed on one legacy highlight
differing by a space before a final period, an html→text artifact); otherwise strict: no trim, no case folding.
`validate-etl.sql` applies the same normalization. `users: parity` covers the shadow rows and the admins.

### Files

Reads `Storage:RootPath` (legacy, read only) and `Storage:LibraryRoot` (V2); the two must not nest (#1110).
Bytes are **copied**, never moved or deleted: legacy is the rollback (plan §5.3 step 8). A copy goes to a
temp file beside its key, then is renamed into place; an existing key is never overwritten. Bytes are
copied before the rows are written; a run that fails between leaves bytes no row names, and the worker's
daily orphan sweep removes them. A dry run reads (and hashes) legacy's bytes and V2's existing ones, and
writes no file.

### M3.3: catalog pairs, vocabulary, insights, sessions

Same engine and the same rule for every table: insert what V2 lacks, leave what is equal, and a V2 row that
differs from its mapping fails `<table>: V2 row differs from its legacy mapping` (never overwritten); a V2
row with no legacy row is a cleanup line, never deleted. A legacy row V2's CHECKs or FKs would abort on fails
a named check (`<table>: <rule>`, failing ids) and is not carried; the run then writes nothing more. A
secondary unique key V2 holds under another id fails `<table>: (<key>) held by another V2 id` before the write.
Every legacy row's owner is a legacy user (legacy FKs), and the users step carries every one, so no row is
dropped for its user. The catalog step's targets are reported as `books (catalog)` and `annotations
(catalog)`; the uploads step compares only non-catalog books and their annotations.

| Aggregate (V2 key) | Id | Mapping, and what fails |
|---|---|---|
| Catalog pair (`books`) | `uuid_v5(ns, user ‖ edition)`, ns = `uuid_v5(nil, "textstack-v2")`, names in RFC byte order | Pair = catalog plan §3.4's intent query minus bookmarks: `user_libraries`, `reading_progresses`, catalog `highlights`, `vocabulary_words`, `book_insight`, and the retired `pending_vocabulary_words`, `word_lookups`, `word_clusters`, savedbook shelf entries (owner 2026-11-08). Row: edition title, first author by credit order, edition language, `origin {"kind":"catalog","editionSlug"}`, `created_at = updated_at` = the pair's first intent by immutable creation times (a `reading_progresses` row has none: its `updated_at` moves between dumps; a progress-only pair takes the edition's `created_at`); **no description, no cover** (owner 2026-11-08), no genre/year/tags, no file, no reading state (D5). Edition gone (a dangling shelf entry): orphan candidate. Fails: a blank edition title |
| Catalog highlight (`annotations`) | legacy id | Unanchored (ADR-031 row 43): text, note, colour, times, `revision = version`; no file, no locator. One with neither edition nor upload is M3.2's trail. Fails: a blank text, a version below 1 |
| Vocabulary card (`vocabulary_words`) | the survivor's legacy id | Merge below. Fails: a blank word or language, a negative SRS field, an `interval_days` not representable as `numeric` (non-finite or beyond decimal's range; below its precision it becomes 0, accepted), an upload of another user |
| Example (`vocabulary_examples`) | `id = operation_id = uuid_v5(ns, legacy card id)` | One per legacy card with a non-blank sentence, on the survivor. Book: the upload's id, or the catalog pair's book; a deleted edition leaves no book but keeps `book_title`. `chapter_key` = the catalog chapter's `COALESCE(slug, 'ch-' ‖ number)`, only with a book. Hash: `VocabularyPayloads.ExampleSha256` over the survivor's `language` + `word_key` |
| Review (`vocabulary_reviews`) | legacy id; `operation_id = uuid_v5(ns, legacy id)` | On its card's survivor; `client_recorded_at` = `created_at` truncated to ms (stored and hashed: `VocabularyPayloads.ReviewSha256`); `created_at` exact. Fails: another user's card, a blank mode, a negative time or stage |
| Insight (`book_insight`) | legacy id | `book_id` = the upload's id or the pair's book. Fails: `source` not `mcp`, `review_json` without `chapter_slug`, an upload of another user |
| Review question (`review_question`) | legacy id | As stored, `prompt_hash` verbatim (a legacy hash is kept, never recomputed). Fails: another user's insight, a negative SRS field |
| Session (`reading_sessions`) | legacy id = `client_session_id` | `book_id` = the upload's id, or the pair's book if the pair is carried; a session-only pair (no intent row), a deleted edition or upload → `book_id` NULL, **seconds kept** (owner 2026-11-08); a session-only pair is listed as an orphan candidate, carried anyway. `deleted_book_sha256` as stored. Fails: a percent outside 0..1, a negative duration or word count, a sha256 not lowercase hex, an upload of another user |

**Vocabulary case merge (ADR-031 decided item 4).** Group key: `(user, WordKeys.Language(language),
WordKeys.Of(word))`: trimmed, invariant-lowercased, the API's own functions ("Run", "run" and " RUN " in
`EN` are one card). Ranking: the higher `total_reviews`, then the newer `updated_at`, then the lower id (a
full tie is still deterministic); the first is the survivor. The card is the survivor's row: its spelling,
schedule (`stage`, `interval_days`, `consecutive_correct`, `next_review_at`, `last_reviewed_at`),
`created_at`/`updated_at`. Edge cases:
- **A loser has a translation or definition the survivor lacks** (owner 2026-11-08): the survivor takes it,
  per field, from the best-ranked loser that has one; a survivor's own (non-blank) value is never replaced.
- **Both cards have reviews**: every review of both moves to the survivor; the schedule stays the survivor's.
- **Both have sentences**: each becomes its own example on the survivor (with its own book/chapter).
- **Retired**: the survivor's `is_retired` → `retired_at` (its `retired_at`, or `updated_at` when that is
  null); a loser's retirement is not carried.

**Validation** (plan §5.2 parts 5–8; a real run, after the write, reading V2 back): `catalog: intent pair
incomplete` (completeness per intent pair: its book and every annotation as mapped), `vocabulary_words:
parity (SRS fields equal)`, `vocabulary: review count differs` (a group's legacy reviews vs its survivor's V2
reviews), `book_insight: parity` and `review_question: parity` (insight hashes equal, as every column
compared), `reading_sessions: parity` and `reading_sessions: seconds per user differ` (all legacy sessions vs
all V2 ones, per user carried; a V2-only user's sessions are cleanup lines, not this failure). On a dry and a
real run: `unknown-user-ids` (V2 rows of any table etl-v2 writes whose owner is in neither legacy nor V2 users;
ids `table/user`). A V2-only user's rows fail nothing: each is a "V2 row with no legacy row" cleanup line,
report-only like the user (owner 2026-11-08).

A catalog chapter's blank legacy slug falls back to `ch-<number>`, as a null one does. A legacy card with both
`user_book_id` and `edition_id` keeps its example on the upload and is listed in `cleanupActions`.
