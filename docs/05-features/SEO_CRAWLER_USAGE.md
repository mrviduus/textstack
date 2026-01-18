# SEO Crawler — User Guide

## What is it?

SEO Crawler validates SEO quality of TextStack pages **before Google sees them**.

### Key Concept

```
Add book → Appears in sitemap.xml → Run SEO Crawler →
→ Find issues → Fix them → Google sees clean version
```

### Why does it matter?

1. **TextStack uses Prerender** — Google sees pre-rendered HTML, not React code
2. **Crawler acts as Googlebot** — sees exactly what Google will see
3. **Check before indexing** — fix issues before they hit search results

---

## How it works technically

### User-Agent

Crawler uses Googlebot User-Agent:

```
Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
```

When Prerender sees this User-Agent, it returns **pre-rendered HTML** instead of empty SPA.

### What gets checked?

Crawler takes all URLs from sitemap (books, authors, genres) and for each:

1. Makes HTTP request as Googlebot
2. Gets HTML (via Prerender)
3. Parses SEO fields:
   - `<title>` — page title
   - `<meta name="description">` — snippet description
   - `<h1>` — main heading
   - `<link rel="canonical">` — canonical URL
   - `<meta name="robots">` — indexing directives

### Where do URLs come from?

**Not from sitemap.xml via HTTP**, but **directly from database**.

Uses same logic as sitemap.xml generation:
- Books: `Published` + `Indexable = true`
- Authors: `Indexable = true` + has published books
- Genres: `Indexable = true` + has published books

---

## Step-by-step guide

### 1. Open Admin → SEO Crawl

```
http://localhost:5174/seo-crawl     (dev)
https://admin.textstack.app/seo-crawl  (prod)
```

### 2. Create new crawl

1. Click **"New Crawl"**
2. Select site:
   - `general (textstack.app)` — main site
   - `programming (textstack.dev)` — programming books

3. You'll see preview:
   ```
   Will check 56 URLs:
   • 23 books
   • 22 authors
   • 11 genres
   ```

4. Configure limits (optional):
   - **Max Pages** — maximum pages (default 500)

5. Click **"Create Job"**

### 3. Start crawl

- Status will be **Queued**
- Click **"Start"**
- Status changes to **Running**
- Watch progress: `12 / 56`

### 4. View results

When status is **Completed**:

1. Click **"View"**
2. See statistics:

| Metric | Meaning |
|--------|---------|
| **2XX** | ✅ Successful pages |
| **3XX** | ⚠️ Redirects |
| **4XX** | ❌ Broken links (404) |
| **5XX** | 🔥 Server errors |
| **Missing Title** | No `<title>` |
| **Missing Desc** | No meta description |
| **Missing H1** | No `<h1>` |
| **NoIndex** | Page excluded from index |

### 5. Filter issues

Use filters:
- **Status Code** — 2xx/3xx/4xx/5xx
- **Missing Title** — pages without title
- **Missing Description** — without description
- **Missing H1** — without H1

### 6. Export

Click **"Export CSV"** for analysis in Excel/Google Sheets.

---

## What to check?

### Weekly

1. Run crawl on prod (textstack.app)
2. Check:
   - Any 404 errors?
   - All pages have title/description/H1?
   - No unexpected noindex?

### After adding books

1. Add book via Admin
2. Wait for Worker to process
3. Run SEO Crawl
4. Verify new book:
   - Returns 200
   - Has title = book name
   - Has description
   - Has H1

### Before major changes

1. Run full crawl
2. Save CSV as baseline
3. Make changes
4. Run again
5. Compare results

---

## Common issues and solutions

### Many 404 errors

**Cause:** Broken links or deleted pages

**Solution:**
1. Check if book/author/genre exists
2. If deleted — add redirect
3. If error — fix slug

### Missing Title

**Cause:** Prerender not working or React component doesn't set title

**Solution:**
1. Check `curl -A "Googlebot" https://textstack.app/en/books/{slug}`
2. Find `<title>` in response
3. If missing — check React page component

### Missing Description

**Cause:** Meta description not set

**Solution:**
1. Book should have `seo_description` in database
2. Verify component uses this field

### Missing H1

**Cause:** Page has no `<h1>` tag

**Solution:**
1. Every page should have one `<h1>`
2. For books: book title
3. For authors: author name
4. For genres: genre name

### NoIndex on pages that should be indexed

**Cause:** Wrong `<meta name="robots">`

**Solution:**
1. Books, authors, genres should be `index, follow`
2. Only chapters should be `noindex, follow`
3. Check React component logic

---

## Settings

| Parameter | Default | Description |
|-----------|---------|-------------|
| **Max Pages** | 500 | Maximum pages to check |
| **Concurrency** | 4 | Parallel requests |
| **Crawl Delay** | 200ms | Pause between requests |

---

## Results table columns

| Column | Description |
|--------|-------------|
| **URL** | Page address |
| **Type** | `book` / `author` / `genre` |
| **Status** | HTTP code (200, 301, 404...) |
| **Title** | `<title>` content |
| **Meta Desc** | Meta description content |
| **H1** | First `<h1>` content |
| **Error** | Request error (if any) |

---

## FAQ

### Why use Googlebot User-Agent?

TextStack uses Prerender for SEO. When request comes with Googlebot User-Agent, server returns pre-rendered HTML instead of empty SPA. Crawler sees exactly what Google will see.

### What does "Type" mean in results?

- `book` — book page (`/en/books/{slug}`)
- `author` — author page (`/en/authors/{slug}`)
- `genre` — genre page (`/en/genres/{slug}`)

### Why no chapters in crawl?

Chapters have `noindex` and shouldn't be indexed. We only check what goes to Google: books, authors, genres.

### Job stuck in Running?

1. Click **"Cancel"**
2. Check Worker logs: `docker logs textstack_worker_prod`
3. Possible causes:
   - Network issues
   - Prerender not responding
   - Timeouts

### Can I check external site?

No. Crawler only works with TextStack sites (textstack.app, textstack.dev).

### How often to run?

- **Weekly** — for monitoring
- **After each deploy** — verify nothing broke
- **After adding content** — ensure correct SEO

---

## Related docs

- [SEO Policy](../02-system/seo-policy.md) — indexing policy
- [SEO Implementation](../02-system/seo-implementation.md) — technical implementation
- [Prerender Setup](../03-ops/deployment.md) — Prerender configuration

---

*Last updated: 2025-01-18*
