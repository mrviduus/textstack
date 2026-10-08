#!/usr/bin/env bash
# Queue a Full SSG rebuild and follow it until it ends. `make rebuild-ssg` runs this on the server.
#
# It goes through the job queue — the same POST the nightly backup makes — so ssg-worker renders it
# with all of its guards (survival floor, carry-forward of failed routes, stall detection, Sentry).
# Ctrl-C stops following, not the job. Exit 0 only when a job that read its routes after this call
# ends Completed.
#
# SSG_API_URL             the API, default http://localhost:8080 (it must see the request as local)
# SSG_POLL_SECS           seconds between checks, default 10
# SSG_START_TIMEOUT_SECS  give up if ssg-worker has not started the job by then, default 300
# SSG_STALL_TIMEOUT_SECS  give up if the job's counts do not move for this long, default 1800. Generous
#                         on purpose: the retry pass writes its counts only when it ends, and the
#                         worker stops its own stalled jobs after 5 min — this is for a dead worker.
# The job row is read with `docker compose exec db`, so COMPOSE_PROJECT_NAME / COMPOSE_FILE apply.

set -euo pipefail

API="${SSG_API_URL:-http://localhost:8080}"
POLL="${SSG_POLL_SECS:-10}"
START_TIMEOUT="${SSG_START_TIMEOUT_SECS:-300}"
STALL_TIMEOUT="${SSG_STALL_TIMEOUT_SECS:-1800}"

sql() {
  docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " " -c "$0"' "$1"
}

# follow JOB → 0 Completed, 1 Failed/Cancelled, 2 gave up (the job itself is left alone).
# ssg-worker claims a job by setting it Running (ADR-022), but the API fills total_routes at enqueue,
# so a job counts as started once the worker has written a count, which it does after every batch
# (the first within ~30 s, the navigation timeout).
follow() {
  local job=$1 since status rendered failed total moved=-1 done_now
  since=$(date +%s)
  echo "Following job $job (Ctrl-C stops following, not the job)"
  while :; do
    read -r status rendered failed total <<<"$(sql "SELECT status, rendered_count, failed_count, total_routes FROM ssg_rebuild_jobs WHERE id = '$job'")"
    case "$status" in
      Completed) echo "Completed: $rendered rendered, $failed failed of $total"; return 0 ;;
      Failed | Cancelled)
        echo "$status: $rendered rendered, $failed failed of $total" >&2
        sql "SELECT error FROM ssg_rebuild_jobs WHERE id = '$job'" >&2
        return 1 ;;
      "") echo "Could not read job $job (database down?). The job itself is unaffected." >&2; return 2 ;;
    esac
    echo "$(date +%T) $status: $rendered rendered, $failed failed of $total"
    done_now=$((rendered + failed))
    if [ "$done_now" -gt 0 ] && [ "$done_now" -ne "$moved" ]; then moved=$done_now since=$(date +%s); fi
    if [ "$done_now" -eq 0 ] && [ $(($(date +%s) - since)) -ge "$START_TIMEOUT" ]; then
      echo "ssg-worker has not started job $job in ${START_TIMEOUT}s. Check it: docker compose ps ssg-worker;" \
        "docker compose logs --tail 50 ssg-worker; then docker compose restart ssg-worker. The job stays queued." >&2
      return 2
    fi
    if [ "$done_now" -gt 0 ] && [ $(($(date +%s) - since)) -ge "$STALL_TIMEOUT" ]; then
      echo "Job $job has not moved in ${STALL_TIMEOUT}s; ssg-worker is probably dead. Check it:" \
        "docker compose logs --tail 50 ssg-worker; docker compose restart ssg-worker." >&2
      return 2
    fi
    sleep "$POLL"
  done
}

while :; do
  resp=$(curl -sS --fail-with-body -X POST "$API/internal/ssg/rebuild-all")
  echo "$resp"
  job=$(printf '%s' "$resp" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  if [ -n "$job" ]; then
    rc=0; follow "$job" || rc=$?
    exit $((rc == 0 ? 0 : 1))
  fi

  # "skipped": a Full rebuild is already Queued (the API skips only for Queued, not Running). ssg-worker
  # has not claimed it yet, so it reads its routes after this call and its result is ours. It may have
  # been claimed since the POST, so look for the newest Full in either state.
  job=$(sql "SELECT id FROM ssg_rebuild_jobs WHERE mode = 'Full' AND status IN ('Queued','Running') ORDER BY created_at DESC LIMIT 1")
  [ -n "$job" ] || { sleep "$POLL"; continue; } # it ended between the POST and the query; ask again
  echo "A Full rebuild was already queued; following it."
  rc=0; follow "$job" || rc=$?
  exit $((rc == 0 ? 0 : 1))
done
