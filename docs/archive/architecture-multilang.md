# Multilingual Architecture (EN + UK) — TextStack

This document defines the **multi-language architecture** for TextStack and is intended to be added to the repository as an architectural decision/reference.

## Goals

- Make book + chapter pages **SEO-indexable** per language (real HTML, stable URLs).
- Support multiple language variants of the **same logical book**, without duplicating structure.
- Allow gradual translation: EN can exist first, UA/UK can appear later per chapter.
- Enable correct Google indexing via `hreflang` and language-specific metadata.
- Keep the current TextStack principles: **self-hosted**, **simple MVP**, data in **PostgreSQL + disk**.

## Core Decision

> **Language is a variant of content, not a separate book and not a separate site.**

- One canonical `Book`
- One canonical `Chapter` structure
- One or more `*Translation` rows per language (`en`, `uk`, …)

## URL Strategy (SEO)

Recommended scheme (language prefix):

- EN (default):
  - `/books/{bookSlug}`
  - `/books/{bookSlug}/chapters/{chapterNumber}`
- UK (Ukrainian):
  - `/uk/books/{bookSlug}`
  - `/uk/books/{bookSlug}/chapters/{chapterNumber}`

Notes:
- Use `uk` (ISO 639-1 for Ukrainian) for URLs and language code.
- This scales to more languages: `/pl/...`, `/de/...`, etc.

### Canonical and hreflang

For a chapter page, emit:

- `rel="canonical"` pointing to the same-language URL (not cross-language).
- `hreflang` links to all available language variants.

Example (chapter 1):

```html
<link rel="canonical" href="https://site.com/uk/books/pride-and-prejudice/chapters/1" />
<link rel="alternate" hreflang="en" href="https://site.com/books/pride-and-prejudice/chapters/1" />
<link rel="alternate" hreflang="uk" href="https://site.com/uk/books/pride-and-prejudice/chapters/1" />
```

## Rendering Strategy

- Pages are rendered using **stored HTML per chapter language** (from DB).
- UI should offer a language switcher:
  - If translation exists → link to same chapter in that language
  - If not → show message “This chapter is not yet available in Ukrainian” and optionally fall back to EN (configurable)

## Ingestion / Translation Pipeline

### Original ingestion (EN)

1. Admin uploads source file to disk (`/srv/books/storage/original/...`)
2. Create ingestion job (`IngestionJob`)
3. Worker parses and extracts:
   - `Book`
   - `Chapters`
   - `BookTranslation` for `en`
   - `ChapterTranslation` for `en`
4. SEO pages become available immediately.

### Translation ingestion (UK)

Translation is a **separate pipeline**:

1. A translation job targets a book (and optionally specific chapters).
2. For each chapter:
   - Source: `ChapterTranslation(en)`
   - Output: `ChapterTranslation(uk)`
3. Translation can be:
   - human
   - assisted (but reviewable)
   - staged (draft → reviewed → published)

## Public/Legal Display

For translated versions, show an attribution block (configurable):

- Ukrainian page:
  - “Переклад українською мовою виконано у {year}.”
  - If public domain: “Оригінал — суспільне надбання (Public Domain).”

## Observability / Analytics

Track per language:
- page views
- read depth / time on page
- retention / progress
- ad RPM

This enables decisions like:
- which language gets better retention
- which books are worth translating first
