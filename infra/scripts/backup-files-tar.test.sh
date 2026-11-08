#!/usr/bin/env bash
# Self-check for backup-files-tar.sh on a temp data dir. Run: bash infra/scripts/backup-files-tar.test.sh
# Needs GNU tar (its exit codes are the contract) and a non-root user (root reads a chmod 000 file).
# CI: ci.yml `frontend`, step "Web swap self-check".
set -euo pipefail
TAR="$(cd "$(dirname "$0")" && pwd)/backup-files-tar.sh"
tar --version 2>/dev/null | grep -q 'GNU tar' || { echo "SKIP: not GNU tar"; exit 0; }
T=$(mktemp -d); trap 'chmod -R u+rwX "$T"; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# 1. No data/library: succeeds, says so, archives storage alone.
mkdir -p "$T/data/storage/ab"; echo cover > "$T/data/storage/ab/cover.jpg"
log=$(bash "$TAR" "$T/data" "$T/a.tar.gz") || fail "missing library failed the backup"
grep -q '::notice::.*library does not exist' <<<"$log" || fail "no notice for the missing library: $log"
[ "$(tar tzf "$T/a.tar.gz" | grep -c '^library')" -eq 0 ] || fail "archive has a library entry"
tar tzf "$T/a.tar.gz" | grep -q '^storage/ab/cover.jpg$' || fail "storage not archived"

# 2. data/library present: both archived, no notice.
mkdir -p "$T/data/library/library/ab"; echo book > "$T/data/library/library/ab/b.epub"
log=$(bash "$TAR" "$T/data" "$T/b.tar.gz") || fail "backup with library failed"
grep -q '::notice::' <<<"$log" && fail "notice with the library present"
tar tzf "$T/b.tar.gz" | grep -q '^library/library/ab/b.epub$' || fail "library not archived"

# 3. An existing file that cannot be read: the backup fails and writes nothing.
if [ "$(id -u)" -eq 0 ]; then
  echo "SKIP case 3: root reads unreadable files"
else
  chmod 000 "$T/data/library/library/ab/b.epub"
  if bash "$TAR" "$T/data" "$T/c.tar.gz" >/dev/null 2>&1; then fail "unreadable file did not fail the backup"; fi
  [ ! -e "$T/c.tar.gz" ] && [ ! -e "$T/c.tar.gz.partial" ] || fail "a failed backup left an archive"
fi

# 4. Interrupted mid-archive (tar killed): the trap removes the partial file.
mkdir -p "$T/fakebin"; printf '#!/bin/sh\ntouch "$2"; kill -TERM $PPID\n' > "$T/fakebin/tar"; chmod +x "$T/fakebin/tar"
PATH="$T/fakebin:$PATH" bash "$TAR" "$T/data" "$T/d.tar.gz" >/dev/null 2>&1 || true
[ ! -e "$T/d.tar.gz.partial" ] || fail "an interrupted backup left $T/d.tar.gz.partial"

echo "backup-files-tar: ok"
