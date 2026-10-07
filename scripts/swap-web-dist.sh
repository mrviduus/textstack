#!/usr/bin/env bash
# Puts a pre-built web bundle live without a moment where nginx serves half of it.
#
#   scripts/swap-web-dist.sh NEW DIST MANIFEST
#
#   NEW       vite's output for this release (index.html + assets/ + public/), already scanned
#   DIST      the served tree, apps/web/dist — also home to ssg-worker's dist/ssg*
#   MANIFEST  file list of the previous release (outside DIST: nginx serves DIST)
#
# Not `mv NEW DIST`. ssg-worker bind-mounts apps/web/dist, and a bind mount holds the
# directory, not the path: after a rename it would keep writing SSG pages into the
# old tree. So the release goes in file by file, and dist/ssg* is never touched:
#   1. assets/ — content-hashed names, unreachable until an index.html names them.
#      A name already present is the same bytes and is skipped.
#   2. every other file, index.html last. Each is copied next to its target and
#      renamed over it (atomic on one filesystem), so a reader gets old or new, never half.
#   3. files the previous release shipped (MANIFEST) that this one does not: removed.
#   4. assets referenced by neither this release, the previous index.html (one
#      release of grace for open tabs), nor any dist/ssg* page: removed. The keep
#      set walks HTML → JS → lazy imports → CSS → url() to a fixed point, as
#      deploy.yml's SSG snapshot does: a naive HTML-only scan once deleted every
#      React.lazy chunk on production (5e4070a).
set -euo pipefail

NEW=${1:?NEW}; DIST=${2:?DIST}; MANIFEST=${3:?MANIFEST}
[ -f "$NEW/index.html" ] && [ -d "$NEW/assets" ] || { echo "::error::$NEW is not a vite build (no index.html or assets/)"; exit 1; }
# Loops here end on `if`, never on `[ … ] && …`: a false test as a loop's last command is
# its exit status, and under pipefail a loop feeding a pipe then kills the script silently.
for d in "$NEW"/ssg*; do
  if [ -e "$d" ]; then echo "::error::$NEW carries ${d##*/} — SSG trees are ssg-worker's, never a release's"; exit 1; fi
done
mkdir -p "$DIST/assets"
# nginx reads as another user.
chmod -R a+rX "$NEW"

PAT='assets/[A-Za-z0-9_.-]+\.(js|css|mjs|cjs|woff2?|ttf|otf|eot|png|jpg|jpeg|svg|webp|gif|ico|map)'
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
# NUL-separated files on stdin → referenced asset basenames. ssg-worker may swap a
# tree mid-read; a vanished file is skipped, not an error.
refs() { xargs -0 -r grep -ohE "$PAT" 2>/dev/null | awk -F/ '{print $NF}' || true; }

# --- 4a. Keep set, from what is live BEFORE anything changes.
{ find "$DIST" -maxdepth 1 -name index.html -print0
  find "$DIST" -mindepth 2 -path "$DIST/ssg*" -name '*.html' -print0 2>/dev/null || true
} > "$work/seeds"
refs < "$work/seeds" | sort -u > "$work/keep"
prev=-1
while [ "$(wc -l < "$work/keep")" != "$prev" ]; do
  prev=$(wc -l < "$work/keep")
  while IFS= read -r f; do
    # An SSG page may name an asset that is already gone: skip it.
    case $f in *.js|*.css|*.mjs|*.cjs) if [ -f "$DIST/assets/$f" ]; then printf '%s\0' "$DIST/assets/$f"; fi ;; esac
  done < "$work/keep" | refs > "$work/more"
  sort -u "$work/keep" "$work/more" -o "$work/keep"
done
# HTML existed but referenced nothing: the graph walk broke (grep missing, pattern
# drift). Pruning on that would delete what live pages need — skip it, loudly.
prune=true
if [ -s "$work/seeds" ] && [ ! -s "$work/keep" ]; then
  echo "::warning::live HTML references no assets — graph walk broken; skipping the asset prune"
  prune=false
fi

# --- 1. Assets.
added=0
find "$DIST/assets" -maxdepth 1 -name '.*.swap-tmp' -delete # a run that died mid-copy
for f in "$NEW"/assets/*; do
  b=${f##*/}
  if [ -e "$DIST/assets/$b" ]; then continue; fi
  cp -p "$f" "$DIST/assets/.$b.swap-tmp"
  mv -f "$DIST/assets/.$b.swap-tmp" "$DIST/assets/$b"
  added=$((added + 1))
done

# --- 2. Everything else, index.html last.
(cd "$NEW" && find . -type f ! -path './assets/*' | sed 's#^\./##' | sort) > "$work/files"
put() {
  mkdir -p "$(dirname "$DIST/$1")"
  cp -p "$NEW/$1" "$DIST/$1.swap-tmp"
  mv -f "$DIST/$1.swap-tmp" "$DIST/$1"
}
{ grep -vx 'index.html' "$work/files" || true; } | while IFS= read -r f; do put "$f"; done
put index.html

# --- 3. Files the previous release shipped and this one does not.
removed=0
if [ -f "$MANIFEST" ]; then
  while IFS= read -r f; do
    case $f in ''|/*|*..*|assets/*|ssg*) continue ;; esac # never outside the release's own files
    if grep -qxF -- "$f" "$work/files"; then continue; fi
    rm -f -- "$DIST/$f"
    removed=$((removed + 1))
  done < "$MANIFEST"
fi
cp "$work/files" "$MANIFEST.tmp" && mv -f "$MANIFEST.tmp" "$MANIFEST"

# --- 4b. Prune assets nothing references.
pruned=0
if [ "$prune" = true ]; then
  ls "$NEW/assets" >> "$work/keep"
  sort -u "$work/keep" -o "$work/keep"
  for f in "$DIST"/assets/*; do
    [ -f "$f" ] || continue
    if ! grep -qxF -- "${f##*/}" "$work/keep"; then rm -f -- "$f"; pruned=$((pruned + 1)); fi
  done
fi

echo "web release live: $(wc -l < "$work/files" | tr -d ' ') files, $added new assets, $removed stale files removed, $pruned unreferenced assets pruned ($(wc -l < "$work/keep" | tr -d ' ') kept)"
