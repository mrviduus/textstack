# SEO Dashboard — Product Design Document

**Status:** Planning
**Priority:** High (visibility into SEO health for ~1400 books)

## 1. Problem

- No visibility into SEO status of books (missing descriptions, covers, etc.)
- Manual checking via curl/Search Console is tedious
- Can't bulk edit SEO fields
- No way to test prerender output from admin
- ~1000 draft books need descriptions before publishing

## 2. Goal

Admin panel feature that provides:
1. **Overview** of SEO health across all books
2. **Per-book SEO status** with warnings
3. **Bulk actions** (generate descriptions, rebuild sitemap)
4. **Testing tools** (prerender preview)

---

## 3. Views

### 3.1 Overview Dashboard

| Metric | Description |
|--------|-------------|
| Total books | Published + draft count |
| SEO-ready | Books with title <60 chars, description 140-160 chars, cover |
| Missing descriptions | Count + link to list |
| Missing covers | Count + link to list |
| Sitemap status | Last rebuild timestamp, URL count |

**Visual:** Cards with numbers + trend arrows (if we track history)

### 3.2 Books SEO Table

Paginated table with columns:
- Title (link to edit)
- Status (Published / Draft)
- SEO Score (computed)
- Title length (✅ <60 / ⚠️ 60-70 / ❌ >70)
- Description (✅ 140-160 / ⚠️ <140 or >160 / ❌ missing)
- Cover (✅ / ❌)
- In sitemap (✅ / ❌)

**Filters:**
- Status: All / Published / Draft
- SEO issues: All / Missing description / Missing cover / Title too long

**Actions:**
- Select multiple → "Generate descriptions" (LLM batch)
- Select multiple → "Publish" / "Unpublish"

### 3.3 Technical SEO Panel

| Item | View |
|------|------|
| robots.txt | Preview (read-only) |
| Sitemap index | Tree view of all sitemaps with URL counts |
| Prerender test | Input URL → show rendered HTML title/meta |

---

## 4. API Endpoints

### 4.1 Overview Stats
```
GET /admin/seo/overview
Response:
{
  "totalBooks": 1400,
  "publishedBooks": 400,
  "draftBooks": 1000,
  "missingDescriptions": 850,
  "missingCovers": 200,
  "sitemapLastUpdated": "2025-01-14T10:00:00Z",
  "sitemapUrlCount": 400
}
```

### 4.2 Books SEO List
```
GET /admin/seo/books?page=1&pageSize=50&status=draft&issue=missing_description
Response:
{
  "items": [
    {
      "id": 123,
      "title": "Frankenstein",
      "slug": "frankenstein",
      "status": "published",
      "titleLength": 12,
      "descriptionLength": 145,
      "hasCover": true,
      "inSitemap": true,
      "seoScore": 100
    }
  ],
  "total": 1400,
  "page": 1,
  "pageSize": 50
}
```

### 4.3 Sitemap Rebuild
```
POST /admin/seo/sitemap/rebuild
Response:
{
  "status": "ok",
  "urlCount": 400,
  "duration": "1.2s"
}
```

### 4.4 Prerender Test
```
GET /admin/seo/prerender-test?url=/en/books/frankenstein
Response:
{
  "url": "https://textstack.app/en/books/frankenstein",
  "title": "Frankenstein | TextStack",
  "description": "Read Frankenstein by Mary Shelley online...",
  "canonical": "https://textstack.app/en/books/frankenstein",
  "robots": null,
  "ogImage": "/storage/books/123/cover.jpg",
  "renderTime": "850ms"
}
```

### 4.5 Bulk Generate Descriptions
```
POST /admin/seo/generate-descriptions
Body: { "editionIds": [1, 2, 3, ...] }
Response:
{
  "jobId": "abc123",
  "status": "queued",
  "count": 50
}
```

---

## 5. SEO Score Calculation

```
Score = 100 points max

Title:
- Length <60: +25
- Length 60-70: +15
- Length >70: +5

Description:
- Length 140-160: +25
- Length 100-140 or 160-180: +15
- Missing or <100 or >180: +0

Cover:
- Present: +25
- Missing: +0

In sitemap:
- Yes (published + indexable): +25
- No: +0
```

Display:
- 90-100: ✅ Excellent
- 70-89: 🟡 Good
- 50-69: ⚠️ Needs work
- <50: ❌ Poor

---

## 6. LLM Integration (Future Slice)

For bulk description generation:
1. Use Ollama (self-hosted)
2. Prompt template:
   ```
   Generate a 150-character SEO description for this book:
   Title: {title}
   Author: {author}
   First 500 chars of content: {preview}
   ```
3. Queue via Worker service
4. Save to `Edition.seo_description`
5. Mark as `ready_for_review`

---

## 7. UI Components

### Admin Panel Routes
- `/admin/seo` — Overview dashboard
- `/admin/seo/books` — Books SEO table
- `/admin/seo/technical` — robots.txt, sitemap, prerender test

### Shared Components
- `<SeoScoreBadge score={85} />` — colored badge
- `<SeoIssueTag type="missing_description" />` — warning tag
- `<PrerenderPreview url="..." />` — fetches and displays meta

---

## 8. Work Slices

### Slice 1 — Overview + Stats API
- `GET /admin/seo/overview` endpoint
- Overview dashboard UI
- ~2 days

### Slice 2 — Books SEO Table
- `GET /admin/seo/books` endpoint with filters
- Table UI with pagination
- SEO score calculation
- ~3 days

### Slice 3 — Technical Panel
- robots.txt preview
- Sitemap tree view
- Sitemap rebuild action
- ~1 day

### Slice 4 — Prerender Test
- `GET /admin/seo/prerender-test` endpoint
- URL input + result display
- ~1 day

### Slice 5 — LLM Bulk Generation
- Ollama integration
- Worker job queue
- Bulk action in table
- ~3-5 days

---

## 9. Acceptance Criteria

- [ ] Admin can see overview of SEO health in 1 screen
- [ ] Admin can filter books by SEO issues
- [ ] Admin can test any URL's prerender output
- [ ] Admin can rebuild sitemap on demand
- [ ] Admin can select books and queue for LLM description generation

---

## 10. Dependencies

- Existing admin panel (`apps/admin/`)
- Existing sitemap endpoints
- Prerender service running
- (Future) Ollama for LLM

---

## 11. Out of Scope

- Google Search Console API integration (manual verification)
- Keyword tracking / rank monitoring
- Competitor analysis
- Link building tools
