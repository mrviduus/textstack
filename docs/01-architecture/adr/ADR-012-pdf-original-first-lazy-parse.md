# ADR-012: PDF books — original-first display, parsing decoupled & lazy for AI

## Status
> **Partly obsolete since 2026-09-10.** The original-first display and instant-readable upload (§1–2) are in force. Everything about "Ask this book", vision-LLM → Markdown parsing, chunks and RAG with page citations (the RAG row of §3, all of §4, S3, S5b) was deleted with the in-app chat and RAG spine (MCP replaced it; leftovers removed in #665, 2026-10-01). Read those parts as history.

Accepted — shipped 2026-07-10. S1 #419, S2 #420, S3 #421 (+ eval gate #422),
S4 (mobile) #424, S5a #426. S5b (figure-caption RAG) deferred behind a real
"what's on the diagram" miss signal.

## Date
2026-07-10

## Context

TextStack's reader has always **reflowed** uploaded books: the extraction
pipeline pulls the text out of a PDF and rebuilds clean HTML that powers the
learning engine (TTS, resize, dark mode, vocabulary, translate). For prose
that's great. For **style-heavy PDFs** — a table-heavy medical OSCE workbook
was the trigger — reflow is *unreadable*: tables collapse into run-on prose
("FINDINGS • Fungal – common after…"), colored section pills and red keywords
vanish, reading order jumbles. The customer's verdict: the reflow version is
not usable; the original PDF is "the only working version."

Two things changed the calculus:

1. **ADR-012's predecessor (#416)** shipped an opt-in **"Original layout"**:
   the real PDF rendered pixel-perfect via PDF.js (page `<canvas>` + a
   transparent, selectable text layer). Selection actions — translate /
   explain / add-to-vocabulary / TTS / copy — work unchanged over the text
   layer because it's real DOM.

2. **Rendering the original PDF needs only the stored file** — no extraction.
   PDF.js reads the uploaded bytes directly. Extraction is therefore no longer
   a prerequisite to *read*; it only feeds the *invisible* consumers: the
   "Ask this book" RAG chat, in-book search, chapter navigation (TOC + jump),
   and word-count/progress.

This ADR records the decision to make original-PDF the primary experience and
to re-scope extraction accordingly.

## Decision

### 1. For user-uploaded **PDFs**, the original PDF (PDF.js) is the ONLY display mode
The reflow *view* and its toggle are removed for PDFs. Reflow rendering is
retained for **EPUB** (reflowable by nature — nothing to show "as-is") and the
**admin catalog**, and as an automatic fallback if a PDF fails to open.

### 2. "Readable" is decoupled from "parsed" — PDFs are readable instantly
On upload we store the file, create the book, and open it in the reader
immediately (PDF.js on the stored bytes). The blocking `Processing…` wait
before reading is gone for PDFs. Extraction moves to background/lazy work and
gets its own status (e.g. `indexing`), surfaced only as a quiet badge, never a
gate on reading.

### 3. Extraction is re-scoped to serve the invisible consumers, on the cheapest schedule
| Artifact | Purpose | When produced |
|----------|---------|---------------|
| Stored PDF file | reading | at upload (already) |
| Light chapter detection (titles + physical page ranges) | TOC + jump-to-chapter | **background**, seconds after upload |
| Full-text (FTS) | in-book search | background / lazy |
| **RAG chunks (from vision-parsed Markdown)** | "Ask this book" | **lazy, on first chat** (on-demand per-book RAG already exists) |
| Word count | progress % | **dropped for PDFs** — progress is page-based |
| Inline image extraction | (was: reflow display) | **dropped** — the PDF renders its own images; keep cover only |

### 4. RAG text quality follows document-AI best practice: vision-LLM → Markdown
Deterministic text extraction linearizes tables into incoherent runs — exactly
the content the target books are made of. Industry consensus for PDF→RAG is a
**vision model → structured Markdown** parse (LlamaParse / Reducto / direct
GPT-4.1 vision), because LLMs reason far better over Markdown tables/headings
than jumbled prose. Because parsing is now lazy and non-blocking, we can afford
it. Concretely:
- Render pages → `gpt-4.1` vision → clean Markdown (tables as Markdown tables).
- **Structure-aware chunking**: split on headings, never split a table
  mid-row, attach the section path ("2. Orbit › Infectious › Preseptal
  Cellulitis") **and the physical page number** to each chunk.
- Keep **hybrid retrieval** (FTS + embedding RRF, already present).
- **Page provenance closes the loop**: a chat answer cites "see p. 17" and,
  because we now show the real PDF, that citation **jumps into the viewer at
  page 17**. This synergy is the payoff of doing original-display + vision-RAG
  together.

Deterministic extraction stays for the cheap structural needs (chapter
titles + page ranges, FTS) — no `.NET`→Python dependency (rules out
Docling/Marker/Unstructured); vision is a language-agnostic OpenAI call that
fits our stack.

### 5. Both platforms — mobile is in scope, not deferred
The mobile reader is already a `react-native-webview` that injects chapter HTML
+ a selection→native bridge. **PDF.js runs in a WebView**, so mobile "Original"
is the *same* viewer loaded into the existing WebView, reusing the existing
selection bridge — feasible, just unbuilt in the web-only #416 slice. Mobile is
a first-class slice (Android-first, per ADR-011 priority). If PDF.js proves too
heavy on low-end Android for a 21 MB / 100-page doc, the fallback is a native
PDF renderer (`react-native-pdf`) with a text-selection bridge; PDF.js-in-WebView
is preferred first for one code path + the existing selection pipeline.

## Consequences

**Positive**
- Instant reading — no `Processing…` wait for PDFs.
- Faithful display (tables/colors/pills) — the actual customer complaint solved.
- Better chat answers on structured docs (Markdown RAG) + citations that jump
  to the real page.
- Extraction simplifies: no reflow-HTML/typography/paragraph reconstruction, no
  inline-image compositing for PDFs.
- Cost-controlled: vision parse is lazy + cached + only for books actually chatted.

**Negative / risks**
- **Two flows**: PDFs are original-first + instant; EPUB and (until the mobile
  slice ships) mobile keep parse-then-reflow. More conditional paths.
- **Failure surfaces at display**: a corrupt/non-PDF file is now discovered when
  PDF.js fails to open, not during extraction → needs a graceful reader error +
  reflow/text fallback.
- **Progress model split**: PDF progress is page-based (localStorage); library %
  for PDFs becomes page-based instead of word-based — must not corrupt the
  shared `ProgressPercent` semantics (see the R6 progress work).
- **Two text sources**: on-page selection uses PDF.js's own text layer; chat/
  search use our extracted text. They can differ (PDF.js order vs vision
  Markdown). Acceptable — different jobs.
- **Vision cost/latency** per page; mitigated by lazy + cache + page-cap.

## Alternatives considered
- **Keep reflow as default / improve it** — rejected: reflow is structurally
  unreadable for the target table-heavy books; no amount of deterministic
  tuning fixes PDF tables reliably.
- **Deterministic layout parser (Docling/Marker/Unstructured)** — rejected:
  Python-only; TextStack is .NET-only (no Python, per the distillation ADR).
- **Parse-on-upload, blocking** (status quo) — rejected: makes the user wait for
  work that the original-PDF display doesn't need.
- **Server-render page images for mobile** — rejected as primary: loses
  selectable text (kills translate/vocab). Kept only as a last-resort fallback.

## Rollout — slices

Small, shippable PRs (bundle sub-steps per repo convention).

- **S1 — Original-only + instant read (web).** For user PDFs: render Original by
  default, remove the reflow toggle/view; open the reader immediately after
  upload (decouple readable from parsed); graceful fallback if the PDF won't
  open. Backend: split book status into `readable` vs `indexing`; upload returns
  readable-now.
- **S2 — Background light chapter detection.** Worker does fast chapter
  detection (titles + `SourceStartPage/EndPage`, already threaded in #416) as a
  background job → TOC + jump-to-chapter appear async. Library % for PDFs →
  page-based. FTS text produced here too (enables search).
- **S3 — Vision-RAG with page provenance.** On first "Ask this book", vision-parse
  the pages → Markdown → structure-aware chunks carrying section-path + page
  number; index (hybrid). Chat answers cite pages; citation → jump-to-page in the
  Original viewer. Cache per book.
- **S4 — Mobile Original.** Load the PDF.js viewer into the mobile WebView, wire
  the existing selection→native bridge; instant-read + Original-only for mobile
  PDFs (Android-first). Perf-gate: fall back to `react-native-pdf` if PDF.js is
  too heavy on low-end Android.
- **S5 — Cleanup / deferred.** Drop inline-image extraction for PDFs (keep cover);
  optional multimodal RAG for figures (ColPali-style / vision figure captions)
  so "what's on the diagram" works.

## Cost stance (decided 2026-07-10)
Vision parse uses **`gpt-4.1`**. At current scale (<5 active users) cost is
**not a constraint** — a 100-page book is ~$1–1.5 of vision, lazy + cached, so
we pay roughly once per book that's actually chatted. The cost optimizations
below are **deferred until scale**, not built now:
- cheaper tier (`gpt-4.1-mini`) for the parse,
- retrieved-pages-only vision at answer time (vs whole-book parse),
- Batch API (−50%) for background cache fill,
- per-feature daily USD budget guard (mechanism already exists).

S3 therefore ships the simplest correct thing: on first "Ask this book",
vision-parse with `gpt-4.1` → Markdown → chunk (section + page) → index; cache
per book. Revisit the optimizations when users/usage grow.

## Open questions
1. ~~S3 vision model / budget~~ — **resolved: `gpt-4.1`, cost non-critical at
   current scale; optimizations deferred (see Cost stance).**
2. Do we precompute S2 chapter detection eagerly on upload (a few seconds) so the
   TOC is always there, or fully lazy on first TOC open?
3. EPUB: leave as parse-then-reflow (this ADR is PDF-only), or eventually give
   EPUB an "original" via an epub.js fixed-layout path? (out of scope here.)
4. Corrupt-PDF UX: reader error + "open as text (reflow)" fallback, or hard error?

## References
- ADR-011 (mobile reader progress) — mobile WebView + Android-first priority.
- #416 — the Original-layout PDF viewer this ADR builds on.
- Anthropic, *Contextual Retrieval* (2024) — chunk-context-before-embedding.
- Document-AI parsers: LlamaParse, Reducto, Docling, Marker, Azure Document
  Intelligence (surveyed; vision-LLM chosen for the .NET/on-demand fit).
