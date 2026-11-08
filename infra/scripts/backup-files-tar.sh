#!/usr/bin/env bash
# backup-files-tar.sh <data-dir> <out.tar.gz> — the nightly local archive of the book files (backup.yml).
# <data-dir>/storage always; <data-dir>/library (the V2 volume, #1110) when it exists, else a notice.
#
#   exit 0  archived. GNU tar's exit 1 ("file changed as we read it": readers upload while we
#           archive) is accepted; the archive is complete for everything else.
#   exit >1 anything else, e.g. an existing file that cannot be read; <out> is not written.
#
# GNU tar (the server). Self-check: infra/scripts/backup-files-tar.test.sh.
set -euo pipefail

data=${1:?usage: backup-files-tar.sh <data-dir> <out.tar.gz>}
out=${2:?usage: backup-files-tar.sh <data-dir> <out.tar.gz>}

dirs=(storage)
if [ -d "$data/library" ]; then
  dirs+=(library)
else
  echo "::notice::$data/library does not exist (no V2 library yet): archiving storage only"
fi

rc=0
tar czf "$out.partial" -C "$data" "${dirs[@]}" || rc=$?
if [ "$rc" -gt 1 ]; then
  rm -f "$out.partial"
  echo "::error::tar exited $rc: $out not written"
  exit "$rc"
fi
mv "$out.partial" "$out"
echo "Files backup: $out (${dirs[*]})"
