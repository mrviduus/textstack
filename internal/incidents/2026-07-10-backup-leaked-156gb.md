# The nightly backup leaked 156 GB, filled the disk, and broke itself

**Date:** 2026-07-10
**Status:** Resolved

## Impact

57 orphaned pgdata volumes, one per run for 34 days, filled the Docker disk to 100% and broke the backup that created them.

## Root cause

`docker rm -f` without `-v` left the volume behind on every verify run. `df -h` on the wrong mount showed 61% and hid it.

## Fix

`docker rm -fv` plus a reaper for already-orphaned volumes. PR #425.

## Lesson

The backup broke itself, one run at a time, for 34 days — and `df -h` on the wrong mount reported
61%. Verify the thing you actually measure is the thing that fills up.

## Detection

**34 days**, one leaked volume per nightly run, until the Docker disk hit 100% and the backup that
created the leak failed. Routine `df -h` checks reported 61% the whole time because they measured
the wrong mount — the Docker data root lives on `/mnt/data`, not `/`.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-07-10. This is the long-form record — the source
material for articles and the detail a future reader needs.*

The actual root cause behind the flapping backup (the self-diagnostics below were added to *find* this). Prod's Docker data-root lives on a **separate `/mnt/data` partition** (not `/`, which `df -h /` alone hides) and it had hit **100% / 0 bytes free** — 183 GB used, **156 GB of it 57 dangling anonymous `pgdata` volumes**. `backup-verify.sh` spins a throwaway `pgvector` postgres each run; postgres declares an anonymous `VOLUME /var/lib/postgresql/data`. On a killed/timed-out run `--rm` never fired and the cleanup did `docker rm -f` **without `-v`** → one full pgdata volume leaked per run. 34 days × daily ≈ 156 GB → the docker root filled → a fresh throwaway postgres could no longer `initdb` → **the backup broke the very verify step that had been creating the volumes** — a self-reinforcing failure. Real prod data was never at risk (postgres + storage bind-mount to `/`, which was at 61%); only the anonymous verify volumes bloated `/mnt/data`. Fix: `docker rm -f` → **`docker rm -fv`** (both the trap cleanup and the leaked-container reap) so the anonymous volume dies with its container, plus a `docker volume prune -f` catch-all for SIGKILL'd runs the trap can't cover (named volumes are untouched by prune). Remediated live: `docker volume prune` reclaimed **163 GB**, `/mnt/data` 100% → 17%. Diagnosed the hard way — the box was also unreachable for a stretch (a clean manual reboot, not a crash; a full disk still lets you SSH in, so an SSH *connect*-timeout is a host-offline signal, not disk).
