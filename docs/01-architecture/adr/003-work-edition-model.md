# ADR-003: Work/Edition Data Model

**Status**: Accepted — model still in force. Note: Ukrainian content was removed 2026-04-21 (nginx 301s `/uk/*` → `/en/*`), so today every Edition is `en` and the multilingual motive is dormant.
**Date**: 2024-12

## Context

Need to support multilingual books (EN, UK) without duplicating structure.

Considered:
1. Single Book entity with translation tables
2. Separate Book per language
3. Work → Edition hierarchy

## Decision

Use **Work/Edition/Chapter** hierarchy:

```
Work (canonical identity)
  └── Edition (per language: EN, UK)
        └── Chapter (content per edition)
```

- Work: abstract book identity, site-scoped slug
- Edition: language-specific version with title, authors, status
- Chapter: HTML content with FTS

## Key Fields

**Edition**:
- `WorkId` (FK)
- `Language` (en, uk)
- `SourceEditionId` (nullable, points to EN for translations)
- `Status` (Draft, Published, Hidden)

## Consequences

### Pros
- Clean multilingual support
- Translation linking via SourceEditionId
- hreflang SEO implementation straightforward
- One ingestion job per edition

### Cons
- More complex than single Book entity
- Requires work_id for canonical URL
- Extra joins for some queries

## Notes

- Replaces earlier Book/BookTranslation/ChapterTranslation design
- User reading data (progress, notes) scoped to Edition
