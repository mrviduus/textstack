# SEO Indexing & Rendering Policy

**TextStack — Official SEO Strategy**

## 1. Purpose

This document defines the official SEO strategy for TextStack.

TextStack is a public-domain online library focused on:
- high-quality reading experience (UX)
- clean information architecture
- long-term organic discoverability

Because public-domain texts are widely duplicated across the web, SEO must be handled deliberately to avoid thin content, duplication signals, and crawl budget waste.

---

## 2. Core SEO Principle

> Only pages that add unique value should be indexed.

Raw public-domain text does NOT provide unique SEO value.
Structure, metadata, aggregation, and context DO.

---

## 3. Indexing Strategy (Indexable Pages)

The following pages MUST be indexable (`index, follow`):

| Page Type | URL Pattern | Reason |
|-----------|-------------|--------|
| Homepage | `/{lang}/` | Brand & discovery |
| Books list | `/{lang}/books` | Content aggregation |
| Book page | `/{lang}/books/{slug}` | Primary SEO entry point |
| Author page | `/{lang}/authors/{slug}` | Entity-based search intent |
| Genre page | `/{lang}/genres/{slug}` | Entity-based search intent |
| About page | `/{lang}/about` | Brand & trust |

Each Book page represents:
- unique metadata
- contextual description
- navigation structure (TOC)
- structured data (Schema.org Book)

---

## 4. Non-Indexable Pages (Critical)

The following pages MUST NOT be indexed, but links MUST be followed.

| Page Type | URL Pattern | Directive |
|-----------|-------------|-----------|
| Chapter pages | `/{lang}/books/{slug}/{chapter}` | `noindex, follow` |
| Reader views | `/{lang}/reader/*` | `noindex, follow` |
| Search results | `/{lang}/search?q=*` | `noindex, follow` |
| User library | `/{lang}/library` | `noindex, follow` |
| Auth pages | `/auth/*` | `noindex, nofollow` |

### Rationale
- Chapters contain partial fragments of the same text
- No independent search intent for chapters
- High duplication across Gutenberg, Wikisource, etc.
- Search results are dynamic, not crawl-worthy
- User library is personalized content
- Indexing fragments reduces site-wide trust

---

## 5. Technical Implementation Rules

### 5.1 Preferred Method (Default)

```html
<meta name="robots" content="noindex, follow">
```

Use for:
- chapter pages
- reader routes
- search results
- user library

### 5.2 Alternative (When Required)

```html
<link rel="canonical" href="/{lang}/books/{slug}">
```

Use canonical only if robots meta cannot be applied.

---

## 6. Rendering & Crawling Policy

### 6.1 Rendering Model

- SPA rendering for users
- Dynamic rendering (Prerender) for search engines

### 6.2 Bots That MUST Receive Prerendered HTML

| Bot | Purpose |
|-----|---------|
| Googlebot | Main Google crawler |
| Google-InspectionTool | Search Console URL Inspection |
| GoogleOther | Secondary Google services |
| AdsBot-Google | Ads quality checks |
| Mediapartners-Google | AdSense |
| Bingbot | Microsoft search |
| DuckDuckBot | DuckDuckGo search |
| Yandex | Russian search |
| Baiduspider | Chinese search |
| facebookexternalhit | Facebook sharing |
| Twitterbot | Twitter cards |
| LinkedInBot | LinkedIn sharing |
| Slackbot | Slack previews |
| WhatsApp | WhatsApp previews |
| Applebot | Apple/Siri |

**Critical**: Failure to prerender for `Google-InspectionTool` will result in:
- "Crawled – currently not indexed" warnings
- Loss of indexed pages
- Unstable search visibility

---

## 7. Metadata Rules

### 7.1 Title Tags

- Book page: `{Book Title} | TextStack`
- Author page: `{Author Name} — books by author | TextStack`
- Genre page: `{Genre Name} — books | TextStack`

### 7.2 Meta Description

- Length: 140–160 characters
- Purpose: improve click-through rate
- Must be unique per book/author

---

## 8. Structured Data

Book pages MUST include:
- `schema.org/Book`
- title, author, description, language
- image (cover)
- url

Author pages MUST include:
- `schema.org/Person`
- name, description, image, url

---

## 9. Hreflang Tags

Book pages with multiple language editions MUST include hreflang tags:

```html
<link rel="alternate" hreflang="en" href="https://textstack.app/en/books/frankenstein">
<link rel="alternate" hreflang="uk" href="https://textstack.app/uk/books/frankenstein">
<link rel="alternate" hreflang="x-default" href="https://textstack.app/en/books/frankenstein">
```

Rules:
- Include all available language editions
- `x-default` points to primary language (usually English)
- Only for book pages with multiple editions

---

## 10. Sitemap Strategy

Only indexable pages appear in sitemap:

| Sitemap | Contents |
|---------|----------|
| `/sitemap.xml` | Index of all sitemaps |
| `/sitemaps/books.xml` | All book pages |
| `/sitemaps/authors.xml` | All author pages |

**Chapter pages MUST NOT appear in sitemap.**

---

## 11. HTTP 404 Rules

To prevent Google from indexing empty or invalid pages, the API returns HTTP 404 for:

| Entity | 404 Condition |
|--------|---------------|
| Book | Not found, unpublished, OR has 0 chapters |
| Author | Not found OR has 0 published editions |
| Genre | Not found OR has 0 published editions |
| Chapter | Not found OR parent edition unpublished |

### Implementation

**Backend (API):**
- `GET /books` → only shows published books with chapters
- `GET /books/{slug}` → 404 if `book is null OR book.Chapters.Count == 0`
- `GET /authors` → only shows authors with published editions
- `GET /authors/{slug}` → 404 if `author is null OR author.Editions.Count == 0`
- `GET /genres` → only shows genres with published editions
- `GET /genres/{slug}` → 404 if `genre is null OR genre.Editions.Count == 0`

**Frontend (SPA):**
- Uses `<meta name="prerender-status-code" content="404">` for prerender service
- Prerender service reads this tag and returns HTTP 404 to bots
- SeoHead component accepts `statusCode` prop for error pages

### Rationale

1. Authors/genres with 0 books have no content to index
2. Books with 0 chapters have no readable content
3. Prevents "soft 404" warnings in Search Console
4. Keeps sitemap and index in sync

---

## 12. Anti-Patterns

DO NOT:
- Index raw book text (chapters)
- Index search results pages
- Block chapters via `robots.txt` (use `noindex, follow` instead)
- Rely on client-side SEO only (use prerender)
- Generate thousands of indexable URLs from a single book
- Include chapter URLs in sitemap
- Forget to clear prerender cache after SEO changes

---

## 13. Verification & Testing

After any SEO change:

### 13.1 Test Prerender Output

```bash
# Book page (should be indexable - no robots meta)
curl -s -A "Googlebot" https://textstack.app/en/books/frankenstein | grep -i "robots"
# Expected: (nothing)

# Chapter page (should have noindex)
curl -s -A "Googlebot" https://textstack.app/en/books/frankenstein/letter-i-part-1 | grep -i "robots"
# Expected: <meta name="robots" content="noindex,follow">
```

### 13.2 Clear Prerender Cache

```bash
docker restart textstack_prerender_prod
```

### 13.3 Validate in Google Search Console

1. Use URL Inspection tool
2. Book pages → "URL is on Google" or "URL can be indexed"
3. Chapter pages → "Excluded by 'noindex' tag" (expected)

---

## 14. Future Extensions

Indexing chapter-level pages is acceptable ONLY if they provide unique value:
- Commentary or annotations
- Literary analysis
- Summaries
- Educational content
- User-generated insights

Raw public-domain text alone is never indexable.

---

## 15. Summary

| Principle | Rule |
|-----------|------|
| Entry point | One book = one SEO entry point |
| Chapters | For reading, not ranking |
| Index target | Aggregation, not fragments |
| Priority | Trust > quantity |
| Strategy | Conservative SEO for public-domain |

---

Last updated: 2025-01-14
Owner: TextStack Core Team
