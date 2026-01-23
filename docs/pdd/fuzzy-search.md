# PDD: Fuzzy/Typo-Tolerant Search

## Problem
Search requires exact matches. Typos like "Кобзра" don't find "Кобзар".

## Solution
PostgreSQL pg_trgm extension with similarity() function. Threshold: 0.3

## Slices

### Slice 1: Migration - pg_trgm extension + indexes
**Goal**: Enable trigram matching infrastructure

**Files**:
- `backend/src/Infrastructure/Migrations/YYYYMMDD_AddPgTrgmExtension.cs`

**SQL**:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_editions_title_trgm ON editions USING GIST(lower(title) gist_trgm_ops);
CREATE INDEX idx_editions_authors_trgm ON editions USING GIST(lower(authors_json) gist_trgm_ops);
```

**Test**: Run migration, verify indexes exist
**Mergeable**: Yes - no breaking changes

---

### Slice 2: TsQueryBuilder prefix matching
**Goal**: Partial word matches in FTS ("дум" → "думи", "думив")

**Files**:
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/TsQueryBuilder.cs`

**Change**: Add `:*` suffix to tsquery tokens
- Input: "думи мої"
- Output: "думи:* & мої:*"

**Test**: Unit test for prefix query generation
**Mergeable**: Yes - backward compatible enhancement

---

### Slice 3: Fuzzy title matching in SearchAsync
**Goal**: Find books with typos in title

**Files**:
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`

**Change**: Add UNION clause for fuzzy title:
```sql
SELECT ...
  similarity(lower(e.title), @Query) * 8.0 AS Score
FROM editions e
WHERE similarity(lower(e.title), @Query) > 0.3
```

**Test**: Search "Кобзра" → finds "Кобзар"
**Mergeable**: Yes - additive query

---

### Slice 4: Fuzzy author matching in SearchAsync
**Goal**: Find books with typos in author name

**Files**:
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`

**Change**: Add UNION clause for fuzzy author:
```sql
SELECT ...
  similarity(lower(e.authors_json), @Query) * 6.0 AS Score
FROM editions e
WHERE similarity(lower(e.authors_json), @Query) > 0.3
```

**Test**: Search "Шевченок" → finds "Тарас Шевченко"
**Mergeable**: Yes - additive query

---

### Slice 5: Fuzzy suggestions (SuggestAsync)
**Goal**: Typo tolerance in autocomplete dropdown

**Files**:
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`

**Change**: Replace LIKE with similarity() in SuggestAsync:
```sql
WHERE similarity(lower(e.title), @Query) > 0.3
   OR similarity(lower(e.authors_json), @Query) > 0.3
```

**Test**: Type "Кобзр" → suggests "Кобзар"
**Mergeable**: Yes - enhanced suggestions

---

### Slice 6: Configurable threshold (optional)
**Goal**: Make fuzzy threshold configurable

**Files**:
- `backend/src/Search/TextStack.Search/SearchOptions.cs` (new or extend)
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`

**Change**: Add `FuzzyThreshold` property, inject via DI

**Test**: Change threshold, verify different results
**Mergeable**: Yes - optional enhancement

---

## Scoring Summary

| Priority | Match Type | Score Formula |
|----------|-----------|---------------|
| 1 | Exact title prefix (LIKE) | 10.0 |
| 2 | Fuzzy title | similarity × 8.0 |
| 3 | Fuzzy author | similarity × 6.0 |
| 4 | FTS content | ts_rank |

## Dependencies
- Slice 1 must be first (extension required)
- Slice 2 independent
- Slices 3-5 depend on Slice 1
- Slice 6 optional, depends on 3-5

## Order
1 → 2 → 3 → 4 → 5 → 6
