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
fails closed (`NoValidationChecks`): until M3.2 adds count parity, every real run ends `failed`, by
design. A dry run writes no gate row, so with 0 checks it exits 0 with its report and warns
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
