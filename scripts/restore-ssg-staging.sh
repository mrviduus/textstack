#!/usr/bin/env bash
# Puts back what deploy.yml's "Snapshot SSG dir" step moved aside, or drops a stale copy.
#
#   scripts/restore-ssg-staging.sh MODE DIST STAGING
#
#   MODE     built  — the server built the web this run (vite wiped dist; snapshot ran)
#            pulled — the bundle came from GHCR (dist never wiped; snapshot skipped)
#   DIST     apps/web/dist
#   STAGING  apps/web/.ssg-staging
#
# built: put the snapshot back. ssg/ goes back as-is; assets are restored non-clobbering
# (vite's new files win where names collide), so dist/assets holds the NEW bundle and the
# OLD one the SSG pages reference, side by side, until ssg-worker swaps in a fresh tree.
#
# pulled: nothing was snapshotted this run, so any staging is left over from a deploy that
# died between snapshot and restore. Restore it only if dist/ssg is missing — that is the
# case it exists for. If dist/ssg is there, it is newer than the staging copy (ssg-worker
# has rebuilt since), and restoring would replace it with older pages, through an rm -rf
# that leaves crawlers no ssg/ at all for the length of the copy. Drop the stale copy instead.
set -euo pipefail

MODE=${1:?MODE}; DIST=${2:?DIST}; STAGING=${3:?STAGING}
case $MODE in built|pulled) ;; *) echo "::error::MODE must be built or pulled, not '$MODE'"; exit 1 ;; esac

[ -d "$STAGING" ] || { echo "No staging — skip restore"; exit 0; }

if [ "$MODE" = pulled ]; then
  if [ -d "$DIST/ssg" ]; then
    echo "::warning::$STAGING is left over from a deploy that died mid-flight, but dist/ssg is live and newer — removing the stale copy, not restoring it"
    rm -rf "$STAGING"
    exit 0
  fi
  echo "dist/ssg missing and $STAGING holds a copy from a deploy that died mid-flight — restoring it"
fi

if [ -d "$STAGING/ssg" ]; then
  rm -rf "$DIST/ssg"
  cp -a "$STAGING/ssg" "$DIST/ssg"
  echo "Restored SSG dir ($(find "$DIST/ssg" -name index.html | wc -l | tr -d ' ') files)"
  # Only now is dropping the copy safe: the pages are back where nginx serves them.
  rm -rf "$STAGING/ssg"
fi

RESTORED=0
if [ -d "$STAGING/assets" ]; then
  mkdir -p "$DIST/assets"
  while IFS= read -r f; do
    base=$(basename "$f")
    if [ ! -e "$DIST/assets/$base" ]; then
      cp "$f" "$DIST/assets/$base"
      RESTORED=$((RESTORED + 1))
    fi
  done < <(find "$STAGING/assets" -type f)
fi
rm -rf "$STAGING"
echo "Restored $RESTORED legacy assets (the rest were superseded by vite)"
