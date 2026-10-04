# SSG Prerender Architecture

## Overview

Puppeteer renders SEO pages to static HTML. **Only crawlers get that HTML**; people always get the
SPA. Checked against code 2026-10-04.

## How it works

```
admin "Rebuild" / publish / periodic timer
   → row in ssg_rebuild_jobs (mode Full | Incremental | Specific)
   → ssg-worker container (apps/web/scripts/ssg-worker.mjs) polls every 5 s
   → runs scripts/prerender.mjs: GET /ssg/routes → Puppeteer renders → dist/ssg-new
   → atomic swap dist/ssg-new → dist/ssg, then IndexNow ping (if enabled)
   → host nginx serves dist/ssg to bots
```

Who enqueues jobs: admin SSG page (`/admin/ssg/*` API), `PublishEditionAsync() → EnqueueSsgSafe()`
(auto-publish), `SsgPeriodicRebuildWorker` in the API (interval set in admin), deploy workflow.
`make rebuild-ssg` bypasses the queue: it runs `prerender.mjs` on the host and does the same swap.

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
make rebuild-ssg                      # host: run prerender.mjs directly + atomic swap (no job row)
pnpm -C apps/web build:ssg            # local: tsc + vite build + prerender.mjs (needs API running)
cd apps/web && API_URL=http://localhost:8080 API_HOST=localhost node scripts/prerender.mjs
```

## Environment

| Variable | Where | Default |
|----------|-------|---------|
| `API_URL` | ssg-worker / prerender | `http://api:8080` (compose) |
| `API_HOST` | Host header | `localhost` in compose; script default `general.localhost`. Note: undici drops a custom `Host`, so the API's resolver falls back to the single site anyway |
| `CONCURRENCY` | prerender | `4` (jobs can override) |
| `INDEXNOW_KEY`, `INDEXNOW_ENABLED` | ssg-worker | off unless `INDEXNOW_ENABLED=true` and a key is set |

## Output

```
apps/web/dist/ssg/en/{index.html, books/<slug>/index.html, authors/<slug>/…, genres/<slug>/…}
```
`dist/` is bind-mounted into `ssg-worker` (`./apps/web/dist:/repo/apps/web/dist`).

## Key files

| File | Purpose |
|------|---------|
| `apps/web/scripts/ssg-worker.mjs` | Long-running poller, atomic swap, IndexNow |
| `apps/web/scripts/prerender.mjs` | Puppeteer renderer |
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
