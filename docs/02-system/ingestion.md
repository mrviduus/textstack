# Book Ingestion Pipeline

Upload → store → queue job → Worker extracts chapters. Two parallel pipelines share one Worker loop:
**admin catalog** (`IngestionJob` → `Edition`/`Chapter`) and **user uploads**
(`UserIngestionJob` → `UserBook`/`UserChapter`). Verified against code 2026-10-04.

## 1. Upload

| | Admin catalog | User upload |
|-|---------------|-------------|
| Endpoint | `POST /admin/books/upload` (multipart) | `POST /me/books/upload` |
| Form fields | `file`, `siteId`, `title`, `language`, `description?`, `workId?`, `sourceEditionId?`, `authorIds?`, `genreId?` | `file`, `title?`, `language?` |
| Logic | `Application/Admin/AdminService.Upload.cs` | `Application/UserBooks/UserBookService.cs` |
| Creates | Work/Edition (Draft), `BookFile`, `IngestionJob` (Queued) | `UserBook`, `UserBookFile`, `UserIngestionJob` |
| Limits | admin only | entitlement tier (storage, max books) |

Files are stored by `LocalFileStorageService` under `Storage:RootPath` (`/storage` in the container,
`./data/storage` on the host) as `{first 2 chars of id}/{id}/{fileName}`.

## 2. Worker

`Worker/Services/IngestionWorker.cs` (BackgroundService) polls every **5 s**: first a catalog job
(`IngestionWorkerService` in `Worker/Services/IngestionService.cs`), then a user job
(`UserIngestionService`). Catalog jobs are picked oldest-first; a job stuck in `Processing` for
more than 10 min is picked up again (crashed worker). User jobs stop after `MaxAttempts`.

State machine (`JobStatus`): `Queued → Processing → Succeeded | Failed`.

Catalog steps:
1. Extract with `TextStack.Extraction` (format chosen by extension/content).
2. Save cover (optimized via `ImageOptimizer`).
3. `Application/Ingestion/IngestionService.ProcessParsedBookAsync` writes chapters and sets the
   Edition to **Published** (`PublishedAt = now`).
4. Run the linter (`LintResult`).
5. Optionally queue a `BookQualityJob` (admin setting `quality.autoQueueAfterIngestion`).

User steps are the same idea; user PDFs drop inline images because the reader shows the original
PDF ([ADR-012](../01-architecture/adr/ADR-012-pdf-original-first-lazy-parse.md)). After success the
book is marked `MetadataEnrichmentStatus = Pending`; `MetadataEnrichmentWorker` later fills
genre/year/description via the LLM.

## 3. Extraction (`backend/src/Extraction/TextStack.Extraction/`)

| Format | Extractor | Library |
|--------|-----------|---------|
| EPUB | `EpubTextExtractor` | VersOne.Epub |
| PDF | `PdfTextExtractor` (+ `Extractors/Pdf/`) | PdfPig, PDFtoImage |
| HTML | `HtmlTextExtractor` | HtmlAgilityPack |
| FB2 / other | `UnsupportedTextExtractor` | — |

Text processing order: Spelling → Hyphenation → Typography → Semantic → Linter. Rules:
`RULES.md` in that folder. `Quality/ChapterContentQualityAnalyzer` scores chapters 0–100.
ARM64 note: compiled `Regex`, not `[GeneratedRegex]`.

## 4. Search vector

No app code writes FTS. A Postgres trigger (`chapters_search_vector_trigger`, migration
`20251222000000_MultilingualFTS`) sets `chapters.search_vector` from `plain_text` on insert/update.

## 5. Key files

| File | Purpose |
|------|---------|
| `Api/Endpoints/AdminEndpoints.cs` | Admin upload, jobs, retry, preview, reprocess |
| `Api/Endpoints/UserBooksEndpoints.cs` | User upload, retry |
| `Worker/Services/IngestionWorker.cs` | Poll loop |
| `Worker/Services/IngestionService.cs` | Catalog job processing (`IngestionWorkerService`) |
| `Worker/Services/UserIngestionService.cs` | User job processing |
| `Application/Ingestion/IngestionService.cs` | Job selection + persisting chapters |

## 6. Monitoring

- `GET /admin/ingestion/jobs`, `GET /admin/ingestion/jobs/{id}`, `GET …/{id}/preview`,
  `POST …/{id}/retry`.
- OpenTelemetry traces/metrics (`IngestionActivitySource`, `IngestionMetrics`) → Aspire; logs via
  `docker compose logs worker`.

## See also

- [Database](database.md) · [Admin panel](admin.md) · [feat-0003 text extraction](../05-features/feat-0003-text-extraction-core.md)
