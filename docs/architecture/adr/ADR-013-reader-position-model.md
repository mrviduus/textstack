# ADR-013 — Reader position model

**Status:** Accepted · **Date:** 2026-08-27 · **Supersedes the placeholder** referenced by
[ADR-007](ADR-007-reader-autosave.md) as "ADR-006: Reader Position Model (planned)".

This records what shipped. It is not a proposal — the rules below are enforced in code and by
tests, and this document exists because they are a contract that three clients and every future
reader must obey, and a rule buried in a method comment is a rule the next person will not find.

## Context

A book's reading position lives in one row and one column: `user_books.progress_locator` for
uploads, `reading_progresses.locator` for catalog editions. Two readers write it and they do not
share coordinates.

| Space | Written by | Shape |
|---|---|---|
| `scroll` | the reflow reader (EPUB, and a PDF read as text) | `scroll:<chapterSlug>:<offset>` |
| `page` | the Original-layout PDF viewer (ADR-012) | `page:<n>` |

Nothing said which one owned a given book. On 2026-08-27 a manual pass found the consequence: a
reader opened an uploaded PDF, read to page 16, closed the reader, came back and closed it again.
The server then held `scroll:2-the-mom-test:0` at 4% instead of `page:16` at 14%, and the book
reopened ten pages early. The reflow path's close-flush fires on every reader close regardless of
what is on screen, and in Original layout the refs it reads have never been written — so it wrote
"top of the chapter named in the URL", and `0.038` is `words(chapter 1) / total` for a chapter the
reader never opened.

This is the fourth time one field has been written by more than one producer with no owner. The
percentage was the third ([#468](https://github.com/mrviduus/textstack/pull/468)).

## Decision

### 1. Two spaces, not ordered

`page` and `scroll` are peers. There is deliberately **no** `chapter` space: `chapter:<slug>` is a
*bookmark* locator and is never written as progress.

### 2. A write declares its space; the server decides whether it may land

`LocatorKind` travels with the locator. In order:

1. Nothing stored, or stored unrecognisably — **accept**.
2. Incoming locator is null — **refuse**. "I do not know where the reader is" is not "erase where
   the reader was", and the web client can produce exactly that request.
3. Same space — **accept**, declared or not.
4. Different space and the declaration **agrees with the locator** — accept.
5. Different space, undeclared or disagreeing — **refuse the whole write**.

Rule 3 is what keeps every already-installed build working: they write scroll-over-scroll for
EPUBs and declare nothing.

Rule 4 requires agreement rather than mere presence. The field is an assertion the payload has to
corroborate, not a token that waves a write through.

Rule 5 drops the percentage too, unlike `ProgressUnit`, which saves the position and discards only
the number. There, one field of an otherwise trustworthy snapshot is ambiguous. Here the entire
snapshot came from the wrong coordinate space, so `4%` was exactly as wrong as
`scroll:2-the-mom-test:0`.

### 3. The declaration is not the locator's shape

`page:16` and `scroll:x:0` describe themselves; deriving the space is two prefix tests. A field
that restated the string would carry no information, and adding one would be the percent mistake
repeated at a second field.

`LocatorKind` means something the server cannot derive: **this write came from a client that knows
coordinate spaces exist.** That is the same shape as `ProgressUnit` — declare or don't clobber —
applied to two fields that fail for different reasons: an ambiguous *value* there, a foreign
*space* here.

### 4. Not a ranking, and not a timestamp

Ranking (`page` beats `scroll`) would fix the reported case and break the one that matters more: a
PDF that will not render is read as text, and that reader is legitimately in scroll space. Ranking
makes their position unsaveable forever.

Time cannot arbitrate either. The corrupting write happens on reader close, genuinely *after* the
last good one. It is not stale; it is wrong.

### 5. One clock per column

`user_books.progress_updated_at` is stamped with the **server** clock, matching the catalog path.
It previously held `request.UpdatedAt ?? UtcNow` — the one progress column in the codebase that
could contain a *client* clock — and the stale-write gate compared a client timestamp against
whatever the column happened to hold. A PDF write arriving after a reflow write, from a device a
second behind the server, was silently dropped.

The gate is removed with the stamp. It was never a real invariant: the reflow payload has never
sent `updatedAt` at all, so that path has always been last-arrival-wins. And no client queues
progress writes for retry — mobile is fire-and-forget, web is debounce plus `keepalive` — so
arrival order already *is* recency.

### 6. The client no longer writes from the wrong reader

The server rule protects a row from any client. It is a floor, not a substitute for the mobile fix:
`useReaderPersistence` now takes `enabled`, false while a non-reflow viewer owns the position, so
the bad write is never sent. Both are needed — the client fix reaches new builds, the server rule
reaches the ones already installed.

## Consequences

- A client that never declares a kind keeps working, and loses only the ability to move a book
  between spaces deliberately.
- The catalog path (`ReadingProgress`) has one space today and is not yet guarded. When a second
  arrives, the same rule applies there; recorded as a known gap rather than pre-built.
- Refusals are silent (`Success: true`). An old client cannot act on an error and would only retry
  into it. This costs observability: a refused write is invisible. If it matters, count them.

## Open

**Cross-device last-write-wins.** Removing the gate leaves last-arrival-wins, which is correct for
one device and arbitrary for two. Doing it properly needs a second column holding the client clock,
compared only against itself — a schema change with its own migration, deliberately not bundled
into a defect fix. The same cross-clock comparison still exists on the catalog path
(`UserDataEndpoints`).

## Superseded in part by

[ADR-015](ADR-015-reader-position-is-logical.md) (2026-09-07) makes the logical position — a chapter
slug and a text anchor — the source of truth, in an additive column. The rules here are unchanged
and still govern the `locator`, which is still written: §2 rule 3 is *why* the position went into a
column rather than becoming a third space, and `LocatorSpaceTests` now asserts that `text:` is still
not one.

The "Consequences" note that the catalog path is unguarded remains open, and remains a known gap.

## Enforced by

- `backend/src/Application/ReadingTracking/LocatorSpace.cs` and `LocatorSpaceTests.cs`
- `packages/shared/src/reader/locatorSpace.ts` and its test — the two are mirrors and quote the
  same locator strings on purpose
- `UserBookProgressServiceTests` — the incident itself, plus the compatibility case that catches an
  over-tight guard
- `apps/mobile/src/lib/readerWriteMode.ts`
