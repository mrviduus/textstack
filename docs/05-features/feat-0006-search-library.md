# PDD: Search Library — Provider-Agnostic Full-Text Search

## Status
Draft

## Goal
Extract search functionality into standalone `TextStack.Search` library following Extraction lib patterns. Enable provider-agnostic search (PostgreSQL FTS now, Elasticsearch/vector search later) with highlights, autocomplete, and facets.

## Non-goals
- Elasticsearch/Algolia providers (future work)
- Vector/semantic search (prepare chunking, implement later)
- Search analytics/tracking
- Admin search UI improvements

## Current State
- `Application/Search/SearchService.cs` - EF Core + PostgreSQL FTS (has client evaluation bug)
- `Chapter.SearchVector` - tsvector column with GIN index
- Trigger-based indexing via migration
- Basic search endpoint at `GET /{lang}/search`

## Architecture

```
backend/src/Search/TextStack.Search/
├── Contracts/           # SearchRequest, SearchResult, SearchHit, etc.
├── Abstractions/        # ISearchProvider, ISearchIndexer, IQueryBuilder
├── Providers/
│   └── PostgresFts/     # PostgresSearchProvider, TsQueryBuilder
├── Analyzers/           # MultilingualAnalyzer, TextNormalizer
├── Chunking/            # IDocumentChunker (vector search prep)
└── DependencyInjection.cs

tests/TextStack.Search.Tests/
```

## Acceptance Criteria
- [ ] Library compiles independently (no deps on Application/Domain/Infrastructure)
- [ ] PostgreSQL FTS provider passes all tests
- [ ] Search works with highlights and suggestions
- [ ] Existing search functionality maintained (no regression)
- [ ] `dotnet test` passes for all slices

---

## Slices

### Slice 1: Project scaffold + core contracts
**Goal:** Create project structure and DTOs
**Files:**
- `backend/src/Search/TextStack.Search/TextStack.Search.csproj`
- `backend/src/Search/TextStack.Search/Contracts/*.cs`
- `backend/src/Search/TextStack.Search/Enums/*.cs`
- `textstack.sln` (add project)
- `backend/Directory.Packages.props` (add Dapper)

**Tasks:**
- [ ] Create .csproj with SDK, add to solution
- [ ] `SearchRequest` record (Query, SiteId, Language, Offset, Limit)
- [ ] `SearchResult` record (Hits, TotalCount, Facets, Suggestions)
- [ ] `SearchHit` record (DocumentId, Score, Highlights, Metadata)
- [ ] `IndexDocument` record (Id, Title, Content, Language, SiteId)
- [ ] `Highlight`, `Facet`, `Suggestion` records
- [ ] `SearchLanguage` enum (Uk, En, Auto)

**Tests:** Compile check only (no logic yet)

---

### Slice 2: Core abstractions (interfaces)
**Goal:** Define provider contracts
**Files:**
- `backend/src/Search/TextStack.Search/Abstractions/*.cs`

**Tasks:**
- [ ] `ISearchProvider` (SearchAsync, SuggestAsync)
- [ ] `ISearchIndexer` (IndexAsync, IndexBatchAsync, RemoveAsync)
- [ ] `IQueryBuilder` (BuildQuery, BuildPrefixQuery)
- [ ] `IHighlighter` (GetHighlights)
- [ ] `ITextAnalyzer` (Normalize, Tokenize, GetLanguageConfig)

**Tests:** Interface compilation

---

### Slice 3: TsQuery builder + tests
**Goal:** Convert user queries to PostgreSQL tsquery
**Files:**
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/TsQueryBuilder.cs`
- `tests/TextStack.Search.Tests/Providers/PostgresFts/TsQueryBuilderTests.cs`

**Tasks:**
- [ ] Escape special characters (&|!:*())
- [ ] AND logic for multiple words
- [ ] Prefix matching (:*)
- [ ] Language config selection
- [ ] Unit tests: escaping, multi-word, prefix, edge cases

**Tests:** RED → GREEN → REFACTOR

---

### Slice 4: Multilingual analyzer + tests
**Goal:** Language detection and FTS config mapping
**Files:**
- `backend/src/Search/TextStack.Search/Analyzers/MultilingualAnalyzer.cs`
- `backend/src/Search/TextStack.Search/Analyzers/TextNormalizer.cs`
- `tests/TextStack.Search.Tests/Analyzers/MultilingualAnalyzerTests.cs`

**Tasks:**
- [ ] Map SearchLanguage → PostgreSQL config (uk→simple, en→english)
- [ ] Text normalization (lowercase, whitespace, HTML strip)
- [ ] Unit tests

**Tests:** RED → GREEN → REFACTOR

---

### Slice 5: PostgreSQL search provider (basic)
**Goal:** Implement search with Dapper (fix EF Core bug)
**Files:**
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSearchProvider.cs`
- `tests/TextStack.Search.Tests/Providers/PostgresFts/PostgresSearchProviderTests.cs`

**Tasks:**
- [ ] Implement `ISearchProvider.SearchAsync`
- [ ] Raw SQL: `SELECT ... WHERE search_vector @@ plainto_tsquery(...)`
- [ ] Use `ts_rank()` for ordering
- [ ] Pagination (OFFSET/LIMIT)
- [ ] Integration tests with test DB

**Tests:** Integration test with real PostgreSQL

---

### Slice 6: PostgreSQL indexer
**Goal:** Index documents to search table
**Files:**
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresIndexer.cs`
- `tests/TextStack.Search.Tests/Providers/PostgresFts/PostgresIndexerTests.cs`

**Tasks:**
- [ ] Implement `ISearchIndexer.IndexAsync`
- [ ] Batch indexing with `ON CONFLICT DO UPDATE`
- [ ] `to_tsvector()` with language config
- [ ] Remove by ID / by site
- [ ] Integration tests

**Tests:** Index → Search → Verify roundtrip

---

### Slice 7: Highlighting with ts_headline
**Goal:** Return matched text snippets
**Files:**
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresHighlighter.cs`
- Update `PostgresSearchProvider` to include highlights

**Tasks:**
- [ ] Use `ts_headline()` for snippets
- [ ] Configurable: MaxFragments, FragmentLength, StartSel, StopSel
- [ ] Unit tests for highlight formatting

**Tests:** Verify highlight tags in results

---

### Slice 8: Suggestions/autocomplete
**Goal:** Prefix-based suggestions
**Files:**
- `backend/src/Search/TextStack.Search/Providers/PostgresFts/PostgresSuggestionProvider.cs`
- Update `PostgresSearchProvider.SuggestAsync`

**Tasks:**
- [ ] `LIKE 'prefix%'` query on titles
- [ ] Order by frequency/relevance
- [ ] Limit results
- [ ] Unit tests

**Tests:** Prefix → suggestions list

---

### Slice 9: DI + configuration
**Goal:** Wire up services
**Files:**
- `backend/src/Search/TextStack.Search/Configuration/SearchOptions.cs`
- `backend/src/Search/TextStack.Search/Configuration/PostgresFtsOptions.cs`
- `backend/src/Search/TextStack.Search/DependencyInjection.cs`

**Tasks:**
- [ ] `SearchOptions` (DefaultLimit, MaxLimit, EnableHighlights)
- [ ] `PostgresFtsOptions` (ConnectionString)
- [ ] `AddTextStackSearch()` extension method
- [ ] `AddPostgresFtsProvider()` builder

**Tests:** DI registration test

---

### Slice 10: Document chunking (vector prep)
**Goal:** Prepare for future vector search
**Files:**
- `backend/src/Search/TextStack.Search/Chunking/IDocumentChunker.cs`
- `backend/src/Search/TextStack.Search/Chunking/OverlappingChunker.cs`
- `backend/src/Search/TextStack.Search/Chunking/DocumentChunk.cs`
- `tests/TextStack.Search.Tests/Chunking/OverlappingChunkerTests.cs`

**Tasks:**
- [ ] Chunk interface and model
- [ ] Overlapping chunker (300 tokens, 60 overlap)
- [ ] Sentence/paragraph boundary detection
- [ ] Unit tests

**Tests:** Verify chunk sizes, overlap, boundaries

---

### Slice 11: Test project setup + mocks
**Goal:** Create test infrastructure
**Files:**
- `tests/TextStack.Search.Tests/TextStack.Search.Tests.csproj`
- `tests/TextStack.Search.Tests/Mocks/MockSearchProvider.cs`
- `tests/TextStack.Search.Tests/Mocks/InMemorySearchProvider.cs`

**Tasks:**
- [ ] Create test project, add to solution
- [ ] Mock provider for consumer tests
- [ ] In-memory provider for unit tests

---

### Slice 12: Integration — Application layer
**Goal:** Replace SearchService with library
**Files:**
- `backend/src/Application/DependencyInjection.cs`
- Delete `backend/src/Application/Search/SearchService.cs`

**Tasks:**
- [ ] Register `ISearchProvider` from library
- [ ] Remove old `SearchService`
- [ ] Update any consumers

**Tests:** Existing search still works

---

### Slice 13: Integration — API endpoints
**Goal:** Update endpoints to use new contracts
**Files:**
- `backend/src/Api/Endpoints/SearchEndpoints.cs`

**Tasks:**
- [ ] Use `ISearchProvider` instead of `SearchService`
- [ ] Add `?highlight=true` parameter
- [ ] Add `/suggestions` endpoint
- [ ] Update response DTOs

**Tests:** API integration tests

---

### Slice 14: Integration — Worker indexing
**Goal:** Index chapters during ingestion
**Files:**
- `backend/src/Worker/Services/IngestionWorkerService.cs`

**Tasks:**
- [ ] Inject `ISearchIndexer`
- [ ] Index chapters after extraction
- [ ] Remove trigger-based indexing (optional)

**Tests:** Ingest book → search finds it

---

### Slice 15: Frontend — highlights + autocomplete
**Goal:** Update Search component
**Files:**
- `apps/web/src/components/Search.tsx`
- `apps/web/src/api/client.ts`

**Tasks:**
- [ ] Display highlight snippets in results
- [ ] Add autocomplete dropdown on typing
- [ ] Update API client types

**Tests:** Manual testing in browser

---

## Test Plan

### Unit Tests (per slice)
- TsQueryBuilder escaping + formatting
- MultilingualAnalyzer language mapping
- OverlappingChunker boundaries

### Integration Tests
- PostgresSearchProvider with test DB
- Index → Search → Highlight roundtrip
- API endpoint tests

### Manual Tests
- Search in browser with various queries
- Autocomplete UX
- Highlight display

---

## Dependencies

```xml
<PackageVersion Include="Dapper" Version="2.1.35" />
```

---

## Slice Summary

| # | Slice | Scope |
|---|-------|-------|
| 1 | Project scaffold + contracts | Setup |
| 2 | Core abstractions | Interfaces |
| 3 | TsQuery builder | Query parsing |
| 4 | Multilingual analyzer | Language support |
| 5 | PostgreSQL search provider | Core search |
| 6 | PostgreSQL indexer | Indexing |
| 7 | Highlighting | ts_headline |
| 8 | Suggestions | Autocomplete |
| 9 | DI + configuration | Wiring |
| 10 | Document chunking | Vector prep |
| 11 | Test project + mocks | Testing infra |
| 12 | Integration — Application | Migration |
| 13 | Integration — API | Endpoints |
| 14 | Integration — Worker | Indexing |
| 15 | Frontend updates | UI |

**Total: 15 slices**
