# shellcheck shell=bash
# Sourced by the host pollers. Usage: claude_isolated <timeout-secs> <claude args...>
#
# Every prompt these scripts send carries untrusted text (book titles, chapter
# HTML, author names), and they used to run claude from the repo dir, next to
# .env. So: an empty throwaway cwd, and no tools at all (`--tools ""`, Claude
# Code 2.1.x) — the model can only answer, not read or run anything. `--tools`
# is variadic, so it must come first or it would swallow the prompt argument.
# stdin and stdout pass through; the exit status is timeout's/claude's.
claude_isolated() {
  local secs="$1"; shift
  (
    d=$(mktemp -d) || exit 1
    trap 'rm -rf "$d"' EXIT
    cd "$d" && timeout "$secs" claude --tools "" "$@"
  )
}
