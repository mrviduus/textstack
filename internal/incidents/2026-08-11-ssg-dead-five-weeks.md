# SSG dead for five weeks — a forbidden HTTP header

**Date:** 2026-08-11
**Status:** Resolved

## Impact

~389 published books returned a hard 404 to crawlers while advertised in the sitemap; no page regenerated since 3 July.

## Root cause

`ssg-worker` set a `Host` header that the fetch spec forbids, so undici dropped it; the request arrived as `Host: api`, which is not a registered site domain, and site resolution answered 404.

## Fix

`SiteResolver` falls back to the single site (`ICurrentSite.Id`) when no domain matches. PR #450.

## Lesson

A mitigation that cannot work looks exactly like one that does. The worker was `healthy`, the job
reported completion, and the only evidence was a log line nobody watched. Fixing the *resolver*
rather than the worker closes the class: every `fetch` caller is unable to set `Host`.

## Detection

**Five weeks.** Not by an alarm — by a Bing Webmaster Tools screenshot the owner happened to open.
The rebuild jobs were failing the whole time into a log nobody watched, and the ssg-worker container
reported `healthy` throughout. No alarm existed then and none exists now: **the open follow-up is to
alarm on "newest generated page is older than N hours"**, which would have caught this on day one.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-08-11. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Started from a Bing Webmaster Tools screenshot with four warnings and ended somewhere else entirely. The warnings ("limited crawl capacity", "too many pages with insufficient content") were symptoms; Google Search Console independently agreed (`Crawled – currently not indexed: 780`, `Discovered – not indexed: 311`, `Soft 404: 67` with a validation started 15 May that never passed). Chasing the soft-404 list led to real book and author pages — Pan Michael, The Wings of the Dove, Lew Wallace — not the junk URLs an initial guess predicted.

**Root cause.** `ssg-worker.mjs` calls `http://api:8080/ssg/routes` and deliberately sets a `Host` header so `SiteContextMiddleware` can resolve the site — the file even carries a comment explaining that without it "fetch would otherwise default Host to the URL host (`api`) → 404 → silent job". That mitigation cannot work: **`Host` is a forbidden header name in the fetch spec**, so undici drops it. Verified inside the running container — `fetch` with an explicit `Host: textstack.app` still returns 404. The request arrives as `Host: api`, which is not in `site_domains`, so resolution returned null and the middleware answered `404 Site not found`. Every rebuild job failed. The worker stayed `healthy`, and the only evidence was a log line nobody was watching.

The trigger was refactor R1b, which removed the legacy `?site=` override that had been papering over this.

**Blast radius, measured.** Newest generated page: **3 July**. The sitemap is built live from the database and advertises **1153** book URLs; the generator had produced **764** pages. So roughly **389 published books returned a hard 404 to crawlers** while being actively advertised in the sitemap — which is precisely Google's `Not found (404): 153` and Bing's 140-of-1.3K index.

**Fix.** `SiteResolver` now falls back to the single site (`ICurrentSite.Id`) when the host matches no registered domain, logging a warning naming the host. This is safe in exactly the way the removed `?site=` override was not: that override could name a *different* site, producing a `SiteContext` whose Id diverged from the process-wide `ICurrentSite.Id` that EF's global query filters key on — silently yielding zero rows. Resolving to `ICurrentSite.Id` itself makes divergence impossible, and which hosts can reach the middleware at all is already constrained by `AllowedHosts`. Fixing the resolver rather than the worker also closes the class: any future internal caller that cannot set `Host` (which is every `fetch` caller) now works.

Covered by integration tests rather than unit tests, deliberately: `SiteResolver` depends on the concrete `AppDbContext`, whose model only builds on Npgsql, and the failure was inherently about a real request's host — something a mock cannot express. `SsgRouteResolutionTests` asserts `/ssg/routes` returns 200 for `Host: api`, still works for a known host, and returns a non-empty route list (an empty list would rebuild nothing while reporting success — the same silent-failure shape).

**Two pieces of misleading infrastructure found on the way, worth knowing even though they are not the bug.** `X-SEO-Render` is set from `map $is_bot`, so it reports "you look like a bot", NOT "an SSG file was served" — it says `ssg` even when the fallback ran, which cost real debugging time here. And nginx's `location /ssg/ { internal; alias …/data/ssg/; }` points at a directory that does not exist; `try_files` resolves `$ssg_file` against `root` instead, so the real pages come from `apps/web/dist/ssg` and that block is dead code whose comment asserts it is required.

**This fix alone does not restore the pages** — a full SSG rebuild has to run after deploy for those ~389 books to get generated.

Not addressed here, and separate: the catch-all `location /` returns 200 to bots for any non-SSG path (the bot-404 guard exists only in `@spa`), and Cloudflare's managed `robots.txt` block sets `Content-Signal: ai-input` absent plus `Disallow: /` for ClaudeBot/GPTBot/Google-Extended and friends, which is why Bing reports the site cannot appear in Copilot and grounding results. The latter is a product decision, not a bug.
