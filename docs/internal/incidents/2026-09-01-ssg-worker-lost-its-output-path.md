# SSG rebuilds failed silently after the workspace move

**Date:** 2026-09-01 · **Detected:** ~30 minutes · **Impact:** no page could be re-prerendered;
the site kept serving the previous SSG throughout · **Cause:** an absolute path in a script,
invalidated by an image layout change

## What happened

Moving the repository to a pnpm workspace ([#514](https://github.com/mrviduus/textstack/pull/514))
required both production images to build from the repository root — `catalog:` cannot be resolved
without `pnpm-workspace.yaml` in scope. The `ssg-worker` container's working directory moved with
it, from `/app` to `/repo/apps/web`.

`apps/web/scripts/ssg-worker.mjs` had its output directories written out absolutely:

```js
const SSG_DIR = '/app/dist/ssg';
const SSG_NEW_DIR = '/app/dist/ssg-new';
const SSG_OLD_DIR = '/app/dist/ssg-old';
```

Every rebuild after the deploy failed at the first write:

```
[prerender] Found 1992 routes to prerender
[prerender stderr] Prerender failed: Error: EACCES: permission denied, mkdir '/app/dist/ssg-new'
    at main (file:///repo/apps/web/scripts/prerender.mjs:478:3)
Job 17fcbc80-6385-4e25-a561-d3c0f8759a48 failed with exit code 1
```

## Why nothing looked wrong

The site was fine. `https://textstack.app/en` returned 200 with `x-seo-render: ssg` the entire time,
because the previous SSG output was still on disk and nginx was still serving it. The container was
`Up (healthy)` — its healthcheck is `pgrep -f ssg-worker.mjs`, which asks whether the process exists,
not whether it can do its job.

This is the shape of the
[five-week SSG outage](2026-08-11-ssg-dead-five-weeks.md): the failure is invisible from outside
because stale output looks exactly like fresh output. It was caught in thirty minutes this time
only because the deploy was being watched step by step — the `Wait for SSG rebuild to complete`
step sat there instead of finishing, which is the guard added after
[the deploy that wiped a running rebuild](2026-08-31-deploy-wiped-a-running-ssg-rebuild.md) doing
its job.

## The fix

Derive the paths from the script's own location, so they survive any layout:

```js
const DIST_DIR = join(__dirname, '..', 'dist');
const SSG_DIR = join(DIST_DIR, 'ssg');
```

`prerender.mjs`, in the same directory, already did exactly this — `join(__dirname, '..', 'dist')` —
and came through the move untouched. The two scripts disagreed about how to find the same folder,
and only one of them was right.

## What this says about the checks that passed

CI was green on #514, including the `docker` job, which builds both images. Building an image proves
it builds. It does not run the container against its volumes, and the failure needed all three: the
new WORKDIR, the compose volume at its new mount point, and a script writing to the old absolute
path.

The e2e suite did not cover it either, because e2e exercises the site — and the site was serving the
old output correctly.

## Follow-ups

- **The healthcheck answers the wrong question.** `pgrep -f ssg-worker.mjs` reports a process, not a
  working one. A worker that has failed every job for an hour is `healthy`. Something closer to
  "the last job succeeded, or at least one has succeeded recently" would have said so.
- **Still no SSG freshness alarm.** `docs/STATUS.md` has carried this item since the five-week
  outage: nothing alerts on "the newest generated page is older than N hours". It would have caught
  this one too, and it is the single check that would have caught all three.
- **Absolute paths in scripts that run in containers.** This was the only one left in
  `apps/web/scripts/`; worth a grep before the next layout change rather than after.
