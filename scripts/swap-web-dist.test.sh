#!/usr/bin/env bash
# Self-check for swap-web-dist.sh on a fake dist. Run: bash scripts/swap-web-dist.test.sh
# GNU or BSD userland. CI: ci.yml `frontend`, step "Web swap self-check".
set -euo pipefail
SWAP="$(cd "$(dirname "$0")" && pwd)/swap-web-dist.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
has() { [ -e "$T/dist/$1" ] || fail "missing $1"; }
gone() { [ ! -e "$T/dist/$1" ] || fail "should be gone: $1"; }

# Live tree: release 1 + an SSG tree whose pages use a release-0 bundle.
mkdir -p "$T/dist/assets" "$T/dist/ssg/en/books/x" "$T/dist/ssg-new/en" "$T/dist/.well-known"
echo '<script src="/assets/r1-main.js"></script>' > "$T/dist/index.html"
echo 'import("./assets/r1-lazy.js")' > "$T/dist/assets/r1-main.js"
echo 'lazy' > "$T/dist/assets/r1-lazy.js"
echo '<link href="/assets/r0-style.css"><script src="/assets/r0-main.js"></script>' > "$T/dist/ssg/en/books/x/index.html"
echo 'url(/assets/r0-font.woff2)' > "$T/dist/assets/r0-style.css"
echo 'import("./assets/r0-reader.js")' > "$T/dist/assets/r0-main.js"
echo font > "$T/dist/assets/r0-font.woff2"
echo reader > "$T/dist/assets/r0-reader.js"
echo '<script src="/assets/r0-inflight.js"></script>' > "$T/dist/ssg-new/en/index.html"
echo inflight > "$T/dist/assets/r0-inflight.js"
echo orphan > "$T/dist/assets/orphan.js"
echo old-ico > "$T/dist/favicon.ico"
echo dropped > "$T/dist/dropped.txt"
echo key > "$T/dist/.well-known/k"
echo not-ours > "$T/dist/not-in-manifest.txt"
printf '%s\n' .well-known/k dropped.txt favicon.ico index.html > "$T/manifest"
ssg_sum=$(cd "$T/dist" && find ssg ssg-new -type f -exec cat {} + | cksum)

# Release 2.
mkdir -p "$T/r2/assets" "$T/r2/.well-known"
echo '<script src="/assets/r2-main.js"></script>' > "$T/r2/index.html"
echo 'import("./assets/r2-lazy.js")' > "$T/r2/assets/r2-main.js"
echo lazy2 > "$T/r2/assets/r2-lazy.js"
echo new-ico > "$T/r2/favicon.ico"
echo key > "$T/r2/.well-known/k"

bash "$SWAP" "$T/r2" "$T/dist" "$T/manifest"
grep -q r2-main "$T/dist/index.html" || fail "index.html not swapped"
[ "$(cat "$T/dist/favicon.ico")" = new-ico ] || fail "favicon not replaced"
for a in r2-main.js r2-lazy.js r1-main.js r1-lazy.js r0-style.css r0-main.js r0-font.woff2 r0-reader.js r0-inflight.js; do has "assets/$a"; done
gone assets/orphan.js; gone dropped.txt; has .well-known/k; has not-in-manifest.txt
[ "$ssg_sum" = "$(cd "$T/dist" && find ssg ssg-new -type f -exec cat {} + | cksum)" ] || fail "SSG trees changed"
grep -qx favicon.ico "$T/manifest" && ! grep -qx dropped.txt "$T/manifest" || fail "manifest not updated"
[ -z "$(find "$T/dist" -name '*.swap-tmp')" ] || fail "temp files left"

# Same release again: release 1's grace is over.
bash "$SWAP" "$T/r2" "$T/dist" "$T/manifest"
gone assets/r1-main.js; gone assets/r1-lazy.js; has assets/r0-reader.js; has assets/r2-lazy.js

# Refusals leave the live tree alone.
before=$(cd "$T/dist" && find . -type f | sort | cksum)
mkdir -p "$T/bad/assets" "$T/bad/ssg"; echo x > "$T/bad/index.html"
bash "$SWAP" "$T/bad" "$T/dist" "$T/manifest" 2>/dev/null && fail "accepted a release carrying ssg/"
rm -rf "$T/bad/ssg" "$T/bad/index.html"
bash "$SWAP" "$T/bad" "$T/dist" "$T/manifest" 2>/dev/null && fail "accepted a release without index.html"
[ "$before" = "$(cd "$T/dist" && find . -type f | sort | cksum)" ] || fail "a refusal changed dist"

# An SSG page naming an asset that is gone, sorting last in the keep set: the graph walk
# must skip it, not end on a failed test under pipefail (review of #764).
mkdir -p "$T/m/dist/assets" "$T/m/dist/ssg/en" "$T/m/new/assets"
echo '<script src="/assets/a.js"></script>' > "$T/m/dist/index.html"
echo a > "$T/m/dist/assets/a.js"
echo '<script src="/assets/zz-missing.js"></script>' > "$T/m/dist/ssg/en/index.html"
echo '<script src="/assets/b.js"></script>' > "$T/m/new/index.html"
echo b > "$T/m/new/assets/b.js"
bash "$SWAP" "$T/m/new" "$T/m/dist" "$T/m/manifest" > /dev/null || fail "swap failed on an SSG page naming a missing asset"
grep -q b.js "$T/m/dist/index.html" || fail "missing-asset case: index.html not swapped"
[ -e "$T/m/dist/assets/a.js" ] || fail "missing-asset case: previous release's asset pruned"

# A reader never sees an index.html naming an asset that is not there, or a torn file,
# while releases swap back and forth.
mkdir -p "$T/r3/assets"
echo '<script src="/assets/r3-main.js"></script>' > "$T/r3/index.html"
echo r3 > "$T/r3/assets/r3-main.js"
( for _ in $(seq 15); do bash "$SWAP" "$T/r3" "$T/dist" "$T/manifest" >/dev/null; bash "$SWAP" "$T/r2" "$T/dist" "$T/manifest" >/dev/null; done; touch "$T/done" ) &
reads=0
while [ ! -e "$T/done" ]; do
  html=$(cat "$T/dist/index.html")
  a=$(printf '%s' "$html" | grep -oE 'assets/[a-z0-9-]+\.js') || fail "torn index.html: '$html'"
  [ -f "$T/dist/$a" ] || fail "index.html names $a, which is not there"
  reads=$((reads + 1))
done
wait
echo "ok — swap-web-dist ($reads concurrent reads)"
