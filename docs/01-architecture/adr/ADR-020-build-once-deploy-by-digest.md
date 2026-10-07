# ADR-020 — Build once on GitHub, deploy many by digest

**Status:** Accepted · **Date:** 2026-10-06 · **PRs:** #742 (build once), #746 (digest, pins, scans) ·
**Pipeline:** [`delivery.md`](../delivery.md)

## Context

Until #742 the self-hosted runner built every image on the production box on every deploy:
8–9 min of prod CPU, and a deploy that depended on npm, NuGet, MCR, Docker Hub and Chrome downloads
from the server. #742 moved the build to a GitHub-hosted runner, scanned the images for secrets and
pushed them to GHCR as `textstack-<svc>:<sha>`; the server pulled that tag.

The 2026-10-06 delivery review found two gaps in that design. A tag is mutable: anything with
`packages: write` could re-push `:<sha>` between build and pull, and the server would run it unscanned.
And the bases — the prod DB, the backup tool that sees the R2 keys, the scanner itself — were pulled by
mutable tags too. It also measured where the 15 minutes of `images` go: 12 of them scale with image
size (disk cleanup, scan, push), not with build work.

## Decision

1. **Build once, on GitHub.** `images.yml` builds every compose image for the exact commit, scans it
   (`scripts/scan-image-secrets.sh`, canary `.env` from `.env.example` + every compose `${VAR}`), and
   only then pushes.
2. **Deploy by digest.** `images` outputs `<svc>@sha256:<digest>` from `docker push` itself — the
   bytes it scanned. `deploy` pulls `name@digest` and tags it `:<sha>` locally for compose and humans.
   No digest, or a failed pull → the server builds, as before. A failed `images` never blocks a deploy;
   a failed `ci` or pre-deploy backup does. The backup is a step in `deploy` after the SSG wait and
   before the web build — before anything live changes, so a failed dump ships nothing, and minutes
   before the migrator. Not a parallel job: a dump taken at the start of the run can be an hour older
   than the migration it is meant to undo (CI, images, the SSG wait). Correctness of the rollback
   point beats ~2.5 min.
3. **Everything third-party is pinned to content:** actions by commit SHA (`# vX.Y` comment), pulled
   images by `tag@sha256`. Dependabot (`github-actions`, `docker`, `docker-compose`) moves the pins, so
   a pin is not a freeze.
4. **Every artifact users download is scanned:** images (gate before push), `apps/web/dist` (gate
   before push on GitHub, and again before the swap on the server — since 2026-10-07; after the
   server build only on the fallback), the OTA bundle (gate before `eas update`).

## Alternatives

| option | verdict | why |
|---|---|---|
| Build on the server again | Rejected | ~14 min (~11 even slim) vs ~8–9; prod CPU during deploys; and with nothing published the scan has no reason to exist. |
| buildx registry cache | Rejected | The build is already ~2 min warm with the gha cache. The cost is image size, fixed by slimming. |
| Per-image rebuild + re-tag unchanged images from the previous SHA | Deferred | Saves 0 min while `images` runs parallel to a ~6 min `ci`. "Previous SHA" can ship stale code (failed or cancelled runs, rollbacks, shared inputs, baked `GIT_SHA`). If ever needed: content-hash tags over each image's inputs, `SENTRY_RELEASE` moved to runtime, and a guard test on Dockerfile `COPY` sources. |
| cosign signatures / build provenance | Skipped | The threat here is a tag swap; pulling by digest closes it with no keys to manage. One owner, one server. |
| Pre-deploy dump in a parallel job | Rejected | Saves ~2.5 min, but moves the rollback point up to an hour before the migration; writes in that window are lost on restore. |
| SBOM | Skipped | `--sbom=true` is free, but nobody would read it. Revisit if a customer asks. |
| Private GHCR packages | Skipped | Costs money at today's sizes; the repo is public anyway. Images carry no secrets by construction and by scan. |

## Consequences

- The server needs only `docker pull` from GHCR for a normal deploy; build tools stay as the fallback.
- A digest bump on a base is a Dependabot PR that CI and the scan gate like any change.
- Pins inside scripts and `run:` lines (scanner, restic, Makefile alpine) are invisible to Dependabot
  and are bumped by hand.
- Published versions pile up (six per merge); `ghcr-retention.yml` prunes them weekly but never the
  deployed SHA or the last 5 deploys, so a rollback to a recent deploy still pulls by digest.
- The web frontend follows the same path (2026-10-07, review P2-2): `images.yml` job `web` builds
  `apps/web/dist` on GitHub with canary env, scans it, pushes a `FROM scratch` image
  `textstack-web:<sha>`; the deploy pulls it by digest, copies `/dist` out, scans it with the real
  values and swaps it in file by file (`scripts/swap-web-dist.sh`; `dist` is bind-mounted by
  ssg-worker, so never renamed). A scan hit stops the deploy before anything is live, and npm no
  longer runs on the production host — except on the fallback server build, kept as for images.
- First deploy after the pins: `db`, `ollama` (and `aspire-dashboard` if its profile is up) are
  recreated because their image reference changed — a few seconds of DB restart inside the deploy,
  after the pre-deploy dump.
