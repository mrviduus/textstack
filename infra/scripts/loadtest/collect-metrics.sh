#!/usr/bin/env bash
#
# Prod-side metric collector for load tests.
#
# Run two modes via the first argument:
#   start <out-dir>   — kick off background samplers writing into <out-dir>
#   stop  <out-dir>   — terminate samplers, write a small summary, tar the dir
#
# Sampling interval is 2 seconds for system stats and 5 seconds for the
# Ollama process snapshot. Everything is appended; the orchestrator decides
# when to start and stop so the timeline covers exactly one scenario.
#
# Designed to be invoked over ssh — keeps the runtime dependency surface
# tiny: bash, awk, docker, cat, date. No sysstat assumed (mpstat falls
# back to /proc/stat snapshots if absent).
set -u

MODE="${1:-}"
OUT="${2:-}"

if [[ -z "$MODE" || -z "$OUT" ]]; then
    echo "usage: $0 {start|stop|snapshot} <out-dir>" >&2
    exit 64
fi

PIDFILE="$OUT/.collector.pids"

snapshot_once() {
    local label="$1"
    {
        echo "===== $label @ $(date -u --iso-8601=seconds) ====="
        echo "--- uptime ---"; uptime
        echo "--- thermal_zone0/temp (milli-°C) ---"
        cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "n/a"
        echo "--- free -h ---"; free -h
        echo "--- df / ---"; df -h / | head -3
        echo "--- docker ps healthcheck ---"
        docker ps --format 'table {{.Names}}\t{{.Status}}' | head -15
        echo "--- docker stats (single) ---"
        docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}' \
            | head -10
        echo "--- ollama ps ---"
        (cd "$HOME/projects/onlinelib/textstack" && docker compose exec -T ollama ollama ps 2>/dev/null) \
            || echo "ollama unreachable"
    } >> "$OUT/snapshots.log"
}

case "$MODE" in
start)
    mkdir -p "$OUT"
    # Truncate so reruns don't double up.
    : > "$OUT/vmstat.log"
    : > "$OUT/thermal.log"
    : > "$OUT/docker-stats.log"
    : > "$OUT/ollama-ps.log"
    : > "$OUT/snapshots.log"
    : > "$PIDFILE"

    # vmstat: 2s tick, indefinite count. Captures CPU us/sy/id/wa, swap, IO,
    # interrupt + context-switch — the system-wide timeline.
    nohup vmstat 2 >> "$OUT/vmstat.log" 2>/dev/null &
    echo "$!" >> "$PIDFILE"

    # Thermal: cat sysfs, 2s tick. Three columns: epoch, raw milli-°C, °C.
    nohup bash -c '
        while :; do
            t=$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null)
            [ -n "$t" ] && printf "%s %s %.1f\n" "$(date -u +%s)" "$t" "$(awk -v t=$t '"'"'BEGIN{print t/1000}'"'"')"
            sleep 2
        done
    ' >> "$OUT/thermal.log" 2>/dev/null &
    echo "$!" >> "$PIDFILE"

    # docker stats: 5s tick. Per-container CPU + mem + net + block IO.
    nohup bash -c '
        while :; do
            printf "===== %s =====\n" "$(date -u --iso-8601=seconds)"
            docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}\t{{.BlockIO}}" \
                | head -10
            sleep 5
        done
    ' >> "$OUT/docker-stats.log" 2>/dev/null &
    echo "$!" >> "$PIDFILE"

    # ollama ps: 10s tick, captures resident model + context window.
    nohup bash -c '
        cd "$HOME/projects/onlinelib/textstack" || exit
        while :; do
            printf "===== %s =====\n" "$(date -u --iso-8601=seconds)"
            docker compose exec -T ollama ollama ps 2>&1 | head -5
            sleep 10
        done
    ' >> "$OUT/ollama-ps.log" 2>/dev/null &
    echo "$!" >> "$PIDFILE"

    echo "collector started, pids=$(tr '\n' ' ' < "$PIDFILE")"
    ;;

stop)
    if [[ -f "$PIDFILE" ]]; then
        while IFS= read -r pid; do
            [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
        done < "$PIDFILE"
        rm -f "$PIDFILE"
    fi
    echo "collector stopped"
    ;;

snapshot)
    snapshot_once "${3:-snapshot}"
    echo "snapshot appended"
    ;;

*)
    echo "unknown mode: $MODE" >&2
    exit 64
    ;;
esac
