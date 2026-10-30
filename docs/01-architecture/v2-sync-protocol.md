# V2 sync protocol

**Status: Proposed PDD · 2026-10-30.** Slice M2.1 of [v2-plan.md](v2-plan.md), issue #1019. Binds
M2.2–M2.7 and R6: they implement these decisions unless the owner overrules them; owner-only decisions
are under [Unresolved questions](#unresolved-questions). Docs only: by itself it makes no code, schema
or deploy change. The two schema deltas (S6) are decisions for V2 migration `0001`, not changes made
here.

**Bound by:** [ADR-031](adr/ADR-031-v2-schema.md) (rules 3, 5, 6; locator schemes; decided item 4) ·
[ADR-030](adr/ADR-030-two-databases-one-cutover.md) · [ADR-029](adr/ADR-029-foliate-for-v2-epub.md) ·
[ADR-019](adr/ADR-019-reader-position-rules.md) · [ADR-014](adr/ADR-014-guest-sessions.md) ·
[data-access.md](data-access.md) · plan §4.4 (lifecycle contracts), §5.4 (old clients), §6.1 (merge).
**Describes code as merged:** `IReadingStateRepository`/`ReadingStateRepository`,
`ILibraryRepository`/`LibraryRepository` (M1.2, #1015); the M1.3 annotation and vocabulary and M1.4
discussion repositories. Deltas to all three: [Changes required](#changes-required).

## Goal and decisions

A reader who never signs in reads with no server at all (Story A). A reader who signs in gets their
library metadata, reading state, highlights and words on every device (Story B), and can opt one book
into file sync. Sync is additive: nothing on the reading path waits for it, and a failed or paused
sync loses nothing local.

Decided here:

| # | Decision | Why, in one line |
|---|---|---|
| S1 | **Per-item writes from a client outbox**, no batch endpoint | every write is idempotent by id, revision guard or `operation_id` (reset and restore included, by `expectedRevision`); a batch adds a second error model |
| S2 | **Pull = per-aggregate change feed** keyed by `(updated_at, id)` with a 30 s overlap | 4 synced aggregates, small per-user data; no change-log table to keep consistent with 24 others |
| S3 | **The server computes SRS**; the client sends the answer, not the schedule | `SrsEngine` stays the one definition; no C#/TS twin to drift |
| S4 | **File bytes go up in parts** over the existing parts protocol; not resumable across app kills | Cloudflare caps a request at ~100 MB; resume needs state nobody has asked for yet |
| S5 | **409 bodies name why a write lost**: `stale_revision`, `reset`, `file_replaced`, `unknown_file`, `deleted`, `operation_conflict`, `duplicate_file`, `id_conflict`, `book_removed` | closes M1.2's QA gap: a stale device could not tell a move from a reset from a replacement |
| S6 | **Two schema deltas** in V2 migration `0001`: `reading_state.reset_revision`, and `ON UPDATE CASCADE` on every composite `(user_id, …)` FK | the server cannot tell a reset from a move without the first; the guest merge cannot move rows without the second ([merge](#guest--account-merge)) |
| S7 | **Shares, checkpoints, insights and reviews are not pulled**; they are online lists | they are written online (share, MCP) or are history the client does not show offline |
| S8 | **Tombstones are kept forever** | rows are tiny; purging forces a "cursor too old" protocol nobody needs yet |

## Principles

1. **Client-generated UUIDs** (v4) for every row the client creates offline: books, files,
   annotations, words, reading sessions. The server never renumbers. Exceptions, by design: a word
   whose key already exists keeps the server's id ([Vocabulary](#vocabulary)); operation-keyed rows
   (examples, reviews, shares, checkpoints) get a server id, because nothing references them before
   the server has seen them.
2. **`revision` per mutable row** (`reading_state`, `annotations`, `vocabulary_words`): a write names
   the revision it read; a stale write loses and is told the current row. Never last-writer-wins by
   clock.
3. **`operation_id` per replayable append** (examples, reviews, shares, checkpoints): replay returns
   the original; a different payload under the same id is a conflict.
4. **Last-writer-wins only where the row has no revision**: `books` metadata (no `revision` column;
   edited through `PATCH /books/{bookId}`; owner question 5), reading sessions (first write wins).
5. **Locators are opaque** beyond the ADR-031 envelope: the server checks `version`, `scheme`, `value`,
   the `quote` length and the per-column quote rule; it never parses a CFI.
6. **Idempotency first, for `operation_id` rows only.** An example, review, share or checkpoint
   answers "have I seen this operation?" before any other rule, so replaying an append that succeeded
   before a deletion still answers 200. Revisioned rows check the tombstone first: a create replayed
   onto an annotation deleted since gets `deleted` (M1.3: the create loses with the tombstone as
   `Current`). A reading-state replay after a replacement gets `file_replaced`.
7. **Reading needs no account.** Every endpoint here is `/me/v2/*` (guest sessions included, ADR-014);
   the reader never calls one on its path.

## Payloads

Wire names are camelCase JSON. "Server" = set by the server, ignored on write. Times are RFC 3339; the
server stores them as UTC.

### Library

**Book** (`books`)

| Field | Type | Req | Rule |
|---|---|---|---|
| `id` | uuid | yes | client v4; unique across all users (PK) |
| `title` | string | yes | non-blank; client falls back to the file name (`library.mjs`) |
| `author` | string | no | |
| `language` | string | no | BCP 47 primary tag as the book declares it |
| `description`, `genre` | string | no | |
| `publishedYear` | int | no | |
| `tags` | string[] | no | default `[]` |
| `checkpointSavingEnabled` | bool | server | set only through its own endpoint |
| `hasCover` | bool | server | `cover_key IS NOT NULL`; cover is fetched, never pushed in M2 (owner question 4) |
| `createdAt`, `updatedAt`, `removedAt` | time | server | `removedAt` is the soft-removal tombstone |
| `currentFile` | File \| null | server on read | null = "not imported here" (catalog book, D5) |
| `origin` | — | never | hidden provenance; server sets `{"kind":"upload"}` on client imports; never sent to clients |

**File version** (`book_files`)

| Field | Type | Req | Rule |
|---|---|---|---|
| `id` | uuid | yes | client v4 |
| `sha256` | string | yes | `^[0-9a-f]{64}$`; uppercase is **400**, not lowered: the client keys local files by it |
| `byteSize` | int64 | yes | > 0; with `sha256` it identifies the bytes (`library.mjs` dedupes on both) |
| `originalName` | string | yes | display name only, never a device path (#1069: today's R2 host passes a path as `name`) |
| `format` | string | yes | `epub` \| `pdf` from clients; `html` is server-only (clips) |
| `pageCount` | int | no | PDF |
| `toc` | json array | no | opaque, ≤ 256 KB |
| `isCurrent` | bool | server | |
| `hasContent` | bool | server | `server_storage_key IS NOT NULL`: bytes downloadable |
| `createdAt` | time | server | |

### Reading state

One per book (`reading_state`, PK `(user_id, book_id)`), always on one file version.

| Field | Type | Req | Rule |
|---|---|---|---|
| `expectedRevision` | int64 \| null | yes (may be null) | null = first write; else the revision last read |
| `fileId` | uuid | yes | first write: the book's **current** file; later: the stored `fileId` |
| `currentLocator` | locator | yes | `epub-cfi` **must** carry `quote` (1–64 code points); `pdf-page` `{"page":N}` |
| `bookFraction` | number | yes | 0..1 |
| `frontierLocator` | locator | no | sent with `frontierFraction` or not at all |
| `frontierFraction` | number | no | ≥ `bookFraction`; otherwise the server uses the position as the offered frontier |
| `completedAt` | time | no | set once; cleared only by a reset |
| `clientRecordedAt` | time | yes | the client's clock, already clamped by the client to its now + 5 min (ADR-019 `MAX_CLIENT_SKEW_MS`); the server stores it as sent |
| `revision`, `updatedAt`, `resetRevision` | | server | see [The revision rule](#the-revision-rule) |

**Locator schemes on V2 writes:** `epub-cfi` and `pdf-page` only. `textstack-position-v1` /
`textstack-anchor-v1` exist for migrated rows (ADR-031) and are refused (400 `invalid_payload`).
`pdf-page` values: a position is `{"page":N}` (1-based int); an annotation is the legacy `PdfAnchor`
`{"page":N,"rects":[{"x":…,"y":…,"w":…,"h":…}],"exact":"…"}` (page-relative, unscaled numbers).

The client may omit the frontier entirely: the server keeps the furthest of every accepted position.
From R2's local store (`store.mjs` position `{cfi, quote, index, fraction, at}`):
`currentLocator = {"version":1,"scheme":"epub-cfi","value":cfi,"quote":quote}`, `bookFraction =
fraction`, `clientRecordedAt = at`.

**Reading session** (`reading_sessions`, push only)

| Field | Type | Req | Rule |
|---|---|---|---|
| `clientSessionId` | uuid | yes | the idempotency key; replay returns the stored row, first write wins |
| `bookId` | uuid | no | |
| `startedAt`, `endedAt` | time | yes | `endedAt ≥ startedAt` |
| `durationSeconds`, `wordsRead` | int | yes | ≥ 0 |
| `startPercent`, `endPercent` | number | yes | fractions 0..1 (the column names are legacy) |

### Annotations

| Field | Type | Req | Rule |
|---|---|---|---|
| `id` | uuid | yes | client v4 (R6 replaces the page's `h<base36>` ids) |
| `expectedRevision` | int64 \| null | yes (may be null) | null = create |
| `bookId` | uuid | yes | |
| `fileId` | uuid | if `locator` | **any** version of this book, current or not: a highlight made offline in a superseded version is still valid provenance |
| `selectedText` | string | yes | non-blank; the full selection (the page's `quote`) |
| `noteText` | string | no | |
| `locator` | locator | no | `epub-cfi`: `value` = CFI, optional `quote` (≤64 code points), optional `prefix`/`suffix` (≤32 code points each; the page's 30-char context) as sibling keys — opaque to the server |
| `color` | string | yes | default `yellow`; not enumerated server-side |
| `deletedAt` | time | server | tombstone; set by `DELETE` |
| `revision`, `createdAt`, `updatedAt` | | server | |

### Vocabulary

**Word card** (`vocabulary_words`), keyed by `(language, wordKey)`.

| Field | Type | Req | Rule |
|---|---|---|---|
| `id` | uuid | yes on save | client v4; **if the key already exists the stored card's id wins** and is returned |
| `language` | string | yes | |
| `word` | string | yes | as the reader saw it; `wordKey` is computed by the server (language-aware lowercase), never sent |
| `translation`, `definition` | string | no | used only when the card is created; changing them is an explicit edit |
| `stage`, `intervalDays`, `consecutiveCorrect`, `nextReviewAt`, `lastReviewedAt` | | server | the schedule (S3) |
| `deletedAt` | time | server | tombstone |
| `revision` | int64 | server | bumped by explicit edit, delete, restore — **not** by reviews or examples |
| `examples` | Example[] | server on read | the live examples, in `createdAt` order |

**Example** (`vocabulary_examples`)

| Field | Type | Req | Rule |
|---|---|---|---|
| `operationId` | uuid | yes | client v4, one per "save this sentence" |
| `sentence` | string | yes | non-blank |
| `contextualTranslation` | string | no | |
| `bookId` | uuid | no | |
| `fileId` | uuid | no | needs `bookId` |
| `chapterKey` | string | no | needs `bookId`; a resource key in the file, never a DB chapter id |
| `bookTitle` | string | no | snapshot |
| `id`, `createdAt` | | server | |

**Review** (`vocabulary_reviews`, push only)

| Field | Type | Req | Rule |
|---|---|---|---|
| `operationId` | uuid | yes | client v4, one per answer |
| `wordId` | uuid | yes | the server's card id: after a save returns another card's id, the client rewrites its queued reviews to it |
| `reviewMode` | string | yes | non-blank, client-owned vocabulary |
| `isCorrect` | bool | yes | |
| `responseTimeMs` | int | no | ≥ 0 |
| `clientRecordedAt` | time | yes | |
| `stageBefore`, `stageAfter` | int | server | the schedule the server applied |

**S3 — the server computes the schedule.** Trade-off: a client-computed schedule lets an offline
device show the next due date at once, but it needs a TypeScript twin of `SrsEngine` that must stay
bit-for-bit equal, and two offline devices would each send a schedule computed from a stale card. A
server-computed schedule keeps one definition and applies answers in arrival order, each to the
locked card (M1.3 delta 4). Offline, the
client needs no SRS math: a card with an unpushed review in the outbox stays out of the local queue
whatever a pull says, and returns with the server's schedule once the review is accepted. Cost
accepted: two devices answering the same card offline both advance it.

- `next_review_at` = **server receive time** + the computed interval, as legacy does today
  (`VocabularyReviewRecorder`: `now.AddDays(newInterval)` with server `UtcNow`). An answer that sat
  offline for days is scheduled from when it arrived (owner question 9).
- An auto-retire (`SrsEngine.ShouldAutoRetire`) is a delete (ADR-031 decided item 4): it goes through
  `DeleteWordAsync`, so it bumps `revision` and other devices see a tombstone (owner question 1).

### Shares and checkpoints (online only)

**Shared chapter** (`shared_chapters`, immutable)

| Field | Type | Req | Rule |
|---|---|---|---|
| `operationId` | uuid | yes | |
| `bookId` | uuid | yes (path) | |
| `fileId` | uuid | no | a version of this book |
| `chapterKey` | string | yes | non-blank |
| `chapterTitle` | string | no | |
| `chapterText` | string | yes | non-blank; bounded (≤ 200 KB) |
| `notes` | json array | yes | may be `[]`; the selected annotations as the client renders them |
| `language` | string | no | |

**Checkpoint** (`discussion_checkpoints`, append-only)

| Field | Type | Req | Rule |
|---|---|---|---|
| `operationId` | uuid | yes | |
| `bookId` | uuid | yes (path) | |
| `topic` | string | yes | non-blank |
| `readerThoughts`, `assistantSuggestions`, `conclusions`, `openQuestions` | string[] | yes | may be `[]`; **not all four empty**; each ≤ 50 items, total ≤ 32 KB |
| `language` | string | yes | |
| `chapterKey` | string | no | |
| `fileId` | uuid | no | |
| `sharedChapterId` | uuid | no | **same-chapter rule**: the share must be this user's, this book's, and carry the same `chapterKey` and the same `fileId` (both null or equal); else 422 `share_mismatch` |

## The revision rule

As `ReadingStateRepository.AdvanceAsync` implements it (M1.2):

1. **First write** (`expectedRevision` null): `INSERT … SELECT FROM book_files … WHERE f.is_current
   FOR SHARE OF f … ON CONFLICT (user_id, book_id) DO NOTHING`. It lands only on the book's current
   file; `FOR SHARE` waits for a replacement in flight and re-checks `is_current`. Revision = 1.
2. **Later write**: `UPDATE … WHERE file_id = @FileId AND revision = @expectedRevision`, revision + 1.
   Of two writers with the same revision exactly one matches.
3. **Losing is not an error**: `AdvanceResult(Accepted: false, Current)`, where `Current` is the
   stored row or null.
4. The frontier only moves forward (`GREATEST`, locator and fraction as a pair); `completed_at` is
   `COALESCE(old, new)`.
5. **Reset** (`ResetAsync`) is an `UPDATE`, never a delete: frontier and completion cleared, position
   kept, revision + 1. A deleted row would hand revision 1 out again and a stale device would undo it.
6. **Replacement** (`ReplaceFileAsync`) **deletes** the row in the same transaction: its locators mean
   nothing in the new version. A device still holding the old revision names the old file, so rule 2's
   `file_id` guard makes it lose — with `Current = null`.

Rule 3 alone cannot say *why*: after a replacement `Current` is null, exactly as for a book that never
had state; after a reset it is a row with a higher revision, exactly as after another device moved.
The endpoint classifies the loss (a `ReadingSyncService` in Application, not the repository):

```
loss (Accepted = false):
  book = library.GetAsync(user, bookId)              → null: 404 book_not_found
  if state.fileId ≠ book.currentFile?.id:
      library has state.fileId as a version of book  → 409 file_replaced
      else                                           → 409 unknown_file
  stored = result.Current
  if expectedRevision ≠ null and stored ≠ null and stored.resetRevision > expectedRevision
                                                     → 409 reset   (a first writer had no frontier to lose)
  else                                               → 409 stale_revision   (stored may be null)
```

**S6 — `reading_state.reset_revision bigint NULL`**: the revision a reset produced. `ResetAsync` sets it
to the new revision in the same `UPDATE`. A writer whose `expectedRevision` is below it lost to a reset.
Without it the server can tell a reset from a move only by comparing frontiers the client last saw,
which it does not have. One `ALTER TABLE` in V2 migration `0001`
([M1.2 delta 1](#in-m12-code-lands-with-m22)); nothing to backfill (V2 is empty).

**Own write, lost response.** A client that retries an accepted write gets `stale_revision`, because
its first attempt already bumped the revision. If `current` equals what it sent (`fileId`,
`currentLocator`, `clientRecordedAt`), it treats the 409 as success and adopts `current.revision`.
Locators are compared **structurally** (jsonb does not keep key order), times as instants. The same
applies to annotations (all sent fields), word edits, resets and restores (resets and restores are
guarded writes: M1.2 delta 2a, M1.3 delta 7).

### The 409 body

One shape for every aggregate, so the client has one parser (a sketch; the examples below are valid
JSON):

```text
{ "code": "…", "message": "…", "revision": 7, "current": { … } | null, "fileId": "…", "currentFile": { … } }
```

`current` is the stored row of the aggregate the write targeted (the full read shape above); `revision`
repeats `current.revision` (null when there is no row). Optional members: `fileId` (the book's current
file id) and `currentFile` (its file version), on reading-state and file codes only; `field` on
`invalid_payload`; `expectedSha256`, `actualSha256`, `byteSize` on `content_mismatch`. 404s and 422s use the same
shape.

`stale_revision` — another device moved (or the state never existed for this revision). Client: ADR-019
rule 5 — adopt if it has not restored yet, move if the reader has not moved since, otherwise ask; then
write again with `expectedRevision = revision`.

```json
{ "code": "stale_revision", "message": "Another device saved a newer position.", "revision": 12, "fileId": "0b6a…",
  "current": { "fileId": "0b6a…", "currentLocator": {"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/14!/4/2/1:0)","quote":"It was a bright cold day"},
               "bookFraction": 0.41, "frontierLocator": {"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/16!/4/2/1:0)","quote":"Chapter two begins here"},
               "frontierFraction": 0.44, "completedAt": null,
               "clientRecordedAt": "2026-10-30T18:02:11.000Z", "updatedAt": "2026-10-30T18:02:12.104Z", "revision": 12, "resetRevision": null } }
```

`reset` — the book was restarted elsewhere: the frontier and completion are gone, the position stayed.
Client: drop its local frontier and completion for this book, keep its own current position, and write
it again with `expectedRevision = revision` (it becomes the new frontier).

```json
{ "code": "reset", "message": "The book was restarted on another device.", "revision": 9, "fileId": "0b6a…",
  "current": { "fileId": "0b6a…", "currentLocator": {"version":1,"scheme":"epub-cfi","value":"epubcfi(/6/14!/4/2/1:0)","quote":"It was a bright cold day"},
               "bookFraction": 0.41, "frontierLocator": null, "frontierFraction": null, "completedAt": null,
               "clientRecordedAt": "2026-10-30T18:02:11.000Z", "updatedAt": "2026-10-30T18:05:40.220Z", "revision": 9, "resetRevision": 9 } }
```

`file_replaced` — the file the client names is a superseded version: its locators mean nothing in the
current one, and no write for it can ever land. A first write gets it too (the brief's
`not_current_file` collapses into this code: the client action is the same). `current` is the reading
state on the new file if one exists yet, else null. Client: drop every queued reading-state write for
that file (they stay local; the reader may keep reading the old copy offline) and show "replaced on
another device": fetch the new bytes when `hasContent`, else ask the reader to import the new file.

```json
{ "code": "file_replaced", "message": "This book's file was replaced.", "revision": null, "fileId": "7c1e…",
  "current": null,
  "currentFile": { "id": "7c1e…", "sha256": "9f2c…", "byteSize": 812345, "format": "epub", "hasContent": true } }
```

`unknown_file` — the file id is not a version of this book (or the book has no file: a catalog book).
Client: push the file version first (import or attach), then the state. Any write naming a `fileId`
can get it ([Conflict codes](#conflict-codes)).

```json
{ "code": "unknown_file", "message": "Push the file version before its state.", "revision": null, "fileId": null, "current": null }
```

`deleted` — the target is a tombstone; a tombstone wins over every edit. Client: drop the local edit and
delete locally (for a word: offer restore).

```json
{ "code": "deleted", "message": "This highlight was deleted.", "revision": 4,
  "current": { "id": "5d0f…", "bookId": "…", "fileId": null, "selectedText": "…", "noteText": null, "locator": null, "color": "yellow",
               "createdAt": "2026-10-29T09:12:00.000Z", "updatedAt": "2026-10-30T17:40:00.000Z", "deletedAt": "2026-10-30T17:40:00.000Z", "revision": 4 } }
```

`operation_conflict` — see [operation_id rules](#operation_id-rules).

```json
{ "code": "operation_conflict", "message": "This operation id was used with a different payload.",
  "revision": null, "current": { "id": "e3a9…", "operationId": "2b51…", "sentence": "…", "createdAt": "…" } }
```

## operation_id rules

1. **Per user**, client-generated v4, one per replayable append: example, review, share, checkpoint.
   MCP tools have no outbox; how they form one is in [Endpoints](#endpoints-m22m26).
2. **Retained forever**: the UNIQUE `(user_id, operation_id)` lives on the row itself; there is no
   separate operations table and no expiry.
3. **Same payload → 200 with the stored row** (not 201). The client cannot tell a replay from a first
   success and does not need to.
4. **Different payload → 409 `operation_conflict` with the stored row.** That is a client bug (an id
   reused); the client logs it and drops the operation, never retries it with a new payload.
5. **The idempotency check runs before everything else** ([principle 6](#principles)): a replayed
   review of a word deleted since still answers 200.
6. **`payload_sha256`** = lowercase hex SHA-256 of the UTF-8 bytes of the canonical JSON below. The
   **server** computes it from the request; clients never send it. Only the API and the M3 ETL compute
   it, through **one C# function** in Application (`CanonicalPayload.Sha256`), so they cannot disagree.

### Canonical JSON (ADR-031 decided item 4, made precise)

Serialization: **full RFC 8785 (JSON Canonicalization Scheme)** — keys sorted by UTF-16 code units at
every depth, no insignificant whitespace, minimal string escaping, ES6 number formatting (`notes` can
hold objects with fractional pdf rects), UTF-8. `CanonicalPayload` implements all of it and is pinned
by the RFC's test vectors plus our own. **What is hashed is the normalized value as stored**, not the
raw request: whatever the endpoint normalizes before the insert (the computed `wordKey`, UTC times),
the hash sees the normalized form, so a replay compares like with like. On top of it:

| Value | Canonical form |
|---|---|
| Keys | the camelCase wire names in the table below; nothing else (not `operationId`, not the row id, not `userId`) |
| Null / absent | an optional field that is null or absent is **omitted**, so both hash equal |
| Strings | as stored; the endpoint does not trim, case-fold or Unicode-normalize free text, so for those that is as received |
| UUIDs | lowercase, hyphenated (`8-4-4-4-12`) |
| Times | UTC, `yyyy-MM-ddTHH:mm:ss.fffZ` (milliseconds, truncated): `…+02:00` and `…Z` for one instant hash equal |
| Numbers | RFC 8785 / ES6 form (`1`, `0.5`, `1e-7`); top-level fields are integers, nested JSON (`notes`) may be fractional |
| Booleans | `true` / `false` |
| Arrays | order kept (checkpoint sections are ordered) |

| Write | Fields in the hash |
|---|---|
| Example | `language`, `wordKey`, `sentence`, `contextualTranslation`, `bookId`, `fileId`, `chapterKey`, `bookTitle` (the card by its key, **not** `wordId`) |
| Review | `wordId`, `reviewMode`, `isCorrect`, `responseTimeMs`, `clientRecordedAt` (not the stages: the server computes them) |
| Share | `bookId`, `fileId`, `chapterKey`, `chapterTitle`, `chapterText`, `notes`, `language` |
| Checkpoint | `bookId`, `fileId`, `chapterKey`, `sharedChapterId`, `topic`, `readerThoughts`, `assistantSuggestions`, `conclusions`, `openQuestions`, `language` |

An example hashes its card's key because save-by-key hashes before it knows which card the key
resolves to (`SaveWordAsync` attaches the example to the stored card, whatever id the client sent).
`POST /words/{id}/examples` reads the card first and hashes its `language` + `wordKey`, so both paths
hash one example the same (M1.3 delta 5).

Example: a review `{"wordId":"5E1…","isCorrect":true,"reviewMode":"multiple_choice","responseTimeMs":null,"clientRecordedAt":"2026-10-30T20:15:03.5+02:00"}`
hashes the bytes
`{"clientRecordedAt":"2026-10-30T18:15:03.500Z","isCorrect":true,"reviewMode":"multiple_choice","wordId":"5e1…"}`.

ETL (M3): a migrated example or review hashes the same fields from the migrated row, after the case
merge: the survivor's `language` + `word_key` for examples, its final `word_id` for reviews, and
`client_recorded_at = created_at` truncated to ms. A replay of a legacy operation would match.

## Conflict codes

Who classifies a loss: reading state, the `ReadingSyncService` ([The revision rule](#the-revision-rule));
annotations, the M2.2 endpoint (M1.3 delta 1); a word id held by another user, the endpoint mapping
23505 (M1.3 delta 6).

| Code | HTTP | Writes | Body | Client does |
|---|---|---|---|---|
| `stale_revision` | 409 | reading-state PUT and reset, annotation PUT, word PATCH and restore | `current` = stored row (may be null) | state: ADR-019 adopt/move/ask, then rewrite; annotation/word: own write → success, else re-apply changed fields onto `current`, retry once, then keep the server's |
| `reset` | 409 | reading-state PUT | `current` with `resetRevision` | drop local frontier/completion; resend position with new revision |
| `file_replaced` | 409 | reading-state PUT; file PUT whose `replacesFileId` is not current, or naming a superseded version; parts/content for a non-current file | `fileId`, `currentFile` | drop queued state writes and uploads for the old file; offer fetch/import |
| `unknown_file` | 409 | every write naming a `fileId` (reading state, annotation, example, share, checkpoint, parts, content) | — | push the file version first; keep the write queued |
| `deleted` | 409 | annotation PUT, word save/PATCH, example add, review | `current` = tombstone | drop the edit, delete locally; word: offer restore |
| `operation_conflict` | 409 | example, review, share, checkpoint | `current` = stored row | log, drop the operation |
| `duplicate_file` | 409 | book PUT | `current` = the existing book with those bytes | re-key as for a merge map (local entry, local store, outbox: book id and file id); drop the import |
| `book_removed` | 409 | file PUT (replace/attach), parts, content | `current` = the removed book | restore first (`POST …/restore`) or drop the write |
| `id_conflict` | 409 | any create | — (no row: it may be another user's) | mint a new id, retry |
| `share_mismatch` | 422 | checkpoint | — | send the matching share or none |
| `content_mismatch` | 422 | content complete | `expectedSha256`, `actualSha256`, `byteSize` | re-hash locally; re-upload all parts |
| `incomplete_upload` | 400 | content complete | — | a part is missing (e.g. dropped by a restart): re-send **all** parts, then complete again |
| `book_not_found` | 404 | anything under a book, and every write naming a `bookId` (examples, sessions) | — | push the book first (outbox order); if the book is gone locally too, drop |
| `not_found` | 404 | annotation/word/example/share/checkpoint by id | — | an id the server never had: its create is still queued → keep; else drop |
| `no_content` | 404 | content GET | — | the server holds no bytes: show "import the file" |
| `invalid_payload` | 400 | any | `field` | client bug: log, drop |
| `v2_unavailable` | 503 | any `/me/v2/*` | `Retry-After` | pause sync; reading is unaffected |

## File sync upload protocol

Opt-in per book (Story B5): the opt-in is the act of uploading, from a device that holds the bytes.
There is no server flag; other devices see `currentFile.hasContent`.

**Order: metadata, then bytes.**

1. **sha256 first.** `GET /me/v2/books/by-sha256/{sha256}` → `FindBySha256Async` (owner-scoped, live
   books, current files). 200 → the book exists: adopt its ids locally, no import. 404 → import.
2. **Import metadata** `PUT /me/v2/books/{bookId}` with the book and its first file (no bytes): 201.
   Replay → 200 when the book is the user's **and** the import's `file.id` is any version of it, so a
   replay after a replacement does not turn into `id_conflict` → new id → duplicate book (#1065,
   [M1.2 delta 2](#in-m12-code-lands-with-m22)). Another live book already has those bytes as its
   current file → 409 `duplicate_file`. Check and insert run under
   `pg_advisory_xact_lock(hashtext(user_id::text || sha256))`, so two devices importing the same bytes
   at once cannot both win (no UNIQUE, by design).
3. **Bytes, only if the reader opted in**: `PUT …/files/{fileId}/parts/{index}` for each part, then
   `POST …/files/{fileId}/content {partCount}`. The server joins the parts, checks SHA-256 and size
   against the file row, moves the result to its storage key, and sets `server_storage_key`. Already
   stored → 200 at once (replay). Mismatch → 422 `content_mismatch`, parts deleted. A part missing
   (e.g. dropped by a restart) → 400 `incomplete_upload`; the client re-sends all parts.
4. **Download** `GET …/files/{fileId}/content`: the bytes with HTTP range support (a dropped download
   resumes for free); 404 `no_content` when not stored.

**S4 — parts, not resumable across kills.** V2 reuses the legacy **protocol** (`ChunkedUploadStore`:
client-chosen upload id, `{index:D5}.part`, Cloudflare's ~100 MB request cap, `MaxSingleUploadBytes`
= 80 MB), with **the file id as the upload id**: no init call, no DB row, stale sweep after 1 day. It
does **not** reuse the legacy store or quota: those parts live under `Path.GetTempPath()`
(`ServiceCollectionExtensions.Content.cs`), which every deploy's api restart drops, and the quota reads
legacy EF tables (`UserBookService.CheckQuotaAsync`), which ADR-030 forbids V2 to depend on. V2 parts
live under the persistent volume (`Storage:LibraryRoot`/`uploads/`); the V2 quota is computed over V2
`users` and `book_files` (owner question 2).

The client picks the part size, ≤ `maxPartBytes` from `GET /status`. STATUS's "RN cannot slice an
opaque `file://`" looks out of date for the retained copy: expo-file-system 57's `File.open()` returns
a `FileHandle` with a settable `offset` and `readBytes(n)`, and `books/<sha256>.epub` lives in the
app's own documents dir. **Unverified**: that a `readBytes` `Uint8Array` goes through RN `fetch` as a
request body intact. Fallback that needs no such path: write each part to a cache file
(`FileHandle.writeBytes`) and send it with the native `File.upload()` (`httpMethod: 'PUT'`, binary),
which exists in 57.0.7. R6 proves one of the two on a device before M2.6 ships. Web sends
`Blob.slice` parts as today.

| Option | For | Against |
|---|---|---|
| One request (native `File.upload`, streamed, progress, iOS background) | no JS memory, simplest client | > ~100 MB refused by Cloudflare; a failure restarts the whole book |
| **Parts, retried per part, restart after a kill** (chosen) | reuses a protocol that exists; a flaky link re-sends one part | a kill mid-upload re-sends from part 0 |
| Resumable (server lists stored parts, client skips them) | survives kills | one more endpoint and a part-listing contract; no evidence yet that 80 MB uploads die mid-way |

Upgrade path, with no protocol break: `GET …/files/{fileId}/parts` returning stored indices and sizes.
Add it when an upload failure rate shows up.

**Replacement** (a new version of a book): the same path — `PUT /me/v2/books/{bookId}/files/{fileId}`
with the new file's metadata and **`replacesFileId`** (the current file the client saw; null = first
attach) → `ReplaceFileAsync` (new row current, old row kept, reading state deleted), then bytes for
the new file id as above. `replacesFileId` ≠ the stored current file → 409 `file_replaced` with
`currentFile`, so two devices replacing offline do not silently last-writer-win (M1.2 delta 2b; owner
question 10). Attaching the first file to a catalog book (D5, no file) is the same call
(`Superseded = null`). Replay: the file id is already current → 200; it exists but is no longer
current → 409 `file_replaced` (M1.2 delta 3).

Bytes attach only to the **current** file: parts and content for a non-current file → 409
`file_replaced`, for an unknown one → 409 `unknown_file`; `AttachContentAsync` writes
`WHERE is_current` (M1.2 delta 4).

**A removed book** (`removed_at` set; owner question 11):

| Accepts (a device reading offline may sync after the removal) | Refuses with 409 `book_removed` |
|---|---|
| reading state, annotations, examples, sessions | replace / attach a file, parts, content |

**Local positions after a replacement.** The device that replaced keys its local store by the new
sha256 (`store/<sha256>.json`), so it starts the new version with no position and no highlights — the
same as the server. Old highlights stay on the server anchored in the old version (provenance; listed
as quotations, not drawn): no re-anchoring in V2's first release (ADR-031: no conversion; owner
question 8). Another
device learns of the replacement from its next pull (`books.updated_at` bumps on replace) or from a
`file_replaced` 409, whichever comes first.

**Storage key** (plan §4.5): `library/{userId[..2]}/{userId}/{bookId}/{fileId}.{epub|pdf}` relative to
`Storage:LibraryRoot`. Old versions' bytes are deleted by a retried job after the replacement commits;
their `server_storage_key` is cleared only once the bytes are gone (schema comment).

## Pull and push

**S2 — pull: one change feed per aggregate.**

`GET /me/v2/{library|reading|annotations|vocabulary}/changes?cursor=&limit=` → `{ items, cursor, hasMore }`.

- Rows ordered by `(updated_at, id)`, keyset-paged; tombstones included (`removedAt`, `deletedAt`).
- The final page's `cursor` encodes `max(updated_at)`. A pull that **starts** from a stored cursor
  reads from `cursor − 30 s`: a write transaction that took `now()` before a row the previous pull saw,
  but committed after it, is still delivered. A pulled row **always replaces** the client's cached
  server copy of that row (revision is a write count, not recency: reviews change a schedule without
  one, state restarts at 1 after a replacement, books have none); the client's unpushed outbox
  entries overlay the cached copy. Re-delivery is harmless.
- `ponytail:` overlap window. A write transaction longer than 30 s could be missed until its row
  changes again; a per-user change sequence if that ever happens.
- `cursor` absent = full pull. Cursors are opaque base64; the client stores one per aggregate.
- What each feed carries:

| Feed | Rows | Watermark |
|---|---|---|
| `library` | books incl. removed, each with `currentFile` | `books.updated_at` — bumped by **every** library write: import, replace, attach content, remove, restore, checkpoint-saving, metadata edit |
| `reading` | `reading_state` rows | `reading_state.updated_at` |
| `annotations` | annotations incl. tombstones | `annotations.updated_at` (bumped on delete) |
| `vocabulary` | words incl. tombstones, each with its **live** examples | `vocabulary_words.updated_at`, bumped by every example add, review and translation fill (M1.3 does) |

Each feed is one `ListChangedAsync(userId, since, afterId, limit)` per repository (M1.2 deltas 4–5,
M1.3 deltas 2–3).

There is no example delete in V2's first release (M1.3 has none; examples go with their card). Should one
be added, it needs no tombstone of its own: a word arrives with its full live example set, and the
client replaces its examples for that word (keeping its own unpushed ones, which live in the outbox).
Not pulled (S7): reviews (history), sessions (push only), shares, checkpoints, insights (online lists).

Trade-off: a per-user change cursor (one sequence, one feed) gives exact ordering but needs every write
of 24 tables to append to a log in the same transaction — a second write path to keep consistent. Four
feeds over the rows themselves need nothing new beyond the `updated_at` bumps listed above.

**Push: an outbox per device**, drained in order, one request per entry (S1):

1. books and file versions → 2. reading state, sessions → 3. annotations → 4. words → 5. examples,
reviews. Bytes uploads run beside the queue and never block it. A child pushed before its parent gets
404 `book_not_found` / 409 `unknown_file` and stays queued.

Retrying the whole outbox is safe: creates are keyed by client id (replay → 200), edits by revision
(own write → success, see [The revision rule](#the-revision-rule)), appends by `operation_id`. An
entry leaves the outbox on 2xx or on a code whose action is "drop"; on 5xx/network it stays, with
backoff. `ponytail:` per-item requests; a batch endpoint when a first sync of hundreds of words
measurably hurts.

## Guest → account merge

Server-side, in one transaction at sign-in (M2.5), as a cross-user system operation with its own name
(`IAccountMergeRepository.MergeAsync(guestId, accountId, tx)`, data-access.md rule 7; M1.4 delta 2).

**How rows move.** PKs are global (`pk_books(id)`, `pk_book_files(id)`, `pk_vocabulary_words(id)`), the
ownership FKs are composite, `ON DELETE CASCADE` and mostly not deferrable, and `ON CONFLICT` exists
only on `INSERT`: "insert under the account, move children, delete the guest row" cannot be built
(the insert collides on the PK; the delete cascades the children away). And ADR-014 swallows class-23
errors and skips the **whole** merge, so one constraint violation orphans every guest row.
Decision (S6, [M1.2 delta 1](#in-m12-code-lands-with-m22); owner question 12): migration `0001` adds
**`ON UPDATE CASCADE` to every composite `(user_id, …)` FK**, so
reparenting is `UPDATE <parent> SET user_id = @account WHERE user_id = @guest` and children follow,
keeping their client ids (ADR-031 rule 3). Order inside the transaction:

1. Delete guest leaf rows whose `operation_id` / `client_session_id` already exists on the account
   (the cascade would otherwise collide on `UNIQUE (user_id, …)`), counting them in the merge log.
2. Matched books and words (below): move their children onto the account's row
   (`UPDATE … SET user_id, book_id|word_id`), then delete the emptied guest row.
3. Reparent everything else by `UPDATE … SET user_id` on parents.
4. On every moved row: `updated_at = now()` (other devices of the account must see it in their
   feeds); recompute `payload_sha256` through `CanonicalPayload` where a hashed field changed
   (`bookId`, `fileId`, `wordId`, `sharedChapterId`).
5. File bytes: `server_storage_key` embeds the user id (plan §4.5), so stored bytes move to the
   account's key and the column is rewritten — after commit, by the same retried job that deletes
   superseded bytes, which reads both keys until it is done.

| Aggregate | Rule |
|---|---|
| Books | Match on **current file sha256, live books only** (the `FindBySha256Async` rule). Match → keep the account's book; the guest book's annotations, sessions, examples, shares, checkpoints, insights move onto it; the guest's file rows move as **non-current** versions of the account's book (provenance for annotations anchored in them), except a guest file with the same sha256 as the account's current file, whose references remap to that file. No match → the book is reparented with its id. |
| Reading state | Only for matched books (unmatched ones move as is). Winner = **newer `clientRecordedAt`** (revision counts writes, it is not recency). Frontier = max(both frontiers, winner's position), so `ck_reading_state_frontier_ahead` holds even against a reset side with no frontier. `completedAt` follows the winner; `resetRevision` = the account's (a reset on the account is never lost). `fileId` = the account's current file. **Revision = max(both) + 1**. Only one side has state → it moves as is. |
| Annotations | Reparented; ids unchanged. |
| Vocabulary | Match on `(language, wordKey)`. Survivor id = **the account's**. Fields from the live side: both live → the account's card and schedule; account tombstone + guest live → the account's row revived with the guest's fields and schedule; guest tombstone → the account's row as is. Examples and reviews of both move to the survivor. Revision = max + 1. No match → reparented with its id. |
| Sessions | Reparented; `book_id` remapped for matched books. |
| Insights | Reparented; a `(book, chapter)` clash keeps the newer `updated_at` (save_insight already replaces; owner question 7). |
| Shares, checkpoints | Reparented; `book_id` remapped. Same-chapter rule still holds (shares move with their checkpoints). |

**`operation_id` and `client_session_id` collisions.** The UNIQUE is per user, so moving guest rows
can collide only when the same id exists on both sides. Random v4 ids do not collide; the real case is
one device that pushed the same outbox entry under both identities. Step 1 deletes the guest's copy
before anything moves: the account's row stays (`payload_sha256` differing is logged as an anomaly,
not an error).

**What the client sees.** The sign-in response carries
`merge: { books: { guestId: accountId }, files: { guestId: accountId }, words: { guestId: accountId } }`
— only ids that changed. `files` matters: a queued state write still naming the guest's file would
get `unknown_file`, and "push the file first" would then **replace** the account's current file and
delete its reading state. The client then rewrites book, file and word ids in its outbox and local
store by that map, clears every cursor and does a full pull, and keeps its outbox. Every revision it
cached is now stale (every merged row is max + 1, every account row it never saw is new), so its
queued edits come back `stale_revision` and follow [Conflict codes](#conflict-codes): reading state
through ADR-019 (never yank a reader who moved), annotations and words by re-applying the local change
once. Nothing local is lost.

## What old clients see

- Legacy routes keep legacy semantics: until M5 they talk to the legacy database; after M5 through the
  shim (plan §5.4). They never return a V2 code or body. A V2 409 exists only under `/me/v2/*`, which no
  old build calls.
- V2 routes live under **`/me/v2/*`** (temporary prefix, renamed at M5.4), mapped only when
  **`Features:V2Api`** is on. A V2 client with a session (PathGates answers 401 without one) probes
  `GET /me/v2/status` once per app start: 404 = V2 off (sync stays legacy), 200 = `{ "maxPartBytes": … }`.
- **V2 readiness gates V2 endpoints only (#1053)**: a V2 database that is behind, unreachable or not
  created answers 503 `v2_unavailable` on `/me/v2/*` and leaves sign-in, the legacy library and the
  catalog serving. Never a startup dependency.
- `X-App-Version` is logged on every request by the existing `AppVersion` middleware; the shim adds
  route + outcome (plan §5.4). No minimum V2 client version is enforced in M2.
- Request bodies are not versioned: fields are only ever added; a breaking change is a new route.

## Endpoints (M2.2–M2.6)

All under `/me/v2`, `Features:V2Api`, V2 readiness filter (#1053), user or guest session required
(PathGates already 401s `/me/*`). Not public, so not in `routes.public.txt`.

| Slice | Method · path | Request | Responses |
|---|---|---|---|
| M2.2 | `GET /status` | — | 200 `{maxPartBytes}` |
| M2.2 | `GET /library/changes` (every feed alike) | `cursor`, `limit` (default 200, max 500) | 200 feed |
| M2.2 | `GET /books/by-sha256/{sha256}` | — | 200 book · 404 |
| M2.2 | `PUT /books/{bookId}` | book + `file` | 201 · 200 replay · 409 `duplicate_file` / `id_conflict` |
| M2.2 | `PATCH /books/{bookId}` | `title?`, `author?`, `language?`, `description?`, `genre?`, `publishedYear?`, `tags?` | 200 (LWW, bumps `updated_at`) · 404 |
| M2.2 | `PUT /books/{bookId}/files/{fileId}` | file + `replacesFileId` | 200 `{current, superseded}` · 409 `file_replaced` / `book_removed` / `id_conflict` · 404 |
| M2.2 | `DELETE /books/{bookId}` · `POST /books/{bookId}/restore` | — | 204 (idempotent) · 404 |
| M2.2 | `GET /reading/changes` · `GET /books/{bookId}/reading-state` | — | 200 · 404 |
| M2.2 | `PUT /books/{bookId}/reading-state` | reading state | 200 state · 409 `stale_revision` / `reset` / `file_replaced` / `unknown_file` · 404 |
| M2.2 | `POST /books/{bookId}/reading-state/reset` | `{expectedRevision}` | 200 state · 409 `stale_revision` (own write if `current` is the reset) · 404 |
| M2.2 | `PUT /reading/sessions/{clientSessionId}` | session | 201 · 200 replay · 404 `book_not_found` |
| M2.2 | `GET /annotations/changes` | — | 200 feed |
| M2.2 | `PUT /annotations/{id}` | annotation | 201 · 200 · 409 `stale_revision` / `deleted` / `unknown_file` / `id_conflict` · 404 `book_not_found` |
| M2.2 | `DELETE /annotations/{id}` | — | 200 tombstone (idempotent) · 404 |
| M2.3 | `GET /vocabulary/changes` · `GET /vocabulary/due?limit=` | — | 200 |
| M2.3 | `PUT /vocabulary/words` | word (`id`, `language`, `word`, `translation?`, `definition?`) + optional `example` | 201 card · 200 existing card (id may differ) + `example: "added" \| "replayed"` · 409 `deleted` / `operation_conflict` / `unknown_file` / `id_conflict` · 404 `book_not_found` |
| M2.3 | `PATCH /vocabulary/words/{id}` | `expectedRevision`, `translation?`, `definition?` | 200 · 409 `stale_revision` / `deleted` |
| M2.3 | `DELETE /vocabulary/words/{id}` · `POST /vocabulary/words/{id}/restore` | restore: `{expectedRevision}` | 200 · 409 `stale_revision` · 404 `not_found` |
| M2.3 | `POST /vocabulary/words/{id}/examples` | example | 201 · 200 replay · 409 `operation_conflict` / `deleted` / `unknown_file` · 404 `not_found` / `book_not_found` |
| M2.3 | `POST /vocabulary/reviews` | review | 201 `{review, word}` · 200 replay · 409 `operation_conflict` / `deleted` · 404 `not_found` |
| M2.4 | `POST /books/{bookId}/shares` · `GET /books/{bookId}/shares` · `DELETE /shares/{id}` | share | 201 · 200 replay · 409 `operation_conflict` / `unknown_file` · 404 `book_not_found` / `not_found` · 204 |
| M2.4 | `POST /books/{bookId}/checkpoints` · `GET /books/{bookId}/checkpoints?chapterKey=&cursor=&limit=` (paged as M1.4's `CheckpointPage`) · `DELETE /checkpoints/{id}` | checkpoint | 201 · 200 replay · 409 `operation_conflict` / `unknown_file` · 422 `share_mismatch` · 404 `book_not_found` / `not_found` · 204 |
| M2.4 | `PUT /books/{bookId}/checkpoint-saving` | `{enabled}` | 200 |
| M2.6 | `PUT /books/{bookId}/files/{fileId}/parts/{index}` | bytes, `Content-Length` ≤ `maxPartBytes` | 200 `{index, size}` · 411 · 400 `invalid_payload` (part over `maxPartBytes`) · 409 `file_replaced` / `unknown_file` / `book_removed` |
| M2.6 | `POST /books/{bookId}/files/{fileId}/content` | `{partCount}` | 200 file · 422 `content_mismatch` · 400 `incomplete_upload` · 409 `file_replaced` / `unknown_file` / `book_removed` |
| M2.6 | `GET /books/{bookId}/files/{fileId}/content` | `Range` | 200/206 · 404 `no_content` |

MCP tools have no client outbox; how their `operation_id` is formed is M2.3/M2.4's decision. A
payload-derived id is **not** an option: the schema says a new operation with the same sentence is a
second example, and sharing again makes a new snapshot (`0000_baseline.up.sql`, comments on
`vocabulary_examples` and `shared_chapters`). Recommended: a per-call nonce from the host. Owner
question 13.

**Deferred provenance FKs.** `book_id`/`file_id` on examples, shares, checkpoints and annotations are
`DEFERRABLE INITIALLY DEFERRED`: a bad id fails at **commit** (23503), which would surface as a 500
and an outbox that retries forever. Every write naming a `bookId`/`fileId` checks both first and
answers `book_not_found` / `unknown_file` (M1.3 delta 8, M1.4 delta 1); no endpoint maps a
commit-time 23503.

Plan alignment: #1065 (import replay) lands with `PUT /books/{bookId}` in **M2.2**, not M2.6 — the
metadata import is M2.2's, only the bytes are M2.6's. #1067 (explicit V2 transaction) is needed by M2.2
(replace + state) and M2.5 (merge); M2.3 avoids it with a schedule callback (M1.3 delta 4).

## Changes required

### In M1.2 code (lands with M2.2)

- **1.** Migration `database/v2/migrations/0001` (+ down): `reading_state.reset_revision bigint NULL`, CHECK
   `reset_revision <= revision`; and every composite `(user_id, …)` FK re-created with
   `ON UPDATE CASCADE` (merge). `ResetAsync` sets `reset_revision`; `ReadingState.ResetRevision`.
- **2.** `ImportAsync` replay-safe (#1065, **scope widened**): the book is the user's and the import's
   `file.id` is any version of it → return the stored book; anything else under that id →
   `id_conflict`. The sha256 check and the insert run under
   `pg_advisory_xact_lock(hashtext(user_id::text || sha256))` (`duplicate_file`).
- **2a.** `ResetAsync(userId, bookId, expectedRevision)`: guarded like a write; stale → lost + current.
- **2b.** `ReplaceFileAsync(…, replacesFileId)`: the stored current file must equal it (null = no file),
   else a `FileReplaced` outcome; a removed book → `BookRemoved`.
- **3.** `ReplaceFileAsync` replay: file id already current → return it (`Replayed`); exists, not current →
   a `FileReplaced` outcome instead of a PK exception.
- **4.** `ILibraryRepository` gains `GetFileAsync(userId, bookId, fileId)` (classify `file_replaced` vs
   `unknown_file`), `AttachContentAsync(userId, bookId, fileId, storageKey)` (`WHERE is_current`, book
   not removed), `SetCheckpointSavingAsync(userId, bookId, enabled)`, `UpdateMetadataAsync` (LWW),
   `ListChangedAsync(userId, since, afterId, limit)` (removed books included). **Every** library write
   bumps `books.updated_at` — attach and checkpoint-saving too, or `hasContent` never reaches other
   devices.
- **5.** `IReadingStateRepository.ListChangedAsync(userId, since, afterId, limit)`; the replace-time delete
   moves here with the shared transaction (#1067).

### M1.3 as merged (annotations, vocabulary) — what M2.2/M2.3 add

Reconciled against the M1.3 code. Kept as is (no delta): `SaveAnnotationResult(Accepted, Current)`;
tombstone delete bumping `revision` + `updated_at`, and a tombstone that refuses every later write;
`SaveWordAsync` → `SavedWord(Created|Existing|Deleted, Word, Example?)`, no example on a tombstone,
translation/definition only filled when null; word `revision` only on update/delete/restore,
`updated_at` on review/example/fill; `WriteResult<T>(Created|Replayed|OperationConflict|Deleted, Row)`
with the replay check first; the caller supplies `PayloadSha256`.

1. **Annotation codes are derived by the M2.2 endpoint**, not the repository. On `Accepted = false`:
   `Current` is a tombstone → `deleted`. Else check the book (`ILibraryRepository.GetAsync`) and the
   file (`GetFileAsync`, M1.2 delta 4): book missing → 404; `fileId` not a version of it →
   `unknown_file` (the repository loses such a write with `Current` null on create, or the stored row on
   update — so the file check comes before the revision check). `Current` null with book and file fine
   → the id is another user's → `id_conflict`. `Current` equal to what was sent → own write, 200.
   Otherwise `stale_revision`. `DeleteAsync` false → `GetAsync`: a tombstone answers 200, none 404.
2. **M2.2:** `IAnnotationRepository.ListChangedAsync(userId, since, afterId, limit)`, tombstones included.
3. **M2.3:** `IVocabularyRepository.ListChangedAsync(userId, since, afterId, limit)`, tombstones
   included, each card with its live examples (as `GetWordAsync` loads them).
4. **M2.3 — the schedule must be computed from the locked card.** Today `RecordReviewAsync` locks the
   card (`FOR UPDATE`) but applies a `ReviewSchedule` and `StageBefore` the caller computed from an
   earlier, unlocked read: two devices answering one card at once both compute from the same stage and
   the second overwrites the first. Change: `RecordReviewAsync(review, Func<VocabularyWord,
   ReviewSchedule> schedule, ct)` — after the replay and tombstone checks the repository reads the
   locked card, calls `schedule` (the Application service passes `ISrsEngine.Calculate`; the math stays
   out of the repository), and fills `StageBefore`/`StageAfter` itself. Smaller than threading a
   transaction through (#1067), same guarantee.
5. **M2.3 — example hash per [Canonical JSON](#canonical-json-adr-031-decided-item-4-made-precise)**:
   `language` + `wordKey`, not `wordId` (the open point M1.3 raised). No repository change: the service
   computes `wordKey` before calling `SaveWordAsync`.
6. **M2.3 — a word id taken by another user** throws `pk_vocabulary_words` (the create's `ON CONFLICT`
   is on the key only): the endpoint maps that 23505 to 409 `id_conflict`.
7. **M2.3 — `RestoreWordAsync(userId, wordId, expectedRevision)`**, guarded like `UpdateWordAsync`.
8. **M2.3 — example `bookId`/`fileId`** are checked before `SaveWordAsync`/`AddExampleAsync`
   (`book_not_found` / `unknown_file`): today a bad one fails at commit with 23503, pinned by M1.3's
   tests as a broken invariant; the endpoint makes it a client error instead.

### M1.4 as merged (shares, checkpoints) — what M2.4 adds

Kept as is (no delta): `DiscussionWriteResult<T>(Created|Replayed|OperationConflict|ShareMismatch,
Stored)`; share delete unlinks checkpoints in one transaction; `ICheckpointRepository.ListAsync(userId,
bookId, chapterKey?, limit, CheckpointCursor? after)` → `CheckpointPage(Items, Next)`; shares listed
newest first, unpaged (a book has few); the caller supplies `PayloadSha256`. Insights and review
questions are online-only and outside this protocol.

1. **M2.4 — `bookId`/`fileId`** are refused by the deferred FKs at commit (`PostgresException`
   23503) for shares and checkpoints, pinned by M1.4's tests. The endpoint checks both first
   (`ILibraryRepository.GetAsync` / `GetFileAsync`) and answers 404 `book_not_found` / 409
   `unknown_file`; it never maps a commit-time 23503.
2. **M2.5:** no merge logic in these repositories; the guest merge is one `IAccountMergeRepository`.

## Bug Report

Reading state and library (M1.2):

- **Reset vs move indistinguishable**: `ResetAsync` only bumps `revision`; a stale writer sees the
  same loss as after a move. Needs `reset_revision` (S6).
- **`ResetAsync` is unguarded**: a replayed reset after another device advanced resets again
  (M1.2 delta 2a).
- **Replacement loss looks like "no state"**: `ReplaceFileAsync` deletes `reading_state`, so a stale
  write returns `Accepted=false, Current=null`. Classified by the endpoint
  ([The revision rule](#the-revision-rule)); the repository contract is fine, but its callers must not
  read `Current == null` as "nothing happened".
- **`ImportAsync` / `ReplaceFileAsync` throw on replay** (`pk_books` / `pk_book_files`): #1065 covers
  import only; replace has the same gap.
- **`ReplaceFileAsync` has no precondition** (`LibraryRepository.cs`): two offline replacements are
  silent last-writer-wins. `replacesFileId` fixes it.
- **Plan §8 vs #1065**: the issue defers import idempotency to "the M2 import endpoint (upload flow,
  M2.6)"; the metadata import is M2.2's.
- **The V2 merge as first written could not be built**: global PKs + non-deferrable `ON DELETE
  CASCADE` composite FKs + `ON CONFLICT` only on `INSERT`; ADR-014 then skips the whole merge on any
  class-23 error. Fixed by S6's `ON UPDATE CASCADE`.

Annotations and vocabulary (M1.3, schema comments):

- **Review schedule computed outside the lock** (`RecordReviewAsync`): concurrent answers to one card
  lose an SRS step. Fixed in M2.3 (M1.3 delta 4).
- **Retired = deleted** (ADR-031 decided item 4 vs the `vocabulary_words` comment "re-saving a deleted
  word needs an explicit restore" vs legacy "reader-tap unretires", `SrsEngine.ShouldAutoRetire`):
  mastered words become tombstones and lose the tap-to-resurface path. Owner question 1.
- **`vocabulary_examples` has `deleted_at` but no `updated_at`**: an example delete is invisible to any
  watermark. Moot while V2 has no example delete; M1.3 bumps the word on every example add.
- **`annotations.deleted_at` comment** "how long it is kept is not decided": decided here (forever, S8).

Clients and legacy (R2, R6, STATUS):

- **Client ids are not UUIDs**: `library.mjs` `randomId()` = `lb_<base36>`, `page.mjs` highlight id =
  `h<base36 ms>` (two highlights in one ms collide). ADR-031 rule 3 needs v4 UUIDs; R6 must mint them.
- **Position quote cut by UTF-16 units**: `page.mjs:173` `.slice(0, 64)` can split a surrogate pair;
  the lone half is not valid UTF-8, so the stored quote changes and resume reports a mismatch. Cut by
  code points.
- **Highlight `quote` is the full selection** (`page.mjs:276`), but `locator.quote` is capped at 64
  (`is_locator`): the selection belongs in `selectedText`. Prefix/suffix have no home in ADR-031; this
  PDD puts them in the envelope as opaque siblings (ADR-031 should say so).
- **STATUS "Mobile chunked upload: RN cannot slice an opaque `file://`"** is stale for app-owned files:
  expo-file-system 57 `File.open()` → `FileHandle.offset` + `readBytes`. Still true for a picker's
  `content://` URI, which V2 copies to staging first anyway.
- **Legacy chunked parts live in `Path.GetTempPath()`** (`ServiceCollectionExtensions.Content.cs`):
  every deploy restarts the api and drops in-flight parts; the legacy client sees "a part is missing".

## Unresolved questions

Default in parentheses.

1. Mastered words: tombstone, or a separate "retired"? (tombstone, ADR-031 item 4)
2. V2 bytes quota: tiers over V2 `users`/`book_files`, or none until cutover? (V2 tiers)
3. Local-first books on sign-out: device's or account's (#1070)? (no default)
4. Covers in M2: client uploads, server extracts, or none? (no default)
5. Book metadata `PATCH`: LWW without revision? (yes)
6. "Stop syncing this file" (delete server bytes) in M2.6? (no default)
7. Merge insight clash: newer wins? (yes)
8. Re-anchor old highlights into a replacement file, ever? (not in V2's first release)
9. `next_review_at` from server receive time or `clientRecordedAt`? (receive time, as legacy)
10. Concurrent offline replacements: `replacesFileId` → `file_replaced`, or LWW? (`file_replaced`)
11. Removed book: accept state/annotations/examples/sessions, refuse file and bytes with `book_removed`? (yes)
12. Merge: `ON UPDATE CASCADE` on composite FKs, or new ids for merged rows? (cascade, keeps client ids)
13. MCP `operation_id`: per-call host nonce or payload-derived? (nonce: a payload-derived id would make a re-share a replay, against the schema’s "sharing again makes a new snapshot")
