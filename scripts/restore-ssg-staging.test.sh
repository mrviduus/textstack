#!/usr/bin/env bash
# Self-check for restore-ssg-staging.sh. Run: bash scripts/restore-ssg-staging.test.sh
# GNU or BSD userland. CI: ci.yml `frontend`, step "Web swap self-check".
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)/restore-ssg-staging.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# $1 = case dir. dist/ssg holds "fresh"; staging holds an older "stale" tree + an asset.
setup() {
  rm -rf "$1"; mkdir -p "$1/dist/ssg/en" "$1/dist/assets" "$1/stg/ssg/en" "$1/stg/assets"
  echo fresh > "$1/dist/ssg/en/index.html"
  echo stale > "$1/stg/ssg/en/index.html"
  echo old > "$1/stg/assets/old.js"
}

# pulled + live dist/ssg: the stale copy is dropped, dist untouched.
setup "$T/a"
bash "$R" pulled "$T/a/dist" "$T/a/stg" > /dev/null
[ "$(cat "$T/a/dist/ssg/en/index.html")" = fresh ] || fail "pulled: fresh dist/ssg replaced by stale staging"
[ ! -e "$T/a/stg" ] || fail "pulled: stale staging not removed"
[ ! -e "$T/a/dist/assets/old.js" ] || fail "pulled: stale assets copied in"

# pulled + dist/ssg missing (a deploy died after the snapshot): restored.
setup "$T/b"; rm -rf "$T/b/dist/ssg"
bash "$R" pulled "$T/b/dist" "$T/b/stg" > /dev/null
[ "$(cat "$T/b/dist/ssg/en/index.html")" = stale ] || fail "pulled: missing dist/ssg not restored"
[ -e "$T/b/dist/assets/old.js" ] && [ ! -e "$T/b/stg" ] || fail "pulled: assets not restored or staging kept"

# built: unchanged behaviour — the snapshot goes back over whatever is there.
setup "$T/c"; rm -rf "$T/c/dist/ssg"; echo new > "$T/c/dist/assets/old.js"
bash "$R" built "$T/c/dist" "$T/c/stg" > /dev/null
[ "$(cat "$T/c/dist/ssg/en/index.html")" = stale ] || fail "built: snapshot not restored"
[ "$(cat "$T/c/dist/assets/old.js")" = new ] || fail "built: restore clobbered vite's asset"
[ ! -e "$T/c/stg" ] || fail "built: staging kept"

# No staging: nothing happens, both modes.
setup "$T/d"; rm -rf "$T/d/stg"
bash "$R" pulled "$T/d/dist" "$T/d/stg" > /dev/null
bash "$R" built "$T/d/dist" "$T/d/stg" > /dev/null
[ "$(cat "$T/d/dist/ssg/en/index.html")" = fresh ] || fail "no staging: dist changed"

bash "$R" bogus "$T/d/dist" "$T/d/stg" > /dev/null 2>&1 && fail "accepted an unknown MODE"
echo "ok — restore-ssg-staging"
