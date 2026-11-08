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
etl-v2 reads (the list in the script: `EtlV2.SourceCounts` plus each step's `SourceTables`). It has no ownership, no
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

**Not covered by the audit, by decision.** PUBLIC holds both by default, and closing either means
revoking from PUBLIC, which the application role relies on. So both are reported here, not changed:
- `TEMP` on the database: temporary tables die with the session and never persist.
- The large-object functions (`lo_create`, `lo_from_bytea`, …): EXECUTE is granted to PUBLIC. They fail
  in a read-only transaction, which is etl-v2's default; a session that switched that off could create
  a large object. Closing it means `REVOKE EXECUTE ON FUNCTION lo_create(oid), … FROM PUBLIC`, an owner
  decision about the application's privileges.

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
fails closed (`NoValidationChecks`). A dry run writes no gate row, so with 0 checks it exits 0 with its report and warns
`0 validation checks ran (no mapper steps yet)` on stderr: its exit code stays the audit's verdict. In a
dry run, steps compute and count what they would write; nothing is written (not even rolled back: a
rolled-back transaction still advances sequences).

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

## 4. M3.3 mappers: catalog pairs, vocabulary, insights, sessions

Steps `catalog`, `vocabulary`, `insights`, `sessions`, `unknown-users`, in that order, after M3.2's
(`backend/src/Infrastructure/Persistence/Etl/Steps/`). They write with their own inline SQL, not the API
repositories: those stamp `now()` and move the schedule, and a migrated row keeps its legacy times and
SRS state; the schema's CHECKs and FKs hold either way.

**One rule for every aggregate.** A planned row is compared with the target row under its id:
absent → inserted (a dry run counts it: check `<table>: would insert N, unchanged M`); equal → nothing;
different → a **mismatch**: never overwritten, listed by id in `cleanupActions`, and a failure of
`<table>.target-matches-source`. No `ON CONFLICT`: a unique key held by another row fails the run. A
source row the target's CHECK/FK would refuse is **unmappable**: listed by id, a failure of
`<table>.unmappable`, never carried half. A row whose user (or edition, or insight) is not there is an
**orphan candidate**: listed by id in `orphanCandidates`, not carried, not a failure, never deleted.
"Known users" = the target's `users` (a dry run adds the source's: the users step would have written them).

| Aggregate (target) | Id | Conflict / edge rule |
|---|---|---|
| Catalog pair (`books`) | `uuid_v5(ns, user ‖ edition)`, ns = `uuid_v5(nil, "textstack-v2")`, names in RFC byte order | Pair = catalog plan §3.4's intent query minus bookmarks (`user_libraries`, `reading_progresses`, catalog `highlights`, `vocabulary_words`, `pending_vocabulary_words`, `word_lookups`, `word_clusters`, `book_insight`, savedbook shelf entries). Row: edition title, first author by credit order, edition language, `origin {"kind":"catalog","editionSlug"}`, `created_at = updated_at` = the pair's first intent; no file, no reading state (D5). Edition gone (dangling shelf entry) or user unknown → orphan. Every column is compared, defaults included |
| Catalog highlight (`annotations`) | legacy id | Unanchored: text, note, colour, times, `revision = version`; no file, no locator. A highlight with neither edition nor upload (its book was deleted) → orphan. Upload highlights are M3.2's |
| Vocabulary card (`vocabulary_words`) | the survivor's legacy id | Merge below. Another card already holding the planned `(user, language, word_key)` → reported (`vocabulary_words.key-held-by-another-card`), the card and its examples and reviews not written |
| Example (`vocabulary_examples`) | `id = operation_id = uuid_v5(ns, legacy card id)` | One per legacy card with a non-blank sentence, on the survivor. Book: the upload's id, or the catalog pair's book; a deleted edition leaves no book but keeps `book_title`. `chapter_key` = the catalog chapter's `COALESCE(slug, 'ch-' ‖ number)`, only with a book. Hash: `VocabularyPayloads.ExampleSha256` over the survivor's `language` + `word_key` |
| Review (`vocabulary_reviews`) | legacy id; `operation_id = uuid_v5(ns, legacy id)` | On its card's survivor; `client_recorded_at` = `created_at` truncated to ms (stored and hashed: `VocabularyPayloads.ReviewSha256`); `created_at` exact |
| Insight (`book_insight`) | legacy id | `book_id` = the upload's id or the pair's book. Unmappable: `source` not `mcp`; `review_json` without `chapter_slug` |
| Review question (`review_question`) | legacy id | As stored, `prompt_hash` verbatim even where today's `OpenThreads.PromptHash` would differ (a legacy hash is kept, never recomputed). Its insight not carried → orphan |
| Session (`reading_sessions`) | legacy id = `client_session_id` | `book_id` = the upload's id, or the pair's book if the pair is carried; a session-only pair (no intent row), a deleted edition or a deleted upload → `book_id` NULL, still counted; reported (session-only) as an orphan candidate, carried anyway. `deleted_book_sha256` as stored. Unmappable: percent outside 0..1, negative duration/words |

**Vocabulary case merge (ADR-031 decided item 4).** Group key: `(user, WordKeys.Language(language),
WordKeys.Of(word))` — trimmed, invariant-lowercased, the API's own functions ("Run", "run" and " RUN "
in `EN` are one card). Survivor: the higher `total_reviews`, then the newer `updated_at`, then the lower
id (a full tie is still deterministic). The card is the survivor's row as it was: its spelling,
translation, definition, schedule (`stage`, `interval_days`, `consecutive_correct`, `next_review_at`,
`last_reviewed_at`), `created_at`/`updated_at`. Edge cases:
- **Both cards have reviews**: every review of both moves to the survivor; the schedule stays the
  survivor's; the loser's schedule is not carried. `vocabulary.review-counts-equal` checks the group's
  legacy review rows = the survivor's V2 reviews.
- **Both have sentences**: each becomes its own example on the survivor (with its own book/chapter).
- **Only the loser has a translation or definition**: dropped with the loser (the survivor's fields only).
- **Retired**: the survivor's `is_retired` → `retired_at` (its `retired_at`, or `updated_at` when that is
  null); a loser's retirement is not carried.
- **Language case** (`en` vs `EN`) merges; a blank word or language after trimming is unmappable.

**Validation checks** (a real run; they read the target back): `catalog.intent-pairs-complete` (every
carried pair's book and annotations as mapped), `vocabulary.srs-fields-equal`,
`vocabulary.review-counts-equal`, `insights.hashes-equal` (canonical-JSON SHA-256 of every mapped column,
insights and questions), `sessions.seconds-per-user-equal` (all legacy sessions of a known user vs the
target), `unknown-user-ids` (rows in these eight tables whose owner is no legacy user or admin). A dry run
registers only the mismatch, unmappable and would-insert checks.
