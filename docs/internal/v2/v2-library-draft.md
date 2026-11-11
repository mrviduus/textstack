# V2 library, vocabulary and MCP — SQL discussion

**Status: Discussion · 2026-10-29.** Reviewable [SQL draft](v2-library-draft.sql), not an executable
migration. No database was accessed or changed. Existing PDF support and production tables stay intact.

## Nine responsibilities

| Table | Question it answers |
|---|---|
| `books` | Which personal library entry is this? |
| `book_files` | Which exact EPUB bytes/version does it refer to, and is there a cloud copy? |
| `reading_state` | Where did the reader stop, and how far have they reached? |
| `annotations` | What passage was saved and what note was attached? |
| `vocabulary_words` | Which word is the reader studying, and when is its next review? |
| `vocabulary_examples` | Where was that word encountered, and what did it mean there? |
| `vocabulary_reviews` | What happened in each completed review? |
| `shared_chapters` | Which chapter text and selected notes were explicitly shared? |
| `discussion_checkpoints` | Which thoughts, conclusions and questions should the next discussion remember? |

The draft is a server model for synced records. Accountless local reading creates no server rows.
Client-generated ids allow future account linking without inventing a server-first import prerequisite.
Local SQLite/browser storage is a separate design; PostgreSQL SQL is not copied into clients.
The proposed `books.checkpoint_saving_enabled` flag defaults off and records opt-in per book.
It does not guarantee an external MCP host will call the save tool.

## Domain stories

1. **Import offline:** retain an EPUB locally, assign a book and file-version identity, open through
   the candidate core. No API or database transaction is required.
2. **Sign in and sync reading data:** register book/file metadata so progress and annotations have
   stable references. The file's server storage key stays null while file sync is disabled. Another device
   still needs matching file bytes to read the book.
3. **Continue reading:** update current location for that file version. Keep the frontier when moving
   backward. Remote-newer-position UI remains existing behavior; conflict resolution is not chosen here.
4. **Replace EPUB explicitly:** retain the library identity, register/select a file version and preserve
   annotations on their original versions. Reset incompatible progress. Do not display old anchors
   on changed text merely because the book id is unchanged. Version switching needs one transaction.
   Owner decision (2026-10-29): retain only the current file bytes after replacement; keep old-version
   hashes, quotations and notes. Do not remove previous bytes until the replacement is durably retained
   and the version switch succeeds. Metadata transactions and file cleanup are separate operations;
   cleanup must be retryable. Opening old annotations in their original context requires reimporting
   that exact file version. No automatic reattachment is promised.
5. **Preserve old material:** the owner permits resetting legacy positions and retaining old highlights
   as unanchored quotations. `locator` and `file_id` may be null; the quote and note remain accessible.
   Legacy-to-CFI migration is no longer a prerequisite.
6. **Remove a book:** owner decision (2026-10-29): retain a hidden library record with its title and
   provenance so saved quotations, notes and discussions still identify their source. `removed_at` is
   the candidate implementation. Keeping this metadata does not require retaining original file bytes.
   Deleting local/cloud bytes and eventual metadata purging need separate policies. Future shares and
   insights survive book removal as already decided.

## Why these boundaries?

- A book id represents the owner's entry; a hash represents bytes. Neither replaces the other.
- A file metadata row does not force uploading the file or storing extracted chapters.
- Progress is frequently updated; keeping it separate avoids rewriting book metadata on every scroll.
  This costs one table versus embedding progress in `books`, but makes file-version binding explicit.
  Owner decision (2026-10-29): use a separate `reading_state` table for current position and frontier.
  Exact columns, sync rules and the rest of this SQL draft remain under discussion.
- An annotation's note stays with the quotation. No separate notes table for this slice.
- Composite foreign keys reject references to another owner's book or file. API owner filtering is
  still required, including for deletes and bulk operations.

The draft records hashes as lowercase SHA-256 for discussion, consistent with the tested prototype.
No global file deduplication or matching by title is implied. Simultaneous duplicate imports still need
an owner-scoped write protocol; an index for lookup alone does not prevent races.

## Deliberate gaps

This is **nine candidate application tables**, plus the existing `users` dependency. See the
[consolidated schema overview](v2-schema-overview.md) for the proposed full baseline. Roughly 20 tables
is a simplicity guide, not a hard cap. Bookmarks, independent notes, collections, learning, MCP, authentication
and operational requirements need their own disposition; no existing feature is silently removed.

CFI/quote validation, locator envelopes, precise frontier/spoiler semantics, default sync payload,
conflict handling, deletion acknowledgments and tombstone expiry are not solved by these columns.
Returning to an earlier file version must not resurrect discarded progress accidentally.

`server_storage_key` describes a retained server file, not upload job state or an absolute OS path.
The initial provider is a filesystem on persistent server storage; S3 is not required. File upload retries,
deletion and orphan cleanup need a separate storage lifecycle. Old-version metadata stays while old
bytes are removed after a successful replacement. Offline-device cleanup and backup retention still
need explicit policies; this is not a promise of immediate erasure everywhere. Hard-deleting a book cascades these candidate records and therefore must
not implement the user-facing remove action while saved quotations are meant to survive.

## Checks required before implementation

- PostgreSQL integration: reject cross-owner book/file references and two current files for one book.
- Transactional replacement: failure keeps the previous active file and state intact.
- Notes-only sync: metadata/progress/annotations round-trip with no cloud file object.
- Preservation: legacy quotation without a locator remains readable; book removal keeps it accessible.
- Reader runtime: new positions/highlights restore after restart; incompatible file versions are declined.
- Sync contract: retries, offline edits, deletes and reset/frontier behavior have explicit expected outcomes.

The draft was executed in isolated PostgreSQL 16.15 with generated fixtures: **32 checks passed**
after correcting deferred provenance constraints for account deletion. See the
[validation report](v2-schema-validation.md) for evidence, isolation and limitations. No existing database
was changed. Application behaviors above remain future acceptance criteria, not validated endpoints.

## Vocabulary and discussion write stories

1. **Save a new word:** create/reuse the owner/language/lowercase word card and insert its contextual
   example in one transaction. Re-saving does not overwrite the primary translation or learning state.
2. **Review:** append an answer and update the schedule atomically. Operation ids prevent a retry from
   advancing the learning state twice. Concurrent offline answers still need an explicit ordering policy.
3. **Share a chapter:** save a bounded text/selected-notes snapshot separately from file sync. A file
   need not have a server copy. The initial proposal uses immutable snapshots; an explicit re-share
   makes another snapshot, not a silent update from subsequent note edits.
4. **Save a thought:** append an attributed checkpoint with a topic and nonempty content. It can refer
   to a chapter/share or the whole book; it never writes reading progress. Repeating one operation returns
   the same entry; different content under that operation id conflicts.
5. **Delete a share:** clear its optional links from checkpoints and delete the share in one transaction.
   Saved thoughts stay; the deleted chapter payload is no longer retrievable as a share. Text already
   explicitly saved within a checkpoint remains separate content. Delete a checkpoint separately.

The application computes `payload_sha256` from a versioned canonical request representation, not from
untrusted client-supplied digests. SQL uniqueness prevents duplicate operation ids; it does not itself
compare request content or implement a safe retry protocol. Request size and structured array-item
validation are API responsibilities; JSON array/object checks in SQL are not a complete content schema.

Composite keys enforce owner/book/file relationships. Where several optional provenance fields are
provided, the application must validate their consistency with the linked share. Hidden book records
retain context after removal; ordinary book removal never invokes the draft's hard-delete cascades.

## Next slice

Owner clarification (2026-10-29): discussion continuity means later conversations account for prior
thoughts. A full transcript is not a prerequisite. Model saved understanding and its retrieval next;
do not introduce a complete chat-message subsystem before defining that smaller scenario.
Owner decision: retain separate checkpoints. Proposed MCP behavior and implementation slices are
in the [checkpoint PDD](mcp-discussion-checkpoints.md). This draft proposes a separate checkpoint table
so current `book_insight` replacement and structured-review behavior can remain intact.

Owner clarification (2026-10-29): saved vocabulary is for studying words. A book or a particular
meaning does not create a separate learning record by default. Keep one owner/language/word record
with its learning state; re-saving from another book adds context without resetting progress.
Owner decision (2026-10-29): initially use case-insensitive spelling within each source language;
`Reading` and `reading` share one card, while `read`, `reads` and `reading` remain separate.
No stemming, lemmatization or automatic grouping by meaning. Preserve original spelling in examples.
Exact language-aware case normalization and multiple-context storage still need specification.
Owner decision (2026-10-29): re-saving with a different translation preserves the card's existing
translation and learning progress. Add the new source example with its contextual translation;
do not automatically replace the card translation. This draft proposes a separate examples table.

The separate progress-table boundary is decided. Review the nine-table draft, then prepare the first
bounded implementation PDD. Existing `book_insight`, auth, PDF, operational and other optional features
are not migrated by this SQL. Selecting new book ids and transitioning legacy insight references need
an explicit compatibility plan before checkpoint tools can ship against this schema.
No mass EF-to-Dapper conversion or production cutover follows from approving the basic diagram.

## Open questions

- Accept separate examples and checkpoint tables, preserving legacy insights initially?
- Repeated identical example: retain it or deduplicate by an explicit context key?
- Deleted records: retry receipts/tombstones, retention and restore behavior?
- Chapter-share versions: accept immutable snapshots initially?
