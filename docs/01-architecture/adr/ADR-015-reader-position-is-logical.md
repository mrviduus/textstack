# ADR-015 — The reading position is a place in the text

**Status:** Accepted · **Date:** 2026-09-07 · **Implements** [ADR-007](ADR-007-reader-autosave.md) ·
**Extends** [ADR-013](ADR-013-reader-position-model.md)

## Context

A reader reached chapter two, closed the app, came back, and was in the middle of chapter one.
Reported at least three times. Patched sixteen.

The mobile reader appends chapters into one document as you scroll; the URL never leaves the
chapter you opened. Typography was an input to that document, so changing a font size rebuilt the
WebView from the **route** chapter, and the restore then re-applied the reader's fraction of the
chapter they were **in**. Measured on the shipped code: 55% of chapter two became 74% of chapter
one, and two seconds later the debounced save wrote it — locally and on the server. A pixel offset
cannot be un-overwritten.

That was the trigger. The cause was older.

[ADR-007](ADR-007-reader-autosave.md), accepted **2026-01-19**, decided:

> The system stores a **logical position in the text**, not visual coordinates.
> `ReaderPosition { book_id, chapter_id, paragraph_index, offset_in_paragraph, progress_percent }`
> The following are explicitly **not** used: **scrollY**, page numbers, viewport-based coordinates.

Its acceptance criteria include **"Font changes do not break progress"**.

On **2026-05-17**, commit `30698d5e` — *"autosave + restore **pixel-accurate** scroll position"* —
introduced `scroll:<slug>:<pixelOffset>`. Everything since has defended pixels. Sixteen commits
across web and mobile, seven of them in six days at the end of August, each fixing a real defect and
each believing a different cause: *never read back → percent too coarse → duplication → async race →
no report on navigation → a DB write race → document vs chapter coordinates → unit ambiguity →
unprompted document rebuild → stale screen read → the row contradicts itself → the writer is
ungated → injection is not arrival → the rule was applied in one place.*

None of them was "the position is stored in pixels". No test anywhere asserted ADR-007's criterion.

## Decision

### 1. A position is a chapter, an anchor, an offset hint and a fraction

```ts
TextPosition {
  v: 1
  chapterSlug: string      // identity — NOT chapterId
  anchor: TextAnchor       // prefix / exact(64) / suffix, 30 chars of context
  charOffset: number       // hint, verified, never trusted
  chapterFraction: number  // coarse fallback + input to computeBookProgress
}
```

`packages/shared/src/reader/textPosition.ts`. Which is to say: **a reading position is a highlight
without a colour**, resolved by the resolver highlights have used since it was written. That
module's own docstring named this case years before it was used for it — *"A highlight, a bookmark
**or a reading position** cannot be stored as a pixel offset or a character index."*

**Not `chapterId`.** Re-ingestion deletes and recreates every chapter (`IngestionService`), so the
Guids change. The slug is regenerated from the title and survives while the title does. ADR-013
reached the same conclusion from the other side: the locator is the position, and everything derived
from a chapter id can lag.

**Not `paragraph_index`, which ADR-007 proposed.** The reason is specific and worth stating, because
"it is unstable" would be wrong: the ordinal index of a `<p>` within a chapter survives a font
change *perfectly* — it is a DOM fact, not a text fact, and it is cheaper than an anchor. What kills
it is re-ingestion regenerating the HTML, and the two clients sanitising it differently. A text
anchor survives both, and one already existed.

### 2. An additive column, not a third locator space

`reading_progresses.position_json`, `user_books.progress_position_json`, both `jsonb NULL`, beside a
`locator` that new clients keep writing in the old `scroll:<slug>:<offset>` form.

`text:<slug>:<charOffset>` was the obvious shape and is a trap. ADR-013 §2 rule 3 — *same space,
accept, declared or not* — is the entire compatibility story for installed builds. Introduce a third
space and the first new client to write it turns every old client's `scroll:` write into an
undeclared cross-space write, refused by rule 5: **a phone that updated would silently stop a
desktop that had not from saving anything.** On the catalog path, which `MayReplace` does not guard
at all, it is worse — the old client's write lands, and the old client cannot parse what it
overwrote, so it resumes at the top of the chapter. That is the defect being fixed, inflicted on
every installed build.

`LocatorSpaceTests` asserts that `Derive("text:…")` is **still null**. The assertion is the point.

### 3. A row never holds two positions that disagree

The whole server-side job, in `Application/ReadingTracking/ReaderPosition.cs`:

- **No position on the write → NULL.** Not "keep what was there". An old build writes the locator
  alone, and its pixel offset is then the only true statement on the row.
- **Accepted locator not in scroll space → NULL.** A PDF's page *is* its logical position;
  mark-as-read has no position at all.
- **Oversized → NULL, and only that.** Unlike a foreign coordinate space, size says nothing about
  whether the rest of the snapshot is trustworthy.
- **A refused write changes nothing**, position included.

No backfill, and none is possible: a pixel offset cannot name text. Positions accumulate as people
read.

### 4. The pixel offset stays, demoted

`locator` is still written, still parsed, still the fallback when an anchor resolves to nothing — an
image-heavy chapter can move text further than any anchor reaches. It is no longer the **source of
truth**. This ADR retires a meaning, not a column.

### 5. Typography is injected, not rebuilt

`readerDocumentKey` no longer contains font size, line height, alignment or the serif/sans family;
they are applied to the live document, as padding and colour already were since #467. What remains a
document input is the OpenDyslexic `@font-face` — 150KB of inlined base64 that is emitted only when
selected, and putting it in every document to save a rare rebuild is the wrong trade.

A live reflow invalidates every recorded chapter top, so `recomputeChapterTops()` is not polish:
without it `currentChapterBounds` names the wrong chapter and `reportProgress` posts that slug —
the same corruption by a different route.

## Consequences

- Position survives a font change, a rotation, a re-parse and a different device. Verified in a
  browser: captured at 62% of a chapter at 18px/1.65/left, restored into a document rebuilt at
  25px/2.0/justified, same paragraph, `scrollY` 5686 → 11951.
- Old builds are unaffected: they read and write the same `locator` in the same space.
- A shared row loses anchor precision while an old device is still writing to it. Bounded, and
  correct — that device really does only know a pixel.
- The read is behind a per-device flag (`textstack.readerTextPosition`); the write never is, so a
  device switched off keeps accumulating positions for when it is switched back.

## Considered and declined: making the route follow the reader

The URL names one chapter while the document may contain several, and that split is where #496,
#500, #501 and the defect above all lived. The obvious fix is to `router.replace` as the reader
crosses a boundary, so the question "which chapter is this?" has one answer.

Declined, for now, on a cost that changed underneath it. `chapterSlug` is the **reset key** of
`useReaderPersistence` — it closes the write gate, clears `restoredRef` and issues a restore — and
it feeds `readerDocumentKey` through the chapter fetch. Making the route follow the reader naively
re-restores the reader backwards at every boundary and rebuilds the document each time. Doing it
properly means splitting one prop into *route chapter* and *reader chapter* across the two most
incident-prone files in the reader.

That was worth it while the position was a pixel, because the disagreement caused **data loss**. It
is not, now that it is an anchor: an anchor names its own chapter, so a position can no longer be
applied to the wrong one — `resolveTextPosition` returns null rather than a plausible-looking place,
and the caller changes route instead. What remains is the URL being cosmetically untrue on a client
with no address bar.

`apps/mobile/src/lib/readerWriteTarget.test.ts` pins the property the surgery would have made
structural: the write path reads the visible chapter, the restore path reads the document's own. If
those assertions start failing, this reasoning no longer holds.

## Enforced by

- `packages/shared/src/reader/textPosition.ts` + `.test.ts` — the model and its resolution ladder
- `apps/mobile/src/lib/readerPositionScript.test.ts` — the shipped WebView functions, run against a
  fake layout, including the regression this ADR is named after
- `apps/mobile/src/lib/readerChrome.test.ts` — typography is absent from the document key
- `apps/mobile/src/lib/readerWriteTarget.test.ts` — the write follows the reader
- `tests/TextStack.UnitTests/UpsertProgressTests.cs`, `UserBookProgressServiceTests.cs` — the
  no-two-disagreeing-positions invariant on both paths
- `tests/TextStack.UnitTests/LocatorSpaceTests.cs` — `text:` is still not a space
- `apps/web/e2e/tests/reader-progress.spec.ts` — ADR-007's acceptance criterion, at last

## See also

- **ADR-007** — decided this in January 2026. This ADR implements it, eight months and sixteen
  commits later, and replaces its `paragraph_index` with a text anchor for the reason in §1.
- **ADR-013** — the coordinate-space rules this had to fit inside, and the reason it is a column.
- **ADR-011** — the mobile progress architecture the position is written through.
