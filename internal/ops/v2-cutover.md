# V2 cutover runbook (M5, #1031)

The production flip from the legacy database to `textstack_v2` ([v2-plan §5.3](../../docs/internal/v2/v2-plan.md)).
The ETL step links to [v2-etl.md](v2-etl.md) and does not repeat it. Rehearsed on 2026-11-17:
[v2-cutover-rehearsal-2026-11-17.md](v2-cutover-rehearsal-2026-11-17.md).

**Where each command runs.** `[server]` = a shell on the production server, in the project directory.
`[mac]` = the owner's Mac, in a checkout of the repo. Every `[server]` block assumes:

```sh
# [server]
cd /home/vasyl/projects/onlinelib/textstack
dc() { docker compose --profile mcp -f docker-compose.yml -f docker-compose.gpu.yml "$@"; }   # what deploy.yml runs
T0=$(date +%s); log() { echo "$(date -u +%T) +$(( $(date +%s) - T0 ))s $*" | tee -a ~/archive/v2-cutover-$(date +%F).log; }
mkdir -p ~/archive && chmod 700 ~/archive
```

**Rule for every step:** if the output is not what the step says, stop. Before step 6 (the flip) there is nothing
to undo except the freeze: [unfreeze](#9-unfreeze) and investigate. From step 6 on, go to [ROLLBACK](#rollback).

**Archive.** `~/archive/` on the server is outside every backup path: restic takes `data/storage`, `data/library`,
`.env` and the stdin dumps (`backup.yml`), and the local prune touches only `~/backups/textstack/` (`db-*`,
`storage-*`, `pre-deploy-*`, V2 dumps). A copy goes to the owner's Mac; the SHA-256 goes into the log.

## 0. Preconditions (the day before, and again at the start)

| Check | Command | Expected | Stop if |
|---|---|---|---|
| The rehearsal is green | the rehearsal doc | verdict green (2026-11-17, after the Android re-run on `b75ae9f7`) | any FAIL |
| Deployed build = `main` | `[server]` `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' textstack_api_prod \| sed -n 's/^SENTRY_RELEASE=//p'; git rev-parse --short=12 HEAD` and `[mac]` `git fetch -q && git rev-parse --short=12 origin/main` | three equal shas | they differ: wait for the deploy |
| No deploy during the window | `[mac]` `gh pr list --state open --json number,autoMergeRequest -q '.[]\|select(.autoMergeRequest)\|.number'` | empty (disable each listed auto-merge) | a deploy is running: `gh run list --workflow deploy.yml -L 1` |
| Owner's phone runs the new build | owner, on the phone: Profile → version | the build that contains the #1374 fix | older build |
| V2 schema current | `[server]` `make migrate-v2-status` | no pending versions | pending: `make migrate-v2` first |
| Legacy is ready | `[server]` `curl -s localhost:8080/health/ready` | `"db":{"status":"ok","mode":"legacy"}`, `"v2":{"status":"off"}` (the flag is still off before the flip: expected) | `db` not ok, or mode not `legacy` |
| Disk for the dump | `[server]` `df -h ~ && du -sh data/postgres-prod` | free > 2 × the DB size | less |
| `.env` copy | `[server]` `cp .env ~/archive/env.pre-v2-cutover && chmod 600 ~/archive/env.pre-v2-cutover` | file exists | — |

Owner decisions (2026-11-17):
- **Rehearsal:** the seeded end-to-end run plus the real-data restore drill count as the rehearsal. It is green once
  the Android rows pass again after #1374's fix. The real dump time is measured live, in this freeze.
- **Window:** right after a green rehearsal. The owner updates the phone app.
- **Archive:** `~/archive/` on the server plus a copy on the Mac, sha256 in the log (step 3).
- **ssg-worker:** stopped at the cutover (step 2). In V2 mode deploy.yml no longer starts or restarts it
  (`--scale ssg-worker=0` when `.env` says `DATABASE_MODE=v2`). The rollback starts it by hand.

Keep the incident template open (`internal/incidents/_TEMPLATE.md`).

## 1. Freeze HTTP writes

```sh
# [server]
log freeze; sed -i 's/^MAINTENANCE_WRITE_FREEZE=.*/MAINTENANCE_WRITE_FREEZE=true/' .env
grep -q '^MAINTENANCE_WRITE_FREEZE=true' .env || echo 'MAINTENANCE_WRITE_FREEZE=true' >> .env
dc up -d --force-recreate --no-deps api && until curl -sf localhost:8080/health >/dev/null; do sleep 1; done
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/auth/login -H 'Content-Type: application/json' -d '{}'
log frozen
```

Expected: `503` (body `{"error":"write_frozen"}`). Reads still 200. Stop if 401/400: the freeze is not on.

## 2. Stop and drain every other writer

```sh
# [server]
systemctl --user stop seo-publish-poller seo-backfill-poller quality-poller 2>/dev/null; systemctl --user --no-pager list-units '*poller*'
. ./.env && docker exec -i textstack_db_prod psql -XA -F' | ' -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
SELECT 'user_ingestion_jobs' j, count(*) FILTER (WHERE status = 1) running, count(*) FILTER (WHERE status = 0) queued FROM user_ingestion_jobs
UNION ALL SELECT 'ingestion_jobs', count(*) FILTER (WHERE status = 1), count(*) FILTER (WHERE status = 0) FROM ingestion_jobs
UNION ALL SELECT 'book_quality_jobs', count(*) FILTER (WHERE status = 1), count(*) FILTER (WHERE status = 0) FROM book_quality_jobs
UNION ALL SELECT 'auto_publish_jobs', count(*) FILTER (WHERE status IN (1,2,4)), count(*) FILTER (WHERE status = 0) FROM auto_publish_jobs
UNION ALL SELECT 'seo_backfill_jobs', count(*) FILTER (WHERE status = 1), count(*) FILTER (WHERE status = 0) FROM seo_backfill_jobs
UNION ALL SELECT 'ssg_rebuild_jobs', count(*) FILTER (WHERE status IN ('Running','1')), count(*) FILTER (WHERE status IN ('Queued','0')) FROM ssg_rebuild_jobs;
SQL
```

Expected: `running` = 0 on every row. A `book_quality_jobs` row in status 2 is a finished review waiting for an
admin, not running. The unit list may show `codegen-poller` crash-looping: not a TextStack writer, harmless,
leave it. A running job: wait and re-run the query (an ingestion takes seconds to a
minute). A queued `user_ingestion_jobs` row is carried as a non-ready upload (`cleanupActions`), not lost. Then:

```sh
# [server]
dc stop worker ssg-worker && log writers-stopped
. ./.env && docker exec textstack_db_prod psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT usename, application_name, state, count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1,2,3"
```

Expected: only the api's idle pool connections. Any `active` session from something else (a psql, a CLI): find it
and end it before going on.

## 3. Archive the legacy database

```sh
# [server]
log dump-start; . ./.env; A=~/archive/textstack-legacy-$(date +%F).sql.gz
POSTGRES_USER=$POSTGRES_USER bash infra/scripts/pg-dump-checked.sh "$POSTGRES_DB" "$A" \
  && (cd ~/archive && sha256sum "$(basename "$A")" | tee "$(basename "$A").sha256" && sha256sum -c "$(basename "$A").sha256")
log "dump-done $(cut -d' ' -f1 "$A.sha256")"; ls -lh "$A"
```

Expected: `Dumped <db>: textstack-legacy-<date>.sql.gz`, then `…: OK`. Stop on `no dump-complete trailer`.

```sh
# [mac] (copy, then the same checksum)
mkdir -p ~/Archive/textstack && scp "asus:archive/textstack-legacy-$(date +%F).sql.gz*" ~/Archive/textstack/ \
  && (cd ~/Archive/textstack && shasum -a 256 -c "textstack-legacy-$(date +%F).sql.gz.sha256")
```

Expected: `OK`. The copy can run while steps 4–5 go on; it must be `OK` before [M6 drops legacy](../../docs/internal/v2/v2-plan.md).

## 4. Tag the legacy release

```sh
# [mac]
SHA=<the sha from step 0>; git fetch -q origin && git tag -a pre-v2-cutover "$SHA" -m "Last legacy-mode release before the V2 flip (#1031)" && git push origin pre-v2-cutover
```

Expected: `* [new tag] pre-v2-cutover -> pre-v2-cutover`.

## 5. ETL and validation

The source role and the large-object preflight, once: [v2-etl.md §1](v2-etl.md#1-the-source-role-etl_reader)
(Provision, then Preflight; the preflight must print `0`). The `etl_reader` password can be made on the server
and never shown: in one ssh session, `ETL_READER_PASSWORD=$(openssl rand -hex 24); export ETL_READER_PASSWORD`,
the scripted Provision, then build the connection string from the same variable
(`export ConnectionStrings__Default="Host=db;Port=5432;Database=$POSTGRES_DB;Username=etl_reader;Password=$ETL_READER_PASSWORD"`)
instead of the `read -rs` below. Nothing prints it; `unset` both at the end. Then:

```sh
# [server]
read -rs ConnectionStrings__Default && export ConnectionStrings__Default   # Host=db;Port=5432;Database=<POSTGRES_DB>;Username=etl_reader;Password=…
log etl-dry; make etl-v2 ARGS=--dry-run > ~/archive/etl-dry.json; echo "exit=$?"
log etl-run; make etl-v2 ARGS="--source-dump-sha $(cut -d' ' -f1 ~/archive/textstack-legacy-$(date +%F).sql.gz.sha256)" > ~/archive/etl-run.json; echo "exit=$?"
unset ConnectionStrings__Default
python3 -c "import json;d=json.load(open('$HOME/archive/etl-run.json'));print(d['runId'], len(d['checks']), 'checks', sum(not c.get('passed',True) for c in d['checks']), 'failed')"
```

Expected: both `exit=0`; the run prints its `runId`, `N checks 0 failed`. Exit 1 = refused or failed: stop
([unfreeze](#9-unfreeze); the report on stdout names the check). Then the SQL validator:

```sh
# [server]
log validate; . ./.env; V2DB=${V2_POSTGRES_DB:-textstack_v2}
docker exec -i -e V2DB=$V2DB textstack_db_prod sh -c 'psql -X -A -F" | " -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v v2="dbname=$V2DB user=$POSTGRES_USER" -f -' \
  < database/v2/scripts/validate-etl.sql > ~/archive/validate.txt; echo "exit=$?"
awk -F' \\| ' 'NR>1 && NF==3 {print $2}' ~/archive/validate.txt | sort | uniq -c; log validated
```

Expected: `exit=0`, only `ok` and `report` rows, **0 `FAIL`**. Exit 3 or any `FAIL`: stop, unfreeze, keep legacy.

## 6. Flip

Legacy read-only first (new sessions only, so before the recreate), then the mode:

```sh
# [server]
log flip; . ./.env
docker exec textstack_db_prod psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" SET default_transaction_read_only = on"
sed -i 's/^DATABASE_MODE=.*/DATABASE_MODE=v2/; s/^FEATURES_V2API=.*/FEATURES_V2API=true/' .env
grep -q '^DATABASE_MODE=' .env || echo 'DATABASE_MODE=v2' >> .env; grep -q '^FEATURES_V2API=' .env || echo 'FEATURES_V2API=true' >> .env
grep -E '^(DATABASE_MODE|FEATURES_V2API|MAINTENANCE_WRITE_FREEZE)=' .env
dc up -d --force-recreate --no-deps api worker mcp-server && until curl -sf localhost:8080/health >/dev/null; do sleep 1; done
docker exec textstack_mcp_prod printenv TEXTSTACK_MCP_V2; sleep 31; curl -s localhost:8080/health/ready; echo; log flipped
```

Expected: `ALTER DATABASE`; the three lines `DATABASE_MODE=v2`, `FEATURES_V2API=true`, `MAINTENANCE_WRITE_FREEZE=true`;
MCP prints `true`; readiness `"db":{"status":"ok","mode":"v2"}`, `"legacy":{"status":"ok"}`, `"v2":{"status":"ok"}`.
`ssg-worker` stays stopped (catalog frozen; its writes would hit a read-only database).
Stop (→ ROLLBACK) on a 503 readiness or `mode":"legacy"`.

Frozen checks: `curl -s -w ' %{http_code}\n' localhost:8080/me/bookmarks` → `{"error":"gone_in_v2"} 410`;
`docker logs --since 2m textstack_api_prod 2>&1 | grep -iE 'exception|25006|read-only transaction' | grep -v ollama` → empty.

## 7. Unfreeze

```sh
# [server]
log unfreeze; sed -i 's/^MAINTENANCE_WRITE_FREEZE=.*/MAINTENANCE_WRITE_FREEZE=false/' .env
dc up -d --force-recreate --no-deps api && until curl -sf localhost:8080/health >/dev/null; do sleep 1; done; log unfrozen
```

From here V2 takes writes. A rollback from now on loses them (see ROLLBACK).

## 8. Smoke (owner's real account; 10 minutes)

| # | Where | Do | Pass |
|---|---|---|---|
| 1 | web | sign in at textstack.app (Google) | signed in, no error toast |
| 2 | web | Library | every upload listed (count = the ETL's `books` inserted+unchanged for that user) |
| 3 | web | open an EPUB from its book page (Continue Reading) | V2 reader (`iframe[title="Book text"]`), status `NN% · <chapter>` near the old place (a carried EPUB place resumes by its book fraction, #1187) |
| 4 | web | open a PDF | the carried page |
| 5 | web | select text → Highlight | saved; reload shows it |
| 6 | web | tap a word | saved in Vocabulary |
| 7 | web | `/en/stats` | redirects home; no Stats link in the header |
| 8 | Android (new build) | sign in, Library, open the EPUB and the PDF | books listed, both open at their place |
| 9 | Claude connector | `search_my_library`, `get_my_book`, `get_my_chapter`, `get_my_reading`, `get_book_progress`, `set_book_progress`, `list_my_book_highlights`, `save_my_highlight`, `save_insight`, `get_my_insights` on one migrated book | each answers without an error |
| 10 | server | `docker logs --since 15m textstack_api_prod 2>&1 \| grep -c 'Gone in V2'` and the lines | only routes old clients call |

Any FAIL in 1–9: ROLLBACK now (the sooner, the fewer V2 writes are lost). Then log, and leave
`etl_reader` for the next attempt or clean it up ([v2-etl.md §1 Clean up](v2-etl.md#clean-up)).

## 9. Unfreeze (abort before the flip)

Only when stopping before step 6: legacy was never touched.

```sh
# [server]
sed -i 's/^MAINTENANCE_WRITE_FREEZE=.*/MAINTENANCE_WRITE_FREEZE=false/' .env
dc up -d --force-recreate --no-deps api && dc start worker ssg-worker
systemctl --user start seo-publish-poller seo-backfill-poller quality-poller 2>/dev/null; log aborted
```

## ROLLBACK

Back to legacy, exactly as before step 1. **What is lost:** every write V2 took after step 7: highlights,
words, reviews, reading places, sessions, uploads, insights, MCP writes (rehearsal: 2 highlights, 1 word, an MCP
place, highlight and insight; all absent after the rollback, legacy byte-identical to its pre-flip fingerprint).
They stay in `textstack_v2`; nothing replays them.

```sh
# [server]
log rollback; . ./.env
sed -i 's/^MAINTENANCE_WRITE_FREEZE=.*/MAINTENANCE_WRITE_FREEZE=true/' .env
dc up -d --force-recreate --no-deps api && dc stop worker
docker exec textstack_db_prod psql -XAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "ALTER DATABASE \"$POSTGRES_DB\" RESET default_transaction_read_only"
docker exec textstack_db_prod psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SHOW default_transaction_read_only'
sed -i 's/^DATABASE_MODE=.*/DATABASE_MODE=legacy/; s/^FEATURES_V2API=.*/FEATURES_V2API=false/' .env
dc up -d --force-recreate --no-deps api worker mcp-server && until curl -sf localhost:8080/health >/dev/null; do sleep 1; done
sleep 31; curl -s localhost:8080/health/ready; echo
sed -i 's/^MAINTENANCE_WRITE_FREEZE=.*/MAINTENANCE_WRITE_FREEZE=false/' .env
dc up -d --force-recreate --no-deps api
dc up -d --no-deps ssg-worker   # by hand: a V2-mode deploy removed its container (scale 0)
systemctl --user start seo-publish-poller seo-backfill-poller quality-poller 2>/dev/null; log rolled-back
```

Expected: `off`; readiness `"mode":"legacy"`, `"v2":{"status":"off"}`; MCP `TEXTSTACK_MCP_V2=false`. Then smoke on
legacy: web Library lists the books, Continue Reading opens the old reader at its chapter, the Android app lists
the library. Rehearsal: 8 s from the rollback freeze to legacy up, 48 s to unfrozen (31 s of it the readiness cache).

Expected for `ssg-worker`: `docker ps --filter name=textstack_ssg_worker` shows it Up. The next deploy keeps it
running, because `.env` says `legacy` again.

**Re-cutover after a rollback.** The ETL does not converge onto a V2 database that took writes. Those rows now
differ from the legacy mapping (a place moved, a word added), and the ETL fails `<table>: V2 row differs from its
legacy mapping` and keeps the V2 row. Before a second attempt, rebuild V2 from nothing:

```sh
# [server] (legacy is serving again, V2 is off)
. ./.env; V2DB=${V2_POSTGRES_DB:-textstack_v2}
POSTGRES_USER=$POSTGRES_USER bash infra/scripts/pg-dump-checked.sh "$V2DB" ~/archive/$V2DB-after-rollback-$(date +%F).sql.gz
make migrate-v2-drop CONFIRM=$V2DB && make migrate-v2 && make migrate-v2-status
```

Expected: `Dumped …`, then the migrator lists every version as applied, none pending. The V2 writes lost to the
rollback are in that dump only; nothing replays them. Then start again at step 0, with a new archive dump (legacy
took writes after the rollback).

## After a successful cutover

- `[mac]` `gh issue comment 1031` with the log's timings and the validate counts; tick #1013.
- Leave legacy read-only and the large-object revoke in place; drop `etl_reader` ([v2-etl.md §1 Clean up](v2-etl.md#clean-up)).
  Legacy is read-only now, so `DROP OWNED BY` needs a read-write transaction of its own:
  `psql … -d "$POSTGRES_DB" -c "BEGIN READ WRITE" -c "DROP OWNED BY etl_reader" -c "COMMIT"`, then `DROP ROLE etl_reader`
  from `-d postgres`. Production log: [v2-cutover-2026-11-17.md](v2-cutover-2026-11-17.md).
- The pollers and `ssg-worker` stay stopped. Deploys leave `ssg-worker` down while `.env` says `DATABASE_MODE=v2`.
  M6 deletes it.
- A deploy's legacy migrator only reads while nothing is pending (`database/migrate.sh`): a new legacy migration
  would fail on the read-only database, as it should.
