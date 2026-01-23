
# PDD: Multilingual Content Model v1 (UA/EN)

## Goal
Design bilingual support (Ukrainian / English) for TextStack so that:
- each page has **exactly one language**
- URLs and SEO are correct and scalable
- translations are linked at the data level (no duplicated books)
- translations can be added gradually (partial coverage allowed)

## Non-goals
- On-the-fly machine translation
- Translation admin/editor UI
- Support for more than 2 languages in MVP (architecture must allow it later)

---

## User Scenarios

### S1. Open a book page
- User opens a URL with language prefix (`/ua/...` or `/en/...`)
- Sees content in **one language only**
- Sees a language switcher

### S2. Switch language
- If translation exists → navigate to the equivalent page
- If translation does not exist → show fallback screen

### S3. Search & SEO
- UA and EN pages are indexed as separate pages
- Language versions are connected via `hreflang`

---

## URL & Routing

### Principle
Language is part of the URL, not a query parameter.

### Format (MVP)
- `/ua/books/{slug}`
- `/en/books/{slug}`

> For MVP, `/books/` is not localized to keep routing and redirects simple.

### Canonical URLs
- Each language page is canonical to itself
- UA and EN do NOT canonicalize to each other

---

## SEO Requirements

For each page:
- `<html lang="uk">` for `/ua/*`
- `<html lang="en">` for `/en/*`
- `hreflang` only for **existing published translations**

Example:
- `hreflang="uk"` → UA page
- `hreflang="en"` → EN page

If a translation does not exist, its `hreflang` must NOT be emitted.

---

## UX: Language Switcher

### Location
- Header / top of the site

### Behavior
- Switches to the equivalent page using `work_id`
- Works for books, authors, categories

---

## Fallback Behavior (Missing Translation)

### Rules
- Direct URL access to a missing localization → **404**
- Access via language toggle → **fallback screen**

### Fallback Screen
- Message: “This page isn’t available in English yet.”
- Button to return to original language
- Book content is NOT displayed

Purpose: avoid mixed-language pages and SEO noise.

---

## Data Model (Logical)

### Work
- `id`
- `work_key` (stable identifier, e.g. `kobzar`)
- `created_at`
- `updated_at`

### WorkLocalization
- `id`
- `work_id`
- `lang` (`uk`, `en`)
- `title`
- `description`
- `slug`
- `seo_title`
- `seo_description`
- `is_published`
- `published_at`
- `created_at`
- `updated_at`

Constraints:
- `unique(work_id, lang)`
- `unique(lang, slug)`

### WorkContent (optional)
- `id`
- `work_id`
- `lang`
- `content_format` (epub/html/text)
- `content_path`

---

## Language Resolution Policy

### Anonymous user
1. Language from URL
2. `Accept-Language` header
3. Default language (config)

### Authenticated user (future)
- Profile language overrides everything

### Redirects
- `/` → `/{defaultLang}/`
- URLs without language → redirected using resolution policy

---

## Publication & Visibility

- Localization is public only if `is_published = true`
- Work without localization → 404
- Fallback is available **only** via language toggle

---

## Observability

Log events:
- language resolved (source)
- attempt to access missing localization

---

## Risks & Mitigations

- Risk: empty EN pages → do not publish without content
- Risk: different slugs per language → always bind via `work_id`

---

## Implementation Slices

### Slice 1: Language Routing
**Scope**
- `/{lang}/...`
- Supported languages: `uk`, `en`
- `/` redirects to `/{defaultLang}/`

**Acceptance Criteria**
- All page handlers receive `lang` in context

---

### Slice 2: Data Model & Book Page
**Scope**
- Tables `Work`, `WorkLocalization`
- Lookup by `(lang, slug)`

**Acceptance Criteria**
- UA and EN pages work independently

---

### Slice 3: Language Toggle
**Scope**
- Language switcher
- Navigation via `work_id`

---

### Slice 4: Fallback
**Scope**
- 404 on direct access
- Fallback only via toggle

---

### Slice 5: SEO Tags
**Scope**
- `<html lang>`
- `hreflang`

---

**Status:** Approved for MVP
