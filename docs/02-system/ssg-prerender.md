# SSG Prerender Architecture

## Overview

Puppeteer renders SEO pages to static HTML. **Only crawlers get that HTML**; people always get the
SPA. Checked against code 2026-10-07.

## How it works

```
admin "Rebuild" / publish / periodic timer
   → row in ssg_rebuild_jobs (mode Full | Incremental | Specific)
   → ssg-worker container (apps/web/scripts/ssg-worker.mjs) polls every 5 s
   → empties dist/ssg-new, runs scripts/prerender.mjs: GET /ssg/routes → Puppeteer renders → dist/ssg-new
   → survival check, failed routes keep their live page, then
   → atomic swap dist/ssg-new → dist/ssg, then IndexNow ping (if enabled)
   → host nginx serves dist/ssg to bots
```

**What counts as rendered** (`scripts/ssgRender.mjs`): the page shows content, not a skeleton, and
none of its `/api/` calls ended in a 5xx, a 429 or no response. Only the last outcome per URL counts,
because the app retries. Outcomes are per request: a 404 whose unread body the browser then aborts
is still a 404. A page with noindex (a 404, a draft) is skipped on purpose and leaves the tree; a
route that fails and then renders noindex on retry is skipped the same way.

**When a build is promoted** (`scripts/ssgJob.mjs`, run by the worker):
- prerender exited 0 without being stopped. The worker stops it, and the job ends `Failed`, when
  **no route rendered for 5 min** (`SSG_JOB_STALL_MS`). Rendered means rendered or skipped as
  noindex, or any attempt in the retry pass; first-pass failures do not count, because a hung API
  fails every route at the 30 s timeout. It is also stopped at a **cap** of max(60 min, 2 s per
  route) (`SSG_JOB_DEADLINE_MS`). Progress comes from the per-route `result` lines prerender already
  prints to stdout.
- `ssg-new` holds at least `max(1, floor(0.9 × routes))` non-empty pages. Failed renders write
  nothing, so this refuses a mostly failed build as well as one a deploy wiped.
- each route that failed (not noindex) gets its live page copied into `ssg-new`, so the swap keeps it.

A refused or `Failed` job leaves `dist/ssg` untouched and reports to Sentry (`service:ssg-worker`).

Who enqueues jobs: admin SSG page (`/admin/ssg/*` API), `PublishEditionAsync() → EnqueueSsgSafe()`
(auto-publish), `SsgPeriodicRebuildWorker` in the API (interval set in admin), the nightly
`backup.yml` and a manual deploy with `rebuild_ssg` (both `POST /internal/ssg/rebuild-all`), and
`make rebuild-ssg` on the server (`infra/scripts/rebuild-ssg.sh`: the same POST, then follows the job
and exits 0 only on `Completed`). Every rebuild is a job, so every one gets the checks above — and none
runs while ssg-worker is down: the script exits 1 if the worker has not started the job in 5 min, or
if its counts have not moved in 30 min. If a Full rebuild is already queued or running, it waits for
that one and then queues its own, so the result includes changes made just before the call.

## nginx split (`infra/nginx/textstack.conf`)

```
map $http_user_agent $is_bot      → 1 for Google, Bing, Yandex, social bots …
map $is_bot $ssg_file             → bot: /ssg$uri/index.html   human: /nonexistent
location ~ ^/en/books/[^/]+/?$  { try_files $ssg_file @spa; }   # same for /en/, authors, genres, lists, about
```

So a browser check always shows the SPA. Test as a bot (see Verification). The `X-SEO-Render`
header is `ssg` for bots on these routes and `spa` otherwise.

## Routes prerendered

From `GET /ssg/routes` (`Api/Endpoints/SsgEndpoints.cs`): `/en/`, `/en/books`, `/en/authors`,
`/en/genres`, `/en/about`, plus every published book, author and genre detail page. Only `en`
exists; `/uk/*` is 301'd to `/en/*` by nginx.

Not prerendered: reader (`/en/books/:slug/:chapter`, noindex), library, search, vocabulary, stats.

## Commands

```bash
make rebuild-ssg                      # server: queue a Full job for ssg-worker, follow it to the end
pnpm -C apps/web build:ssg            # local only: tsc + vite build + prerender.mjs into dist/ssg, no checks
cd apps/web && API_URL=http://localhost:8080 API_HOST=localhost node scripts/prerender.mjs   # local only
```

## Environment

| Variable | Where | Default |
|----------|-------|---------|
| `API_URL` | ssg-worker / prerender | `http://api:8080` (compose) |
| `API_HOST` | Host header | `localhost` in compose; script default `general.localhost`. Note: undici drops a custom `Host`, so the API's resolver falls back to the single site anyway |
| `CONCURRENCY` | prerender | `4` (jobs can override) |
| `INDEXNOW_KEY`, `INDEXNOW_ENABLED` | ssg-worker | off unless `INDEXNOW_ENABLED=true` and a key is set |
| `SSG_JOB_STALL_MS` | ssg-worker | 5 min without a rendered route → stopped, `Failed` |
| `SSG_JOB_DEADLINE_MS` | ssg-worker | cap, max(60 min, 2 s per route) |
| `SSG_API_URL`, `SSG_POLL_SECS` | `make rebuild-ssg` | `http://localhost:8080`, `10` |
| `SSG_START_TIMEOUT_SECS`, `SSG_STALL_TIMEOUT_SECS` | `make rebuild-ssg` | `300` (not started), `1800` (no progress) → exit 1 |

## Output

```
apps/web/dist/ssg/en/{index.html, books/<slug>/index.html, authors/<slug>/…, genres/<slug>/…}
```
`dist/` is bind-mounted into `ssg-worker` (`./apps/web/dist:/repo/apps/web/dist`).

## Key files

| File | Purpose |
|------|---------|
| `apps/web/scripts/ssg-worker.mjs` | Long-running poller, atomic swap, IndexNow |
| `apps/web/scripts/prerender.mjs` | Puppeteer renderer (CLI) |
| `apps/web/scripts/ssgRender.mjs` | Static server + API proxy, `renderRoute` (what counts as rendered) |
| `apps/web/scripts/ssgJob.mjs` | Survival floor, carry-forward, job deadline, DB pool |
| `infra/scripts/rebuild-ssg.sh` | `make rebuild-ssg`: queue a Full job, follow it |
| `apps/web/Dockerfile.ssg-worker` | Image with Chromium |
| `backend/src/Api/Endpoints/SsgEndpoints.cs` | `/ssg/routes`, `/ssg/books`, `/ssg/authors`, `/ssg/genres` |
| `backend/src/Api/Endpoints/AdminSsgRebuildEndpoints.cs` | Admin queue + settings |
| `backend/src/Api/Services/SsgPeriodicRebuildWorker.cs` | Periodic rebuild |
| `infra/nginx/textstack.conf` | Bot/human split |

## When to rebuild

After publishing books, or changing book/author/genre metadata or SEO-page frontend code. Not
needed for user data. Do not merge to `main` during a rebuild: deploy can wipe a running rebuild
(see `docs/incidents/2026-08-31-deploy-wiped-a-running-ssg-rebuild.md`).

## Verification

```bash
curl -sI -A "Googlebot" https://textstack.app/en/books/dracula/ | grep -i x-seo-render   # ssg
curl -sI https://textstack.app/en/search | grep -i x-seo-render                          # spa
curl -s  -A "Googlebot" https://textstack.app/en/books/dracula/ | grep '<title>'
```
