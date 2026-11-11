# ADR-004: PostgreSQL Full-Text Search

**Status**: Accepted — still in force. The Meilisearch provider and the `search_documents` copy table were deleted 2026-10-01 (migration `20261001221307_DropSearchDocuments`); `chapters.search_vector` (trigger-maintained) is the only index.
**Date**: 2024-12

## Context

Need search across chapter content. Options:
1. PostgreSQL FTS
2. Elasticsearch
3. Algolia/Typesense
4. LIKE queries

## Decision

Use **PostgreSQL Full-Text Search** with tsvector and GIN indexes.

## Implementation

- `Chapter.PlainText` stores extracted text
- `Chapter.SearchVector` (tsvector) auto-generated
- GIN index on SearchVector
- English config for stemming

Query:
```sql
SELECT ... FROM chapters
WHERE search_vector @@ plainto_tsquery('english', @query)
ORDER BY ts_rank_cd(search_vector, plainto_tsquery('english', @query)) DESC
```

## Consequences

### Pros
- No external service dependency
- Built into PostgreSQL
- Good enough for MVP scale
- No additional infrastructure

### Cons
- Limited ranking sophistication
- Single language config per column
- No fuzzy matching by default

## Notes

- May add pg_trgm for fuzzy title/author search
- Elasticsearch migration possible if needed at scale
