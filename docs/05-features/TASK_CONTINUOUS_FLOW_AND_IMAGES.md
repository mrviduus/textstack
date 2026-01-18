# TASK: Continuous Reading Flow + Image Ingestion (MVP)

**Goal**
Implement an MVP that (1) ingests and serves in-book images and (2) renders book content as a continuous scroll (one logical “canvas”), without generating thousands of paginated pages.

---

## Scope (DO)
### Import / Ingestion
1) **Extract assets** from imported book sources
   - Detect and persist images (JPG/PNG/SVG/WebP) found in typical dirs:
     - `images/`
     - `src/epub/images/`
     - (and any paths referenced by `<img>`)
   - Store bytes in filesystem/object storage using a stable naming scheme.
   - Create DB records (or equivalent) for `BookAsset`:
     - `BookId`, `Kind`, `OriginalPath`, `StoragePath`, `ContentType`, `ByteSize`

2) **Rewrite `<img src>` references**
   - When parsing HTML/XHTML:
     - Resolve relative `src` paths.
     - Map to `BookAsset`.
     - Replace `src` with a served URL: `/books/{bookId}/assets/{assetId}`

3) **Build Book Content Flow**
   - Convert book content to ordered blocks (`BookBlock`):
     - Preserve order
     - Keep anchors for headings/TOC
     - Store sanitized HTML fragment per block

### Backend APIs
4) Implement:
   - `GET /books/{bookId}/blocks?from={int}&count={int}` → returns ordered blocks
   - `GET /books/{bookId}/assets/{assetId}` → streams the stored asset with correct `Content-Type`
   - (if needed) `GET /books/{bookId}/toc` → anchor or block index mapping

### Frontend reader
5) Update reader to show **continuous scrolling**
   - Load blocks incrementally (windowed / virtualized)
   - No user-visible pagination
   - Preserve basic navigation:
     - TOC click jumps to target anchor/block

### Prerender
6) Ensure prerender output contains inline images
   - Prerendered HTML should include `<img>` tags with the rewritten served URLs

---

## Scope (DO NOT)
- Do **not** implement image optimization/resizing/CDN.
- Do **not** build illustration classification.
- Do **not** add annotations/highlights/bookmarks.
- Do **not** convert the entire book into one giant HTML file for human readers.

---

## Implementation slices (mergeable)

### Slice 1 — Asset model + serving endpoint
- Add `BookAsset` storage + DB.
- Implement `GET /books/{bookId}/assets/{assetId}`.

### Slice 2 — Importer: extract images + rewrite `<img src>`
- During import:
  - Detect and store images as `BookAsset`
  - Rewrite `<img src>`

### Slice 3 — Content flow blocks (backend)
- Add `BookBlock` model.
- Importer produces ordered blocks.
- Implement `GET /books/{bookId}/blocks`.

### Slice 4 — Reader continuous scroll (frontend)
- Render blocks in one continuous view.
- Add windowing/virtualization to prevent huge DOM.

### Slice 5 — Prerender integration
- Prerender produces a continuous HTML snapshot including images.

---

## Test plan (TDD)

### Unit tests
1) **Path normalization**
- Inputs:
  - `images/fig01.jpg`
  - `../images/fig01.jpg`
  - `./images/fig01.jpg`
- Expected:
  - canonical `OriginalPath` matches stored asset key

2) **HTML rewrite**
- Given HTML with `<img src="../images/a.png">`
- After processing: `<img src="/books/{bookId}/assets/{assetId}">`

3) **Sanitizer allowlist**
- Ensure `img` tag is not stripped
- Ensure `src`, `alt`, `title` attributes survive

### Integration tests
4) **Import illustrated book fixture**
- Use an example that contains inline images (e.g., `charles-a-lindbergh_we-master.zip`).
- Assert:
  - `BookAsset` created for each referenced image
  - `BookBlock` HTML references served URLs
  - Asset endpoint returns 200 with correct `Content-Type`

5) **Reader smoke test**
- Load a book and scroll; verify blocks load incrementally.
- Verify at least one inline image is visible and loads.

6) **Prerender snapshot**
- Fetch prerendered HTML for book reading URL.
- Assert:
  - contains `<img src="/books/{bookId}/assets/` ...

---

## Acceptance criteria
- Importing an illustrated book results in:
  - stored assets
  - rewritten image URLs
  - images visible inline in the reader
- Reader is continuous-scroll (no pagination UI).
- TOC navigation works.
- Prerendered HTML contains inline images.

---

## Notes / guardrails
- Prefer deterministic storage paths to enable caching and easy debugging.
- Log a warning for any `<img>` whose `src` cannot be resolved to an asset.
- Keep payload sizes bounded: blocks API should support paging.
