# A deploy waited on a prompt, and 1990 pages went missing

**Date:** 2026-09-02 · **Detected:** ~70 minutes · **Impact:** every prerendered page returned 404
to crawlers; readers were unaffected · **Cause:** an interactive prompt in a non-interactive deploy,
plus a snapshot step that moves its only copy

## What happened

The workspace migration changed the production build step to `corepack pnpm install`. Corepack asks

```
Do you want to continue? [Y/n]
```

the first time it fetches a package manager it has not cached. On a self-hosted runner nobody
answers, so the step waited. It waited for **76 minutes**, until it was cancelled by hand.

That would have been a slow deploy and nothing more, except for where it stopped. The step before it
is `Snapshot SSG dir + referenced assets before vite wipes dist`, which does:

```sh
mv "$DIST/ssg" "$STAGING/ssg"
```

A move, not a copy. So for the length of the build there is exactly one copy of the site's entire
prerendered output, and it lives in `apps/web/.ssg-staging/` — a directory nginx does not serve.
The deploy died in that window, and 1990 pages stopped existing as far as Google was concerned:

```
$ curl -sI -A Googlebot https://textstack.app/en/books/dracula/
x-seo-render: spa
$ curl -s -A Googlebot https://textstack.app/en/books/dracula/ | head -1
<title>Not Found</title>          # 169 bytes
```

## The part that was nearly much worse

Three more deploys were queued behind the hung one. The snapshot step began:

```sh
rm -rf "$STAGING"
mkdir -p "$STAGING/assets"
if [ ! -d "$DIST/ssg" ]; then
  echo "No existing dist/ssg — first deploy, nothing to preserve"
  exit 0
fi
```

It cleared staging **before** checking whether there was anything to snapshot. The first queued
deploy to start would have deleted the only surviving copy, then reported "first deploy, nothing to
preserve" and carried on. The pages would have been regenerable — the deploy queues an SSG rebuild —
but the window would have widened from an hour to however long a full 1992-page prerender takes,
with nothing to serve in between.

## Why nothing said anything

The same reason as [yesterday](2026-09-01-ssg-worker-lost-its-output-path.md), and the reason before
that: **stale or missing SSG output is invisible from outside unless you ask as a crawler.** Humans
got the SPA and it rendered fine. The API was healthy. Every container was `Up (healthy)`. The
health check runs every five minutes and checks `/health`, the book listing, and search — none of
which touch the prerendered files.

It was found by manually curling with a Googlebot user agent while building an unrelated feature.

## The fixes

**`COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'`** on the build step. Corepack fetches without asking.

**The snapshot copies instead of moving**, and removes the original only after the copy exists. The
extra disk is worth not having a window where one directory is the whole site.

**The staging guard is inverted**: check first, clear second. A deploy that finds `dist/ssg` missing
*and* a copy in staging now says so and leaves it alone, so the restore step can put it back.
Verified by simulating a deploy dying between the two steps and running the snapshot again — under
the old code the copy is deleted; under the new one it survives.

## Follow-ups

- **Still no SSG freshness alarm.** Three incidents in three weeks would each have been caught by one
  check: "the newest generated page is older than N hours". It is the next item in the plan and it
  should have been the first.
- **The health check does not ask a crawler's question.** It could `curl -A Googlebot` one known SSG
  URL and assert `x-seo-render: ssg` plus a body larger than a 404. That is two lines and it is the
  difference between finding this in five minutes and finding it in seventy.
- **`X-SEO-Render` still lies.** It is set from `map $is_bot`, so it reports "you look like a bot",
  not "SSG was served" — during this incident it said `spa` for a crawler, which was accidentally
  correct but for the wrong reason. Already on the known-broken list in `docs/STATUS.md`.
