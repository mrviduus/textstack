# ADR-019 — Reader position: shared rules, not a shared state machine

**Status:** Accepted · **Date:** 2026-10-05 · **Extends** [ADR-015](ADR-015-reader-position-is-logical.md),
[ADR-013](ADR-013-reader-position-model.md) · **Related** [ADR-012](ADR-012-pdf-original-first-lazy-parse.md),
[ADR-014](ADR-014-guest-sessions.md) · **Background:** [bug hunt R1/R2](../../changelog-archive/2026-H2.md#2026-10-05-reader-bug-hunt-r1-r2),
R3 #723–#725, [reader-engine-evaluation.md](../reader-engine-evaluation.md) §4.

## Context

About two thirds of the 47 R1–R3 reader findings were restore/save/sync logic, not rendering. Each rule
was written per platform and lives in refs and effects: mobile `useReaderPersistence.ts` has a readiness
reducer, a write-gate reducer, a restore-id ref, `leavingRef`, `sessionJumpRef`, `moveBaselineRef`,
`rebuildTargetRef`. Web has fewer guards than mobile. Web lands a restore in the same rAF as its
`scrollTo`, so it has no "issued but not landed" window. `MAX_CLIENT_SKEW_MS` was only in mobile
(`progressRestore.ts`) until #724 added a copy in shared `progressPrecedence.ts`.

Live bugs the ADR-019 review found:

- **Web:** a PDF saves page 1 before the resume jump (no provenance gate). The progress GETs have no
  timeout: if the GET hangs, nothing is restored or saved. `wordsRead` ≈ 0. A stale tab overwrites
  another device's position. One progress GET is sent twice.
- **Mobile:** a rebuild during a restore restores to the top and saves 0. Settings load async, so this
  hits every open with non-default typography. A known PDF chapter start page drops the device page.
  The foreground newer-check is skipped after the OS kills the renderer in the background.

## Decision

**Lift and adopt.** Pure helpers live in `packages/shared/src/reader/`, one home each. Hosts keep the
rest. No single cross-platform reducer.

| Shared module | Contents |
|---|---|
| `newerPosition.ts` (from mobile `progressRestore.ts`) | `serverProvablyNewer`, `decideNewerPosition`, `readerMovedSince`, `trustedLocalStamp` |
| `progressPrecedence.ts` | `localProgressWins`; the only `MAX_CLIENT_SKEW_MS` |
| `pdfPersistGate.ts` | as is; web adopts it |
| `restoreGate.ts` (later, only if needed) | mobile `readinessReduce` + `restoreGateReduce`, merged |

Hosts keep save timing (debounce, flush), I/O, holds (`?highlight=`), toasts, snapshots, capture and
navigation. Web adopts the shared helpers. Mobile keeps its hooks and only re-points imports.

### Rules

Each rule names its bug and the test that pins it. New scenarios from the review go into these
existing files as rows, not into a new test framework.

| # | Rule | Bug | Pinned by |
|---|---|---|---|
| 1 | **Per-doc key from the route**, never from the resolved id. The book id arriving for the same doc does not reset "doc loaded". | Mobile C1 | `restoreReadiness.test.ts` |
| 2 | **Restore only when doc ready AND target loaded**, whichever is last, once per doc. The doc must be the requested chapter. | Mobile C1, web C2 | `restoreReadiness.test.ts`, `useReaderScrollSync.test.ts` (`isChapterReady`) |
| 3 | **Land on the ack**, or positionally only from the first open (non-zero scroll, PDF ±1 page), or on a 4 s deadline. A stale restore id lands nothing. | Back in 1 s → 0.66 %; jump pages saved; page 1 saved | `readerWriteGate.test.ts`, `pdfPersistGate.test.ts` |
| 4 | **A pending save belongs to the doc it was captured in.** On a chapter change, flush it for the old doc. On an owner/layout switch (PDF ↔ reflow), drop it. | Web C1; mobile H1, PDF 14 % → 4 % | `useReaderScrollSync.test.ts`, `readerWriteMode.test.ts` |
| 5 | **Server data enters only as a newer-check** after the open: client stamps only, local clamped to now + 5 min; adopt before the restore, move if the reader has not moved, otherwise ask. Never yank a reader who moved. | #695, #710, L5, R3 L1, mobile C2/H3 | `progressRestore.test.ts`, `progressRestoreOrder.test.ts`, `progressPrecedence.test.ts`, `positionHandoff.test.ts` |
| 6 | **Every wait has a deadline.** Restore/jump 4 s, `?highlight=` hold 5 s, progress GET 3 s. The reading path never waits on a token or the network (ADR-014: no auth input). | Captive portal; web hung GET | `readerSessionGate.test.ts`; web GET timeout test (R4) |
| 7 | **A programmatic move is not reading** (restore, newer move, rebuild, reflow, jump). | M8; web `wordsRead` ≈ 0 | `sessionMath.test.ts` |
| 8 | **A rebuild or reflow during a restore keeps the pending target.** It does not snapshot the half-restored view. | Mobile: rebuild mid-restore saves 0 | `rebuildRestore.test.ts` (row added in R4) |

## Plan

1. **R4 web PR:** fix the live web bugs. Move the helpers to shared, with one `MAX_CLIENT_SKEW_MS`.
   Web adopts `pdfPersistGate` and the newer-check. Each fix is tests-first.
2. **R4 mobile PR:** fix the live mobile bugs (rule 8, the PDF start page, the foreground check after a
   renderer kill). Re-point imports to shared. JS-only, OTA.
3. **Later, only if a new bug lands in the gap between refs:** merge `readinessReduce` +
   `restoreGateReduce` into shared `restoreGate.ts` (mobile first).

## Alternatives rejected

- **One full cross-platform state machine** (the first draft of this ADR). The review found blockers.
  A "behaviour-preserving" rewrite would have brought R1 Criticals back:
  - `off` when there is no book key, then a doc reset, brings back C1.
  - `canPersist` read at fire time breaks web C1 or mobile H1.
  - Positional landing from any restore brings back the jump-saved bug.
  - The transitions were not total: a rebuild or reflow can arrive while opening or restoring.

  Moving mobile from React state to a ref changes which report gets saved, when the baseline is set, and
  how stale acks behave. Web gains little, because it lands in the same rAF. And a big reducer would fix
  today's renderer shapes against a future engine's `Locator` / `goTo()`.
- **XState.** A new dependency in two bundles, timers hidden from tests, and the same lock-in.
- **Reader engine first.** By the evaluation's own count it removes about a third of the findings;
  these rules are needed whatever engine we pick.
- **Status quo.** Web keeps missing guards that mobile has; the same bug is fixed twice, weeks apart.

## Consequences

- Smaller change: helpers move and web catches up. No rewrite of code that took 47 fixes.
- The state stays spread over refs on mobile. That is accepted until a bug proves the gap (plan step 3).
- Each rule has one home and one pinning test; a new rule adds a row, not a framework.

### Consilium (2026-10-05)

Four reviewers looked at the first draft (a full state machine):

- **Simplicity critic: reject.** The helpers already exist, and most of the value is web catching up.
- **Adversarial QA: blockers.** C1 comes back; the fire-time gate fails; positional landing is too
  wide; transitions are not total.
- **Mobile: blocker.** M1 is not behaviour-preserving (ref vs state, baseline, stale acks).
- **Web: low gain** from W1 (same-rAF landing). The real value is the live web bugs.

The lead (owner-delegated) chose lift and adopt.

## Open questions (owner)

1. A TOC jump to another chapter, then a newer same-chapter position from another device arrives
   before you scroll: mobile moves you silently today. Keep that, or ask first?
2. Should web get the "read further on another device" toast later?
