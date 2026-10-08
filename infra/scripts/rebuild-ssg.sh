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
# SSG_START_TIMEOUT_SECS  give up if the job is still Queued by then, default 300 (it waits behind any
#                         Running job; ssg-worker runs one at a time)
# SSG_STALL_TIMEOUT_SECS  give up if a Running job's counts do not move for this long, default 1800.
#                         Generous on purpose: the retry pass writes its counts only when it ends, and
#                         the worker stops its own stalled jobs after 5 min — this is for a dead worker.
# Giving up never touches the job. Do not restart ssg-worker to "unstick" a Queued job: at startup it
# fails whatever is Running (ADR-022), so a restart kills a healthy render.
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
# Queued = not claimed yet; Running = ssg-worker claimed it (ADR-022). Counts move after every batch.
follow() {
  local job=$1 since status rendered failed total moved=-1 done_now ahead
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
      Queued)
        echo "$(date +%T) Queued"
        if [ $(($(date +%s) - since)) -ge "$START_TIMEOUT" ]; then
          ahead=$(sql "SELECT id FROM ssg_rebuild_jobs WHERE status = 'Running' ORDER BY started_at LIMIT 1")
          if [ -n "$ahead" ]; then
            echo "Job $job is still Queued after ${START_TIMEOUT}s, behind running job $ahead. It stays queued." >&2
          else
            echo "Job $job is still Queued after ${START_TIMEOUT}s and nothing is Running: ssg-worker is not" \
              "claiming. Check docker compose logs --tail 50 ssg-worker. It stays queued." >&2
          fi
          return 2
        fi ;;
      Running)
        echo "$(date +%T) Running: $rendered rendered, $failed failed of $total"
        done_now=$((rendered + failed))
        if [ "$done_now" -ne "$moved" ]; then moved=$done_now since=$(date +%s); fi
        if [ $(($(date +%s) - since)) -ge "$STALL_TIMEOUT" ]; then
          echo "Job $job has not moved in ${STALL_TIMEOUT}s. Check docker compose logs --tail 50 ssg-worker." >&2
          return 2
        fi ;;
    esac
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

  # "skipped": a Full rebuild is already Queued or Running. A Queued one has not read its routes yet,
  # so its result is ours: follow it. A Running one may have read them before this call: wait for it,
  # then ask again.
  read -r job status <<<"$(sql "SELECT id, status FROM ssg_rebuild_jobs WHERE mode = 'Full' AND status IN ('Queued','Running') ORDER BY created_at DESC LIMIT 1")"
  [ -n "$job" ] || { sleep "$POLL"; continue; } # it ended between the POST and the query; ask again
  rc=0
  if [ "$status" = Queued ]; then
    echo "A Full rebuild was already queued; following it."
    follow "$job" || rc=$?
    exit $((rc == 0 ? 0 : 1))
  fi
  echo "A Full rebuild is running and may predate this call. Waiting for it to end, then queuing a new one."
  follow "$job" || rc=$?
  [ "$rc" -ne 2 ] || exit 1
done
