# SEO_CRAWLER_TASK.md
## TextStack — Internal SEO Crawler (MVP / Slice 1)

---

## 1. Goal

Implement an **internal SEO crawler module** inside the TextStack admin panel that replicates the **core practical value of Screaming Frog** for our own site.

The crawler must allow admins to:
- Crawl TextStack pages
- See SEO-critical fields per URL
- Detect indexing problems early
- Export results for bulk SEO operations

This is **not** a general-purpose crawler and **not** a full Screaming Frog clone.

---

## 2. Architectural Context (Critical)

TextStack uses **dynamic rendering (prerender)** for search engines.

That means:
- Users see a React SPA
- Googlebot receives **prerendered HTML**
- Google indexes **ONLY the prerendered HTML**

➡️ Therefore, **SEO correctness = Googlebot HTML correctness**

This task is built around that constraint.

---

## 3. FINAL RULE — SOURCE OF TRUTH (NON-NEGOTIABLE)

**The only valid source of SEO data is the HTML that Googlebot actually receives.**

### Mandatory implications:
- The crawler MUST default to **Rendered (Google View)** mode.
- All SEO fields MUST be extracted from **prerendered HTML**, not SPA output.
- If rendered HTML and raw SPA HTML differ → **rendered HTML always wins**.

### Explicit constraints:
- The crawler MUST use a Googlebot-compatible User-Agent.
- The crawler MUST rely on existing prerender infrastructure.
- The crawler MUST NOT use headless Chrome or internal JS rendering in Slice 1.
- Any raw/non-rendered crawl is **diagnostic only** and must never be used for SEO automation.

---

## 4. Scope — DO (MVP)

### 4.1 Backend: Data Models

#### `seo_crawl_jobs`
- `id` (uuid)
- `created_at`
- `started_at`
- `finished_at`
- `status` (Queued | Running | Completed | Failed | Canceled)
- `seed_url`
- `host_allowlist`
- `crawl_mode` (`rendered` | `raw`) — default: `rendered`
- `max_pages` (default 500)
- `max_depth` (default 5)
- `concurrency` (default 4)
- `crawl_delay_ms` (default 200)
- `user_agent`
- `error`
- `pages_crawled`

#### `seo_crawl_results`
- `id`
- `job_id`
- `url`
- `normalized_url`
- `depth`
- `status_code`
- `content_type`
- `html_bytes`
- `title`
- `meta_description`
- `h1`
- `canonical`
- `meta_robots`
- `x_robots_tag`
- `fetched_at`
- `fetch_error`

Indexes:
- `(job_id, normalized_url)` UNIQUE
- `(job_id, status_code)`

---

### 4.2 HTTP Crawling Rules

#### Default mode: `rendered`
Requests MUST include:
```
User-Agent: Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
Accept: text/html,application/xhtml+xml
```

This MUST trigger prerender.

#### URL handling
- HTTP/HTTPS only
- Same-host only (allowlist enforced)
- Ignore:
  - `mailto:`
  - `tel:`
  - `javascript:`
  - fragments (`#...`)
- Normalize URLs (remove fragments, resolve relatives)
- Deduplicate by `normalized_url`

#### Limits
- Respect `max_pages`
- Respect `max_depth`
- Follow redirects up to 5 hops
- Apply crawl delay globally or per host

---

### 4.3 HTML Parsing (Rendered HTML)

Extract:
- `<title>`
- `<meta name="description">`
- first `<h1>`
- `<link rel="canonical">`
- `<meta name="robots">`
- `X-Robots-Tag` HTTP header

Extract internal links from `<a href>` only.

---

### 4.4 Worker Execution

- Implement as background/hosted service
- BFS queue
- Cancellable via `CancellationToken`
- Persist results incrementally (do NOT hold everything in memory)
- Job must survive individual URL failures

---

### 4.5 Admin UI (Minimal)

**SEO Crawl page**
- Job list
- “New Crawl” button
- Form:
  - seed_url (default: https://textstack.app/en)
  - max_pages
  - max_depth

**Job details**
- Status + progress
- Table of URLs
- Filters:
  - Status group (2xx / 3xx / 4xx / 5xx)
  - Missing title
  - Missing meta description
  - Missing H1
- CSV export

---

## 5. Scope — DO NOT (Hard Limits)

- ❌ No headless browser
- ❌ No JavaScript execution
- ❌ No site graph / visualization
- ❌ No robots.txt parsing
- ❌ No sitemap parsing
- ❌ No external domains
- ❌ No duplicate detection logic beyond URL dedupe
- ❌ No crawl comparisons

---

## 6. Testing Requirements

### Unit Tests
- URL normalization
- Host allowlist enforcement
- HTML parsing (title/meta/H1/canonical)
- Link extraction rules

### Integration Test
Spin up a small test site with:
- 200 OK page
- Redirect chain
- 404 page
- Page requiring prerender to expose meta

Verify:
- Job completes
- Rendered HTML fields are populated
- CSV export works
- No external URLs crawled

---

## 7. Acceptance Criteria

- Admin can run a crawl and see results.
- SEO fields reflect **Googlebot-rendered HTML**.
- Missing SEO fields are detectable.
- Crawl never leaves allowed domains.
- Results are exportable.
- Crawl mode is stored and visible.

---

## 8. Explicit Non-Goal

This module is **not a crawler product**.  
It is an **SEO control instrument** aligned with Google indexing reality.

---

## 9. Next Slices (Out of Scope)

- Slice 2: Issues engine (duplicates, length rules, canonical mismatch)
- Slice 3: Inlinks / outlinks + broken links
- Slice 4: Rendered vs Raw comparison
- Slice 5: Sitemap + robots.txt analysis
