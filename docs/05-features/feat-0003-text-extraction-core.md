# PDD: Text Extraction Core (multi-format)

## Status
Implemented

## Goal
Build a core ingestion component that converts uploaded book files into searchable text + reader-friendly content.
Support incremental format coverage with safe defaults and strong test coverage.

## Non-goals
- Perfect OCR quality
- DRM-protected formats
- Full UI polish
- Full chapter detection for all formats on day 1

## Out of Scope
- Observability (OpenTelemetry tracing/metrics/dashboards) — see [feat-0005](feat-0005-observability-opentelemetry.md)

## Principles
- Store original file on disk (private).
- Extract and normalize into a single internal model:
  - Metadata
  - Content units (chapters or pages)
  - Plain text for search (FTS)
- Format support is incremental. Unknown formats are accepted but marked "Unsupported".

## Supported formats (incremental)
Phase 1:
- TXT / MD (plain text)
- EPUB (basic extraction)

Phase 2:
- PDF (text layer)
- FB2 (XML-based)

Phase 3:
- Image-only PDFs via OCR fallback

## Normalized Output Model
ExtractionResult:
- SourceFormat
- Metadata: title, authors, language (best effort)
- Units: list of ContentUnit
  - Type: Chapter | Page
  - Title (optional)
  - Html (optional)
  - PlainText (required if extractable)
  - OrderIndex
- Diagnostics:
  - TextSource: NativeText | OCR | None
  - Confidence (optional)
  - Warnings

## Ingestion flow (high-level)
Upload -> Create IngestionJob -> Worker picks -> Extract -> Normalize -> Persist -> Index -> Mark Published/Ready

## Admin UX (minimal)
- Upload a file
- See job status + extracted summary:
  - detected format
  - units count
  - text source (native/OCR/none)
  - warnings/errors

## Acceptance Criteria
- A minimal extractor pipeline exists with plugin handlers.
- TXT upload produces 1 ContentUnit with text stored + searchable.
- EPUB upload produces multiple units (or 1 if simplified), stored + searchable.
- Failed/unsupported formats do not crash ingestion; job becomes FailedUnsupported.
- All core logic has unit tests and at least one integration test per supported format.