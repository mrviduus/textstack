# SEO Crawler — User Guide

## What is this?

Internal SEO audit tool that crawls TextStack pages **as Googlebot sees them** (prerendered HTML). Helps find SEO issues before Google does.

---

## Your Sites

| Environment | Site Code | Domain | Seed URL |
|-------------|-----------|--------|----------|
| **Production** | general | textstack.app | `https://textstack.app/en` |
| **Production** | programming | textstack.dev | `https://textstack.dev/en` |
| Dev | general | general.localhost | `http://general.localhost:5173/en` |
| Dev | programming | programming.localhost | `http://programming.localhost:5173/en` |

**Note:** The `example.com` URLs you see are test data from automated tests — ignore them.

---

## How to Run a Crawl

### Step 1: Create Job

1. Go to **Admin → SEO Crawl**
2. Click **"New Crawl"**
3. Fill the form:

| Field | Description | Recommended |
|-------|-------------|-------------|
| **Site** | Which site to crawl | Pick `general` or `programming` |
| **Seed URL** | Starting page | `https://textstack.app/en` (prod) |
| **Max Pages** | Crawl limit | 100-500 for full site |
| **Max Depth** | How deep to follow links | 3-5 |

4. Click **"Create Job"**

### Step 2: Start Crawl

- Job is created in **Queued** status
- Click **"Start"** to begin crawling
- Status changes to **Running**
- Watch progress: `X / 500 pages`

### Step 3: Review Results

When **Completed**:
1. Click **"View"** to see results
2. Use filters to find problems:
   - **2xx** — OK pages
   - **3xx** — Redirects (check if intentional)
   - **4xx** — Broken links (fix these!)
   - **5xx** — Server errors (investigate)
   - **Missing Title** — SEO problem
   - **Missing Description** — SEO problem
   - **Missing H1** — SEO problem

### Step 4: Export

Click **"Export CSV"** to download results for spreadsheet analysis.

---

## What It Extracts

For each page:

| Field | What | Why Important |
|-------|------|---------------|
| URL | Page address | Reference |
| Status Code | HTTP response | 200=OK, 404=broken |
| Title | `<title>` tag | Google search result title |
| Meta Description | `<meta name="description">` | Google snippet |
| H1 | First `<h1>` heading | Page topic signal |
| Canonical | `<link rel="canonical">` | Duplicate prevention |
| Meta Robots | `<meta name="robots">` | Index/noindex control |

---

## How It Works (Technical)

1. **Uses Googlebot User-Agent** → triggers prerender
2. **Sees same HTML as Google** → accurate SEO data
3. **BFS crawl** → follows internal links only
4. **Respects limits** → won't overload server

```
User-Agent: Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)
```

---

## Common Issues & Actions

| Problem | What to Check | Action |
|---------|---------------|--------|
| Many 404s | Broken internal links | Fix links or add redirects |
| Missing titles | React hydration issues | Check SSR/prerender |
| Missing descriptions | Template not setting meta | Update page templates |
| Duplicate H1s | Multiple H1 tags | Keep one H1 per page |
| Redirect chains | 301→301→200 | Simplify to direct link |
| 5xx errors | Server/API issues | Check logs |

---

## Recommended Workflow

### Weekly Check
1. Run crawl with `max_pages=500`
2. Filter: 4xx errors → fix broken links
3. Filter: Missing title → fix meta
4. Export CSV for tracking

### Before Deploy
1. Run crawl on staging
2. Compare with previous results
3. Ensure no new 404s or missing SEO fields

### After Major Changes
1. Full crawl with `max_pages=1000`
2. Review all 3xx redirects
3. Check canonical tags

---

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| Max Pages | 500 | Stop after N pages |
| Max Depth | 5 | Don't follow links deeper than N levels |
| Concurrency | 4 | Parallel requests |
| Crawl Delay | 200ms | Wait between requests |
| Mode | Rendered | Uses Googlebot UA (always use this) |

---

## FAQ

**Q: Why Googlebot User-Agent?**
A: TextStack uses prerender for SEO. Googlebot UA triggers prerender, so you see exactly what Google sees.

**Q: Can I crawl external sites?**
A: No. This tool is for TextStack sites only. Use Screaming Frog for external audits.

**Q: Job stuck in Running?**
A: Click "Cancel" and check Worker logs. May be network issue or server timeout.

**Q: Why are there example.com jobs?**
A: Test data from automated tests. You can ignore them or they'll be cleaned up.
