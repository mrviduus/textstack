#!/usr/bin/env bash
# Queue a Full SSG rebuild and follow it until it ends. `make rebuild-ssg` runs this on the server.
#
# It goes through the job queue — the same POST the nightly backup makes — so ssg-worker renders it
# with all of its guards (survival floor, carry-forward of failed routes, stall detection, Sentry).
# Ctrl-C stops following, not the job. Exit 0 only when the job ends Completed.
#
# SSG_API_URL     the API, default http://localhost:8080 (it must see the request as local)
# SSG_POLL_SECS   seconds between checks, default 10
# The job row is read with `docker compose exec db`, so COMPOSE_PROJECT_NAME / COMPOSE_FILE apply.

set -euo pipefail

API="${SSG_API_URL:-http://localhost:8080}"
POLL="${SSG_POLL_SECS:-10}"

sql() {
  docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -F " " -c "$0"' "$1"
}

resp=$(curl -sS --fail-with-body -X POST "$API/internal/ssg/rebuild-all")
echo "$resp"
job=$(printf '%s' "$resp" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
if [ -z "$job" ]; then
  # "skipped": a Full rebuild is already queued or running — follow that one.
  job=$(sql "SELECT id FROM ssg_rebuild_jobs WHERE mode = 'Full' AND status IN ('Queued','Running') ORDER BY created_at DESC LIMIT 1")
  [ -n "$job" ] || { echo "No job to follow" >&2; exit 1; }
fi
echo "Following job $job (Ctrl-C stops following, not the job)"

while :; do
  read -r status rendered failed total <<<"$(sql "SELECT status, rendered_count, failed_count, total_routes FROM ssg_rebuild_jobs WHERE id = '$job'")"
  case "$status" in
    Completed) echo "Completed: $rendered rendered, $failed failed of $total"; exit 0 ;;
    Failed | Cancelled)
      echo "$status: $rendered rendered, $failed failed of $total" >&2
      sql "SELECT error FROM ssg_rebuild_jobs WHERE id = '$job'" >&2
      exit 1 ;;
    "") echo "Could not read job $job (database down?). The job itself is unaffected." >&2; exit 1 ;;
    *) echo "$(date +%T) ${status:-?}: $rendered rendered, $failed failed of $total" ;;
  esac
  sleep "$POLL"
done
