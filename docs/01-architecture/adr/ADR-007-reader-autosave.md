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
- ADR-006: Reader Position Model (planned)
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
