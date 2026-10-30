# V2 target model

**Status: Discussion · 2026-10-28.** For the owner and future ADR authors.
This is a proposed domain model, not an accepted schema or permission to implement it.
It separates owner direction, existing engineering decisions and questions still requiring a decision.

## Direction and boundaries

Owner direction:

- A personal reader, with translation, vocabulary and meaningful book discussions.
- Reading a local book must not require an account or server-held chapters.
- Cloud sync is optional. Sharing chapter context for MCP is a separate, explicit action.
- Owner decision (2026-10-29): server-side synced files initially use filesystem storage on a persistent
  volume, outside disposable container storage. PostgreSQL stores metadata and relative file keys, not
  EPUB/PDF bytes. Retain existing R2 backups; live S3/R2 storage is not required for V2. Device sync
  runs through the API. Accountless local reading remains independent of server storage.
- Owner decision (2026-10-28): after sign-in, progress, vocabulary and notes sync by default. Original book files sync only when the reader enables file sync.
- Preserve existing reader features and user data; do not silently discard them to simplify the schema.
- Owner exception (2026-10-29): legacy reading positions may reset and legacy highlights may remain
  unanchored quotations. Preserve their text, attached notes, vocabulary and saved discussions; back
  up data before cutover. Legacy-to-CFI migration work is not a prerequisite for V2.
- Owner decision (2026-10-28): deleting a book preserves its MCP shares and saved insights. They remain independently deletable; account deletion removes account-owned cloud content.
- Owner decision (2026-10-29): removing a book retains a hidden library record with its title and
  provenance for saved quotations, notes and discussions. This does not require retaining file bytes.
- Owner decision (2026-10-29): current position and furthest-read frontier live in a separate
  `reading_state` table rather than columns on `books`; detailed sync behavior remains open.
- Owner clarification (2026-10-29): vocabulary is saved to study words, not to create separate learning
  entries for each contextual meaning. Model one learning record per owner, source language and word
  identity across books. Re-saving adds source context without resetting learning progress.
- Owner decision (2026-10-29): initially match vocabulary by spelling without case within the source
  language (`Reading` and `reading` share a card); keep different forms such as `read`, `reads` and
  `reading` separate. No stemming, lemmatization or automatic sense grouping. Preserve original spelling
  in source examples. Exact language-aware case normalization, translation updates and storage of
  multiple contexts remain to be specified.
- Owner decision (2026-10-29): re-saving a word with a different translation keeps the card's existing
  translation and learning progress. Add the new source example with its contextual translation;
  do not automatically replace the card translation. Multiple-context storage remains a schema choice.
- Retire the public SEO catalog within V2. Until then it stays frozen; no standalone interim migration.
- Owner clarification (2026-10-29): aim for roughly **20 application server tables**, including auth
  and operations. This is a simplicity guide, not a hard cap; clear domain boundaries take precedence.
- Android and web first; iOS remains a target. Desktop is deferred.

Existing engineering decisions remain in force: .NET backend, PostgreSQL,
[SQL-first migrations](adr/ADR-026-sql-first-migrations.md) and
[incremental Dapper adoption](adr/ADR-028-dapper-and-repositories.md).
The shared `NpgsqlDataSource` provides a connection pool, not one physical connection.
No client framework, replacement reader engine or complete database schema is selected here.

## Ownership and lifecycle

Device storage below is the proposed default. Cloud records belong to the authenticated user;
matching book content must never grant access to another user's records.

| Object | Owner | Where it lives | Created / changed / deleted when |
|---|---|---|---|
| Book identity / library entry | Reader | Device; cloud metadata if sync is enabled | Import creates an entry. Rename changes metadata. Removing an entry preserves its MCP shares and saved insights; they have independent deletion actions. Other dependent-data deletion rules remain open. |
| Book file and version | Reader | Device; optional cloud copy | Import stores readable bytes. A replacement is a new file version until annotations and positions can be mapped safely. Cloud-copy removal and library removal are distinct operations. |
| Position + furthest-read frontier | Reader | Device; optional cloud sync | Reading updates the current position. Normal backward navigation does not reduce the frontier. Reset and cross-device conflict rules need a decision. |
| Vocabulary + chapter provenance | Reader | Device; optional cloud sync | Explicit save creates or reuses an owner/language/word learning record across books. Re-saving must not reset review progress. Keep source quotes and book/version/chapter references when available; missing source must not prevent reviewing the word. |
| Highlights + attached notes | Reader | Device; optional cloud sync | Selection creates a highlight; editing changes its note. Preserve today's `highlights.note_text`. Do not invent a second notes subsystem before its scenarios are clear. |
| Explicitly shared chapter + selected notes | Reader | Authenticated cloud storage, plus optional local record of the share | Explicit sharing creates a snapshot available to MCP. Keep it until the reader deletes the share or account, including after book deletion. Subsequent local note edits must not silently expand what was shared. |
| Insights / saved discussion conclusions | Reader | Preserve existing cloud records; local availability and sync are to be designed | Explicit save creates or updates a conclusion or chapter review. Preserve existing `book_insight` data, including after book deletion. Delete insights independently or with the account. Full conversation storage and revision history are not decided. |
| Reading sessions | Reader | Device; optional cloud sync | Reading records sessions; reconnect may upload them. Retries must not double-count time. Historical sessions need not require a surviving file. Retention remains open. |

These are domain objects, not a one-object-to-one-table commitment. Bookmarks, collections,
review questions and learning settings also need an explicit disposition before their storage is changed.

### Identity and locations

A content hash can identify identical bytes; it is not sufficient as the identity of a user's library
entry. Two readers may own the same file and have different progress, notes and permissions.
An updated edition may have a different hash while representing the reader's continuing book.

Owner decisions (2026-10-28):

- Use a file-content hash to detect byte-identical imports within the reader's library. Offer to open
  the existing book or cancel; replacing identical bytes adds no value. This does not expose other
  readers' files or library entries.
- Matching title and author suggest a possible duplicate, not proof. Offer to add separately, explicitly
  replace the selected book, or cancel. A different edition is added separately by default. A filename
  alone does not establish book identity. Text-similarity matching is deferred.
- Explicit replacement retains the library identity, vocabulary, notes and saved discussions.
  Preserve highlights with their original quoted text and source-version provenance. Reuse positions
  and annotation anchors only when compatibility is verified; do not silently discard or misattach data.
- Cancellation leaves the existing book unchanged. No silent overwrite.

The exact hash, metadata normalization and changed-content compatibility checks still need a PDD.
Repackaging an EPUB can change its byte hash without changing the readable text; that is an accepted
limitation of the initial duplicate detector.

Owner decision (2026-10-29): after successful explicit replacement, retain only the current file bytes.
Preserve old-version hashes, quotations and notes. Retain previous bytes until the new copy and version
switch succeed; clean up superseded bytes separately and retry failures. Reading an old annotation in
its original file context requires reimporting that version. Backup and offline-device cleanup policies
remain separate.

Candidate model: owner-scoped book identity, a separate file version, and versioned locators.
The exact identifiers remain open. Chapter slug and number alone are not stable across file versions.
EPUB text locations and PDF page/reflow locations must remain distinguishable. Preserve quote/context
fallbacks where supported; do not promise automatic remapping after a replacement.

## Optional cloud sync

Without an account, imported files and locally created reading data stay on the device.
An external translation service may still require a network connection; local reading does not imply
that every assistance feature works offline.

Owner decision (2026-10-28): signing in enables sync of progress, vocabulary and notes by default.
Original file sync is a separate opt-in. These defaults do not authorize MCP chapter sharing.

- Default after sign-in: reading progress, vocabulary and notes with their attached highlights.
- Opt-in: original book files.
- Supporting library metadata, review history, frontier and locally created insights: exact sync payload
  and defaults still need specification. Preserve existing cloud insights regardless.

Without file sync, metadata and reading data may reach another device without the readable file.
Do not present such an entry as downloaded or immediately readable; file matching and import need
their own contract. Accountless reading remains local.

Signing in must not implicitly share chapter text with MCP. Conversely, sharing one chapter must not
require uploading the complete book. No upload means no promise of cloud recovery of a lost local file.

Before implementing sync, define guest-to-account merge, duplicate imports, concurrent edits,
deletions and stale-client writes. “Latest timestamp wins” alone is not a complete policy for progress,
frontier or annotations. No CRDT or generic sync framework is selected here.

## Reading and MCP stories

1. **Read without losing the flow.** Import a book, open it, tap an unfamiliar word and save its meaning.
   On later encounters, the intended experience is an inline translation; vocabulary review can wait.
2. **Discuss after a chapter.** Usually the reader finishes a chapter, explicitly shares its text and
   selected notes, then discusses it through MCP. The complete book is not required for that share.
3. **Return after a break.** Retrieve the last position and saved interpretations, personal conclusions
   and open questions. A plot summary alone does not preserve the value of previous discussions.
   Recap is available before continuing; it is not a mandatory step on every open.

The cloud share lets an authorized MCP client retrieve context even when the reading device is
offline. Access must be owner-scoped. A share does not authorize access to other chapters or books.
Spoiler protection must distinguish what was shared from how far the reader has read.

Sharing is explicit; subsequent updates need an equally clear boundary. Whether an update replaces
the snapshot or creates a revision remains open. Deleting TextStack content cannot be presented as
deleting a copy already sent to an external assistant. Backup retention is a separate policy.

Saved insights are valuable independently of the original chapter text. Existing assistant conversation
history and memory can contribute additional context; TextStack does not automatically possess them.
Do not claim to reproduce that experience from saved insights alone. The final notes UX, full chat
storage, version history and automatic summaries remain outside this decision.

Owner clarification (2026-10-29): the goal is for later discussions to consider earlier thoughts,
not primarily to reread a complete transcript. Full chat storage is therefore not a prerequisite.
Proposed first approach: preserve saved interpretations, personal connections, conclusions and open
questions with book/chapter provenance; retrieve relevant entries as context for the next discussion.
Distinguish the reader's views from assistant interpretations. Do not replace previous entries silently
with a new summary. Owner decision (2026-10-29): keep checkpoints as separate entries rather than
continuously replacing one discussion summary. The capture interaction, content format and retrieval
policy remain proposed; external assistant history is not assumed available. See the
[checkpoint PDD](mcp-discussion-checkpoints.md) for the proposed contracts and slices.

Owner requirement (2026-10-29): discussion continuity must not rely solely on remembering a final
"save" command. Proposed flow: opt into periodic meaningful checkpoints during the conversation;
each stores prior thoughts/open questions and where the discussion stopped, with a visible save result.
Owner direction: the saving preference is per book. Initial context retrieval stays book-scoped;
account-wide discussion memory and cross-book inference are not prerequisites.
This discussion checkpoint is separate from reading progress. Do not mark a chapter read merely
because it was discussed. An external MCP host must actually invoke the save tool: closing a chat
does not guarantee a final callback, and unsent conversation cannot be recovered by TextStack alone.
Capture frequency and the compatibility design remain open; current `save_insight` replaces the
same chapter's entry and must not be assumed to append independent checkpoints.

Vocabulary management through MCP is also required. Code inspection (2026-10-29) found existing
`list_my_vocabulary`, `add_vocabulary_words`, `update_vocabulary_word` and `delete_vocabulary_word`
contracts in `backend/src/Contracts/Mcp/McpManifest.cs` and handlers in the MCP tool catalog.
The connected tool inventory in this chat currently exposes listing but not those three write tools;
deployment/client discovery parity is unverified. Preserve these capabilities rather than rebuilding
them blindly. Current add skips existing words; V2's additional-example behavior is a separate gap.

## External discovery

External discovery, such as a public-domain feed or OPDS-like source, hands a file to import.
It is a separate feature, not a replacement SEO catalog or a reason to restore catalog tables.
Search within the reader's own books is also a separate requirement. No discovery provider or search
indexing architecture is selected here.

## Current versus target

Current behavior is documented in [open and resume](reader-open-resume.md), with source-evidence
labels and runtime limitations, and the dated [database inventory](data-model.md).

| Area | Current state | Proposed V2 target |
|---|---|---|
| Book model | Catalog editions and personal uploads coexist | One owner-scoped personal library model |
| Chapter content | Backend extracts and stores chapters | Local readable file; cloud chapter content only for explicit shares or separately approved processing |
| Opening offline | Mobile has downloaded chapter storage; web bootstrap still has network dependencies | Imported, retained files open locally on supported clients; verify browser storage limits separately |
| Progress | Catalog rows versus upload columns; different entry-point precedence rules | One documented position/frontier model and conflict policy |
| Annotations | Some records reference editions, others uploads | Owner book/version provenance; preserve text and notes during conversion |
| Vocabulary provenance | Catalog chapter references; upload provenance has gaps | Source quote plus optional versioned chapter reference |
| MCP | Catalog tools and personal-book tools | Explicit shares and owner reading data; preserve existing discussion scenarios during transition |
| Insights | Existing `book_insight`, including chapter reviews | Preserve data and meaning; notes redesign deferred |
| SEO / multisite | Catalog frozen; legacy structures remain | Retire within V2 after data and client transition is verified |
| Data access | EF and Dapper coexist; insights pilot complete | Move surviving modules incrementally; do not port tables scheduled for removal |

This table describes direction, not implemented behavior or runtime verification.

## Is interim catalog materialization needed?

**No standalone interim migration is planned.** Catalog → today's `user_chapters` → local files and
explicit shares would introduce two transitions for highlights, vocabulary and insights.
The deferred [ADR-027](adr/ADR-027-retire-public-catalog.md) and
[retirement plan](catalog-retirement-plan.md) remain research inputs, not an executable V2 plan.

Reuse their inventory, migration ledger concept, retry/rollback tests, old-client write matrix and MCP
parity scenarios when designing the actual cutover. Revalidate them against the chosen target.
An ADR commit records a proposal; it does not by itself accept its schema or authorize deletion.

The main unresolved gap: a catalog reader needs a readable file on the device. Many Standard Ebooks
imports have no original in application storage; the source folder may or may not survive.
There is currently no EPUB builder. Check original availability before selecting a migration method.

Candidates to evaluate are recovering the original, obtaining a matching edition, or generating a file
from retained content. A different edition can invalidate positions and annotations. Temporary legacy
access is a fallback to assess, not a new permanent server chapter model. Missing files never justify
silently dropping a reader's existing data. Archive and old-client support gates still apply.

## Candidate server tables — not accepted

Current consolidated proposal: [V2 schema overview](v2-schema-overview.md), **23 baseline tables**
including existing auth, transitional insights and diagnostics. Optional retained features can add tables.
The approximate 20-table guide does not require merging unrelated lifecycles.

Nine-table review: [library, vocabulary and MCP discussion](v2-library-draft.md) and
[SQL draft](v2-library-draft.sql). Neither is an executable migration.

Start from aggregate ownership, not the current EF `DbSet` count. Names below are working labels;
existing `book_insight` and `review_question` are named to make preservation explicit.

| Area | Candidate tables | Count |
|---|---|---:|
| Personal library | `books`, `book_files` | 2 |
| Reading | `reading_state`, `reading_sessions` | 2 |
| Annotations | `annotations` (highlights, attached notes; bookmark representation open) | 1 |
| Vocabulary | `vocabulary_words`, `vocabulary_examples`, `vocabulary_reviews` | 3 |
| Shared context | `shared_chapters` | 1 |
| Saved understanding | `discussion_checkpoints`, `book_insight`, `review_question` | 3 |
| **Reader subtotal** | | **12** |

This subtotal omits auth, collections and diagnostics; the overview counts them explicitly.
Retained settings, jobs and other operational needs must also be visible rather than hidden by the target.
The migration runner's `schema_migrations` is excluded; application-owned operational tables are not.

Before schema approval, map every existing table to retained, replaced or retired behavior, including
collections, goals, achievements, tutor state, ingestion/quality jobs and LLM traces. No deletion of
those features is approved here. Do not collapse unrelated security or domain records into an opaque
JSON table merely to reach 20. Any consolidation needs its own lifecycle and query justification.

## Next bounded slice

Owner decision (2026-10-29): first test a ready-made EPUB parsing/rendering core in an
[isolated prototype](epub-engine-prototype.md). This precedes the production local-import PDD below;
it does not authorize replacing the current reader. Validate the distinctive reading features before
building import infrastructure around either engine.

Current import gap and preserved behavior: [EPUB import audit](epub-import-v2-gap.md)
(2026-10-29, code inspection only).

Existing behavior to preserve, verified by code inspection (2026-10-28), not a runtime check:
`packages/shared/src/reader/newerPosition.ts` already defines adopt/move/prompt decisions for a newer
remote position. A different chapter always prompts. In the same chapter, it adopts before local
restore, moves silently if the reader has not moved, and prompts after the reader moves. Mobile uses
this in `useReaderPersistence`; web reader consumers use the same shared decision function.
Treat this as retained behavior, not a new feature. Any change to the silent same-chapter cases needs
an explicit decision. The current trace is in [open and resume](reader-open-resume.md).

Owner-confirmed scope (2026-10-28): start with local EPUB import. Preserve existing PDF support
without redesigning it in this slice. This is not permission to remove PDF behavior or force PDFs
through EPUB-specific identities and locators.

The working import story for the PDD:

1. Select an EPUB on the device.
2. Retain an application-owned local copy so deleting the source from Downloads does not break reading.
3. Validate the file, apply the duplicate policy, and extract title, author, cover and table of contents.
4. Make the imported book readable without an account or network connection.
5. If file sync is enabled, upload in the background; upload failure must not block local reading.

On the web, persistence is subject to browser storage limits and eviction. Do not promise permanent
retention without defining the supported storage and recovery behavior. Invalid-file handling, partial
imports and optional-metadata failures need explicit acceptance cases in the PDD.

Import recommendations for that PDD, not additional accepted requirements:

Owner decision (2026-10-28): after a successful single-book import, open the book immediately.
After a multi-book import, show the library. This interaction rule does not add batch-import
implementation to the first slice.

- If the title is absent, use the source filename without its extension. Missing author or cover should
  not by itself block reading; retain a usable placeholder rather than requiring enrichment.
- Do only the parsing needed to register and open the book. Whether table-of-contents extraction must
  finish during import or can wait until opening needs an explicit performance decision.
- Preserve the selected duplicate/replacement policy. More elaborate automatic metadata-based merging
  is not part of the initial slice.


Review the remaining lifecycle and identity questions with the owner. Default sync of progress,
vocabulary and notes is decided; the exact payload and merge policy remain open. Book deletion
preserves shares and insights; their storage must not require a surviving library entry.
After evaluating the prototype, write one PDD for **import → open → resume a local EPUB**, mapping current behavior and preserved
features to the proposed identities and locators. PDF gets an explicit compatibility boundary, not
accidental EPUB assumptions. Do not choose an engine by table design alone.

Test plan for that future slice: retained-file offline open, reopen at the same location, backward
reading without frontier regression, replacement-file mismatch, and owner isolation for any cloud
records it uses. Runtime device checks must be distinguished from code inspection.

Acceptance for this documentation slice: ownership and lifecycle are visible; current and target are
separate; unresolved choices are named; no code, schema or destructive migration is authorized.
Do not create implementation issues, migrate another table to Dapper or start catalog deletion from
this document alone.

## Open questions

1. Book deletion: what happens to progress, annotations and vocabulary provenance?
2. Supporting sync data: metadata, frontier, review history and locally created insights?
3. Identity/locators: exact identifiers and replacement compatibility checks?
4. Checkpoints: opt-in scope, storage and compatibility with existing insight/review tools?
5. Which catalog originals survive; how can missing ones become readable files?
6. Which existing features survive, and what does the complete schema count actually include?
7. Old clients, conflicts and account deletion: what are the supported transition and retention rules?
