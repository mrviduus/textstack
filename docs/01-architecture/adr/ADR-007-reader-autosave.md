# ADR-007: Reader Auto-Save Strategy (Readest-style)

## Status
Accepted

## Date
2026-01-19

## Context

The Reader is a core product component of the TextStack platform.
Expected user behavior includes:

- reading without explicit management actions
- automatic restoration of reading position
- no visible “Save” buttons or confirmations

UX analysis of Readest shows that auto-save must be:
- invisible to the user
- resilient to UI changes
- independent of screen size, font, or orientation

This ADR defines an auto-save strategy suitable for:
- MVP implementation
- offline-first usage
- future sync capabilities
- analytics and scalability without UX regressions

---

## Decision

### 1. Core Principle

Auto-save is implemented as a background persistence of a **stable reading position**,
not as a user-triggered action.

The system determines when the current position is stable enough to be saved.

---

### 2. Saved Position Model

The system stores a **logical position in the text**, not visual coordinates.

```text
ReaderPosition {
  book_id
  chapter_id
  paragraph_index
  offset_in_paragraph (optional)
  progress_percent
  updated_at
}
```

The following are explicitly not used:
- scrollY
- page numbers
- viewport-based coordinates

---

### 3. Auto-Save Triggers

Auto-save occurs only when the reading state stabilizes.

#### 3.1 Scroll Idle
- user stops scrolling
- debounce window: 500–800 ms
- position is considered stable

#### 3.2 Time-on-Position
- user remains at the same position for ≥ X seconds
- X = 2–5 seconds (configurable)

#### 3.3 Lifecycle Events
- visibilitychange → hidden
- beforeunload
- app backgrounding (mobile / PWA)

---

### 4. Noise Protection

Auto-save is skipped if:
- position change is below a minimal threshold (±1–2 lines)
- the user scrolls rapidly without pauses
- paragraph_index has not changed logically

---

### 5. Persistence Strategy

#### MVP (offline-first)
- LocalStorage or IndexedDB
- key: reader_state:{book_id}

#### Future (sync-ready)
- local → server persistence
- last-write-wins strategy based on updated_at
- conflict resolution is out of scope for this ADR

---

### 6. Restore Strategy

When opening a book:
1. load the saved ReaderPosition
2. resolve the logical location
3. scroll to the corresponding paragraph and offset

The goal is to restore **reading context**, not an approximate location.

---

## Consequences

### Positive
- UX closely matches Readest behavior
- no explicit user actions required
- stable behavior across UI, fonts, and devices
- sync- and analytics-ready architecture
- low cognitive load

### Negative / Trade-offs
- increased reader-core complexity
- careful debounce tuning required
- harder to debug than explicit save actions

---

## Out of Scope

- visible “Saved” indicators
- cloud synchronization
- reading analytics or streaks
- highlights and notes
- multi-device conflict resolution

---

## Related Decisions
- [ADR-015: The reading position is a place in the text](ADR-015-reader-position-is-logical.md) —
  written 2026-09-07. **This decision was not implemented for eight months.** On 2026-05-17 the
  reader shipped `scroll:<slug>:<pixelOffset>` — the coordinate this document explicitly excludes —
  and sixteen commits since have been repairing the consequences. ADR-015 implements what is written
  above, with one substitution: `paragraph_index` is replaced by a text anchor, because a paragraph
  index survives a font change but not the re-ingestion that recreates every chapter. The acceptance
  criterion "Font changes do not break progress" now has a test.
- [ADR-013: Reader Position Model](ADR-013-reader-position-model.md) — written 2026-08-27, after the position had broken in six distinct ways. This entry said "ADR-006 (planned)" for the whole of that.
- ADR-008: Reading Sessions Tracking (planned)

---

## Acceptance Criteria

- Page reload restores the exact reading position
- Font changes do not break progress
- Mobile and desktop yield identical progress
- Fast scrolling does not persist unstable positions
- The user never notices the auto-save mechanism

---

## Summary

Auto-save is not a UI feature.
It is a foundational trust guarantee between the reader and the platform.

This strategy mirrors the Readest UX approach
while preserving the architectural flexibility required for TextStack.

---

## See also

- **ADR-011** (Mobile Reader — Progress Tracking Architecture, 2026-05-23) —
  builds on this ADR's per-chapter persistence to add book-wide progress
  computation (client-side, no backend changes), Android background-flush
  semantics (`useFlushOnBackground`), and dual-reader hook architecture
  (catalog vs user-book sibling hooks). Apply ADR-011 patterns when
  extending mobile readers; this ADR remains the source of truth for the
  underlying auto-save cadence.
