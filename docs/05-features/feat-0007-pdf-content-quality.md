# PDF Content Quality — Claude-assisted cleanup + heuristic ratchet

Make PDF-extracted books actually readable. PdfPig + heuristics get us to
~70-75%; the gap to ~90% is semantic (running headers in body, fragmented
paragraphs, hyphenation, footnotes mixed in). Close it with a gated Claude
cleanup pass — and feed what Claude does back into deterministic rules so the
heuristics keep getting better and the Claude dependency keeps shrinking.

**Status** (checked 2026-10-04): slices 1-4 shipped in #235 — `ContentQualityScore` on `Chapter`/`UserChapter`, Phase 3 in `infra/scripts/quality-poll.sh`, gate `infra/scripts/pdf-cleanup-gate.py`. Phase 3 is **off by default** (`CONTENT_CLEANUP_ENABLED=false` in `.env.example`). Since ADR-012 an uploaded PDF renders as the original document, so this cleanup now matters only for the reflow fallback and catalog PDFs.
**Author**: Vasyl Vdovychenko + Claude
**Started**: 2026-05-22

---

## Why

PDF is the hard format. EPUB carries publisher semantics (`<h2>`, `<p>`,
lists) → our extractors already produce ~90%. PDF carries only glyphs +
geometry; structure must be reconstructed.

Observed on a real upload (*AI Engineering*, Chip Huyen, 535 pp.) after the
round-1 heuristic fix (`feat`/Option A):

```
<p>Chapter 1: Introduction… | 4</p>   running header leaked into body
<p>about</p><p>new</p><p>chal‐</p>    fragmented — one word per <p>
"mod‐ els", "appli‐ cation"           line-wrap hyphens not merged
"1 In this book, I use…"              footnote inline, unlinked
```

These are **semantic** judgements ("is this line chrome or content?") that
pure geometry heuristics handle poorly. An LLM handles them well.

### Why not Marker

Evaluated and shelved (`shelf/marker-integration`). Marker (Surya ML pipeline)
needs ~3.6 GB VRAM for its model set; the prod GTX 1650 Ti has 4 GB → CUDA OOM.
CPU mode works but ~1.5 h/book. It is also an 11 GB image + fragile CUDA/torch
deps — a general-purpose document-AI tool, overweight for our narrow case
(digital book PDFs → readable prose).

### Why this approach

- **Reuses what exists.** `quality-poll.sh` already runs Claude CLI via a
  systemd poller; `BookQualityJob` already enqueues post-ingestion; internal
  chapter GET/PUT endpoints already read/write chapter HTML. The new work is
  one phase in one script + one analyzer + tracking fields.
- **Claude via the Max subscription** — `$0` marginal, no API key.
- **Self-improving.** Every Claude (messy → clean) pair is logged. Recurring
  fixes get distilled into deterministic processors in the existing
  `Spelling → Hyphenation → Typography → Semantic → Linter` chain. Heuristics
  ratchet up; Claude is called less over time.

---

## Architecture

```
┌─ Ingestion — Worker (container) ───────────────────────────┐
│  PdfPig extract                                            │
│  → processor chain: Spelling→Hyphenation→Typography→        │
│       Semantic→Linter      ◄── heuristic ratchet lands here │
│  → ChapterContentQualityAnalyzer → per-chapter score 0-100  │
│  → enqueue BookQualityJob (records flagged chapters)        │
└────────────────────────────────────────────────────────────┘
                          │  DB
┌─ quality-poll.sh — systemd (host) ─────────────────────────┐
│  Phase 1  validate chapter structure        (exists)        │
│  Phase 2  fix structure: delete/rename/merge (exists)       │
│  Phase 3  CONTENT CLEANUP                    (NEW)          │
│    for each flagged PDF chapter:                            │
│      GET /internal/.../chapters/{n}/content   (messy HTML)  │
│      → claude -p  (cleanup prompt, preserve verbatim)       │
│      → preservation gate (word-set diff; reject drift)      │
│      → PUT /internal/.../chapters/{n}  {html}               │
│      → append (in,out) pair to dataset log                  │
└────────────────────────────────────────────────────────────┘
                          │
        data/pdf-cleanup-dataset/*.json   (messy→clean pairs)
                          │
   periodic (manual): study pairs → encode recurring fixes as
   Semantic/Linter processors  ──► ratchet back into the chain
```

### Components

| Component | State | Responsibility |
|---|---|---|
| `ChapterContentQualityAnalyzer` | new | Deterministic 0-100 content score + issue list per chapter. Pure C#, no LLM. The **gate** — only low-scoring PDF chapters reach Claude. |
| `BookQualityJob` | extend | + content-phase tracking fields (chapters cleaned / rejected / skipped). |
| `UserChapter` / `Chapter` | extend | + `ContentQualityScore` column. |
| `quality-poll.sh` | extend | + Phase 3 content cleanup. |
| Internal chapter endpoints | reuse | `GET …/content`, `PUT …` already read/write HTML + recompute plainText. |
| `data/pdf-cleanup-dataset/` | new | Append-only (messy → clean) pair log — the ratchet's fuel. |
| Processor chain | reuse | Destination for distilled deterministic rules. |

### Key design decisions

1. **HTML-cleanup, not geometry-classifier.** Claude rewrites the chapter HTML
   rather than labelling geometry lines. Reason: the geometry path needs heavy
   plumbing (capture/persist X-Y, new endpoints) for a zero-hallucination
   guarantee that the **preservation gate** delivers deterministically and
   nearly for free. We lose geometry signal, but text patterns ("`Chapter 1:…
   | 4`" repeats" → header) are enough for digital PDFs.

2. **Preservation gate** — the anti-hallucination guard. Strip whitespace **and
   hyphens** from original + cleaned plaintext, tokenize, compare multisets:
   - cleaned introduces tokens absent from original → **reject** (hallucination)
   - cleaned drops > N% of original tokens → **reject** (over-deletion)
   - else → accept.
   Hyphen-stripping is load-bearing: a legit `chal‐ lenges → challenges` merge
   must not look like a hallucinated new word.

3. **One job, one poller.** Content cleanup is Phase 3 of the existing
   `BookQualityJob` / `quality-poll.sh`, not a parallel system. Phase 3 runs
   after Phase 1-2 (structure fixes renumber chapters).

4. **PDF-only.** EPUB already carries semantics. Phase 3 skips non-PDF books
   by source-format check.

5. **Gated.** Only chapters the analyzer scores below threshold get a Claude
   call. Clean books cost `$0` and add no latency.

6. **Per-chapter Claude calls within a per-book job.** Smaller input/output,
   per-chapter preservation gate, partial success. The *job* is per-book.

### Feature flag & rollback

- Config flag `Quality:ContentCleanupEnabled` (default off). Phase 3 is a no-op
  when off.
- Rollback: flip the flag off, or drop Phase 3 from the script and redeploy.
  Phases 1-2 unaffected; chapters keep their last-good HTML.

---

## Slices

Each slice is independently shippable and testable. Branch
`feat/pdf-content-quality`; one commit/PR per slice.

### Slice 1 — Content-quality analyzer  ·  ~1 day  ·  no infra, no LLM

`ChapterContentQualityAnalyzer` — pure C#. Input: chapter HTML. Output:
score 0-100 + issues (`FragmentedParagraphs`, `RunningHeaderInBody`,
`HyphenationArtifacts`, `OrphanPageNumbers`, `SuspectedFootnotes`).

- Detectors are deterministic heuristics over the HTML/text.
- Fully unit-tested against known-bad and known-clean fixtures.
- **Acceptance**: bad chapter → low score + correct issue codes; clean
  chapter → high score. No DB, no network.
- **Ships value alone**: enables a "may have formatting issues" signal.

### Slice 2 — Detection wiring + schema  ·  ~1 day

- Migration: `ContentQualityScore int?` on `UserChapter` + `Chapter`.
- Worker runs the analyzer after ingestion, persists per-chapter score.
- `BookQualityJob` + content-phase fields (`ContentChaptersCleaned`,
  `ContentChaptersRejected`, `ContentChaptersSkipped`).
- **Acceptance**: upload a bad PDF → flagged chapters carry a low score in DB;
  clean PDF → high scores. Integration-tested.

### Slice 3 — Claude cleanup phase  ·  ~1.5 days  ·  the core

- `quality-poll.sh` Phase 3: loop flagged PDF chapters → GET content →
  `claude -p` cleanup prompt → preservation gate → PUT back.
- Cleanup prompt: fix structure, drop running headers/page numbers, merge
  hyphenation, rejoin fragments — **preserve every word and all code verbatim**.
- Preservation gate (inline python) — see design decision 2.
- Pair logging → `data/pdf-cleanup-dataset/{bookId}-{chapter}.json`.
- Behind `Quality:ContentCleanupEnabled`.
- **Acceptance**: bad chapter → readable HTML, content preserved; injected
  hallucination → gate rejects, original kept; pair file written.

### Slice 4 — Observability & admin  ·  ~0.5 day

- Admin `BookQualityJob` view surfaces Phase 3 results (cleaned / rejected /
  skipped counts, per-chapter).
- Worker logs score distribution per book.
- **Acceptance**: admin can see what Phase 3 did and why anything was rejected.

### Slice 5 — Heuristic ratchet, round 1  ·  ~1 day  ·  ongoing thereafter

- Study accumulated pairs (Claude-assisted meta-analysis: "what recurring
  fix-patterns appear? propose deterministic rules").
- Encode the rule-expressible ~70-80% as `Semantic`/`Linter` processors in the
  extraction chain (`RULES.md`).
- **Acceptance**: re-running affected fixtures, the new processors fix them
  with no Claude call; analyzer score rises; fewer chapters flagged.
- Repeat as a standing maintenance ritual — Claude usage trends down.

**Total to first useful state (Slices 1-3): ~3.5 days. Full: ~5 days.**

---

## Sequencing & dependencies

```
Slice 1 ─► Slice 2 ─► Slice 3 ─► Slice 4
                          └─────► Slice 5 (needs pairs from Slice 3)
```

Slices 1-2 are pure backend, zero risk, deployable behind the disabled flag.
Slice 3 is the only one touching the host poller + Claude. Slice 5 is recurring.

## Risks

| Risk | Mitigation |
|---|---|
| Claude hallucinates / drops content | Preservation gate rejects; original kept. |
| Gate false-rejects legit hyphen merges | Strip hyphens + whitespace before diffing. |
| Claude mangles code blocks | Prompt: "preserve code verbatim"; gate catches token drift. |
| Heavily-flagged book = many Claude calls | Per-book ≈ 5-15 min typical, ~30-45 min worst case. Async job — acceptable. Ratchet shrinks it over time. |
| Poller script grows large | Phase 3 reuses existing helpers; preservation gate is one python block. Acceptable; revisit if it crosses ~600 lines. |

## Performance

- Clean book: ~10-30 s (heuristics only, no Claude) — unchanged.
- Lightly-flagged book (2-4 chapters): ~5-15 min async.
- Heavily-flagged book: ~30-45 min async. Still far below Marker's ~1.5 h, and
  it trends down as the ratchet absorbs recurring fixes.

## Ratchet log

Each round documents what was learned from the accumulated `(messy → cleaned)`
pairs, which fixes were encoded as deterministic processors, and what stays
with the LLM and why.

### Round 1 — 2026-05-23 (2 pairs: AI Engineering ch5 + ch1 Cover)

**Encoded as code:**
- **O'Reilly-style running headers** with a varying page number —
  `<p><strong>N | Chapter X: Title</strong></p>` and
  `<p><strong>Title | N</strong></p>`. The cross-page identical-text filter
  couldn't catch them (page number changes per page), but the structural
  signature is distinctive. Added a regex to `PdfPageTextExtractor.IsArtifactNoise`.
  Immediate measurable effect: AI Engineering content chapters went from
  scoring ~65 to ~90 on re-upload.

**Prompt adjustment (not a deterministic rule, but tightened guidance):**
- **Preserve typography verbatim** — Claude was normalizing smart quotes,
  typographic apostrophes, em/en-dashes to ASCII. Added an explicit rule
  to the Phase 3 prompt covering smart quotes, apostrophes, dashes,
  ellipses. The preservation gate doesn't catch these (it compares word
  tokens), so prompt is the only enforcement.

**Left to Claude — too hard to do deterministically:**
- **2-column de-interleaving.** The ch1 Cover pair had a bullet list (left
  column) interleaved line-by-line with the author bio (right column) —
  PdfPig grouped them into one Y-sorted run. Claude separated them
  correctly. We intentionally dropped `RecursiveXYCut` in Option A because
  it fragmented sparse layouts; bringing back selective column detection is
  significant work for a corner case. Stays in the LLM column.
- **Inline section heading extraction.** Body text occasionally absorbs a
  section heading because the heading sits on the same Y-band as the next
  line — needs semantic judgement to lift it out as `<h3>`. Defer.

### How to run the next round

1. Wait until `data/pdf-cleanup-dataset/` has ~5+ pairs from real uploads
   covering ≥2 distinct books.
2. Run the inspection script (Python, stdlib) on each pair: block-level
   diff after smart-quote normalization → list of `truly removed` and
   `truly modified` blocks. Look for shapes that repeat across pairs.
3. For each recurring shape: encode as a regex/heuristic in the appropriate
   processor (`PdfPageTextExtractor.IsArtifactNoise` for per-paragraph
   noise, `PdfTextExtractor.FilterRunningHeaders` for cross-page, new
   Semantic/Linter processors for structural transforms).
4. Add unit tests with positive (matches the pattern) and negative (prose
   that superficially looks similar) cases.
5. Note in this log: what was encoded, why; what stays with the LLM, why.

## Open questions

- Threshold score for flagging a chapter — start ~60, tune on real books?
- Editions (admin catalog) too, or user-books first? Endpoints exist for both.
- Cleanup granularity if a chapter is huge (>30k words) — chunk, or rely on
  Claude's context window?
- Pair-log retention — keep all, or cap at N most-recent per book?
