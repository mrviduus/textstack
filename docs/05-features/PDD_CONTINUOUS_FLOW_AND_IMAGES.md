# PDD: Continuous Reading Flow + Image Ingestion (MVP)

**Project:** TextStack (online lib)

**Owner:** Vasyl

**Date:** 2026-01-18

## Context
Right now the import pipeline drops (ignores) all non-cover images from book sources. Some books (e.g., illustrated editions) embed images in chapters via `<img>` and related markup. Losing these assets reduces reader quality and content fidelity.

Separately, the reader experience is currently split into many “pages/chunks” (e.g., thousands). The desired UX is a *single continuous scroll* (“one canvas”) while still keeping performance acceptable.

This PDD defines an MVP that:
1) **Ingests and serves images** referenced by the book content, and
2) Presents content as a **continuous flow** to the user.

## Goals
### G1 — Preserve all book images during import
- Keep **cover** and **in-book** images (JPG/PNG/SVG/WebP, etc.).
- Maintain correct references from content to stored assets.

### G2 — Continuous reading UX
- Reader shows **one continuous scroll** for a book.
- Navigation (TOC) still works.

### G3 — Minimal, testable, mergeable MVP
- No premature optimization.
- Works on existing imported books moving forward; backfill can be a follow-up.

## Non-goals (for this MVP)
- No image transformations/optimization pipeline (resizing, recompression, CDN, responsive images).
- No advanced illustration classification (decorative vs figure).
- No offline-first caching strategy.
- No annotations/highlights/bookmarks.
- No “single giant HTML file” approach that produces a massive DOM.

## Users & Use cases
- **Casual reader:** opens a book and reads without pagination friction.
- **Power reader:** uses TOC/jump links and expects images to appear inline.
- **SEO / crawler:** prerendered HTML should include the same inline images.

## Current state (assumed)
- Import creates many page/chunk records.
- Sanitization or parsing removes/ignores `<img>` or strips referenced resources.
- Assets (beyond cover) are not copied into storage.

## Proposed approach (MVP)

### Key idea
**Store content as an ordered “flow” of blocks** (paragraphs, headings, images). Render it to the user as a continuous scroll **while only loading a window** of blocks for performance.

This gives:
- Continuous UX
- Small payloads
- Works with prerendering

### Data model (logical)
Introduce a *Book Content Flow* representation.

#### Entities
1) **BookAsset**
- `Id`
- `BookId`
- `Kind` (e.g., `cover`, `inline-image`, `stylesheet`, optional)
- `OriginalPath` (path inside source, e.g. `images/fig01.jpg`)
- `StoragePath` (server path or object key)
- `ContentType` (mime)
- `ByteSize`
- `Checksum` (optional)

2) **BookBlock** (ordered)
- `Id`
- `BookId`
- `Index` (monotonic order)
- `Type` (`heading`, `paragraph`, `blockquote`, `list`, `image`, etc.)
- `Html` (sanitized snippet) OR structured payload (later)
- `AnchorId` (optional; for TOC & deep links)

3) **BookTocItem** (optional if you already have TOC)
- `BookId`
- `Title`
- `AnchorId` or `BlockIndex`

> MVP flexibility: you can store `Html` per block as sanitized HTML fragments.

### Storage for assets
MVP storage strategy:
- Store assets under a predictable path, e.g.
  - `/data/books/{bookId}/assets/{assetId or normalized filename}`
- Serve via backend: `GET /books/{bookId}/assets/{assetId}`

No CDN required.

### Import pipeline changes
#### Step A — Extract & store assets
- When parsing source (EPUB or “Standard Ebooks master zip” style):
  - Enumerate files under common asset dirs (e.g., `images/`, `src/epub/images/`).
  - Detect mime type.
  - Create `BookAsset` records for each.
  - Copy bytes into storage.

#### Step B — Rewrite `<img src>` references
- While converting chapters to blocks:
  - For every `<img src="...">`, resolve relative path to a canonical `OriginalPath`.
  - Find corresponding `BookAsset`.
  - Replace `src` with your served URL, e.g. `/books/{bookId}/assets/{assetId}`.

#### Step C — Build ordered block flow
- Parse the chapter XHTML/HTML into blocks in reading order.
- Keep anchors/ids for headings and TOC.
- Persist as `BookBlock(Index)`.

> Importer should not chunk by “pages”. Instead, chunk by **semantic blocks**.

### Reader rendering
#### Continuous UX without huge DOM
- Frontend loads blocks incrementally:
  - `GET /books/{bookId}/blocks?from={i}&count={n}`
- Use windowing/virtualization:
  - Render only blocks near viewport.
  - Keep scroll position stable.

#### Navigation
- TOC item click:
  - If `AnchorId` known, the frontend can:
    - request enough blocks around the target index, then scroll to it.

### SEO / prerender
- Prerender endpoint should output **continuous HTML** (for crawlers) by:
  - Rendering all blocks server-side for the requested canonical reading URL.
  - Including `<img src="/books/{bookId}/assets/{assetId}">`.

> For humans: use incremental loading.
> For crawlers: prerender full content.

## API surface (MVP)
- `GET /books/{bookId}/blocks?from={int}&count={int}`
  - returns ordered blocks: `[ { index, type, html, anchorId } ]`
- `GET /books/{bookId}/assets/{assetId}`
  - returns bytes with correct `Content-Type`
- (optional) `GET /books/{bookId}/toc`

## Migration / rollout
- New imports use the new pipeline.
- Existing books:
  - MVP: keep as-is.
  - Follow-up: backfill job to rebuild flow + assets.

## Risks & mitigations
- **Path resolution bugs** (e.g., `../images/...`):
  - Add normalization tests for relative paths.
- **Broken sanitization stripping `<img>`**:
  - Ensure sanitizer allows `img`, `src`, `alt`, `title`, `loading`.
- **Performance regression**:
  - Ensure windowing; avoid rendering entire book DOM for humans.
- **SVG security**:
  - Serve SVG as file; consider sanitizing or restricting scripts (follow-up).

## Acceptance criteria
- Import of an illustrated book preserves inline images and they appear in reader.
- Reader shows continuous scroll (no user-visible pagination).
- TOC navigation works.
- Prerendered HTML includes inline images.

## Metrics (nice-to-have)
- % books with extracted assets.
- # broken image references detected during import.
- Median block fetch latency.

## Next slices (after MVP)
1) Backfill existing library to new flow model.
2) Image optimization (responsive sizes, lazy loading defaults).
3) Illustration detection (decorative separators vs figures).
4) Reader features: highlights, bookmarks, progress sync.
