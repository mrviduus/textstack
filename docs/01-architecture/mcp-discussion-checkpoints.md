# MCP discussion checkpoints

**Status: Proposed PDD · 2026-10-29.** Separate checkpoint entries are an owner decision.
Tool contracts, schema and implementation slices below remain proposals. Docs only; no migration.

## Goal and decisions

When returning to a book, continue from the reader's previous interpretations and open questions.
The reader should not need to remember a final save command. A complete chat transcript is not required.

- Keep meaningful checkpoints as separate entries. New thoughts do not overwrite older thoughts.
- Reading position and discussion state are separate. Discussing a chapter never marks it finished.
- Saved discussions survive book removal and can be deleted separately. Account deletion removes
  account-owned cloud content, subject to the separately defined backup policy.
- Reuse vocabulary management; learning progress and the primary translation survive repeated saves.

## Domain story

1. The reader starts a discussion about a known book and optionally a chapter.
2. The assistant retrieves earlier saved understanding and reads the explicitly shared chapter context
   available to this reader. Do not assume that TextStack has the external chat transcript.
3. The reader opts into saving meaningful checkpoints for this book, or asks for an individual save.
4. After a meaningful topic yields a conclusion, changed interpretation or unresolved question, the assistant
   saves a short checkpoint. No fixed per-message save or background timer is required.
5. Only a successful tool response establishes persistence. Show a concise confirmation; on failure,
   report that it was not saved and retry safely when appropriate.
6. On return, retrieve those entries and distinguish past thoughts from the current discussion. Earlier
   questions may now have answers; do not silently rewrite what the reader previously thought.

Owner direction (2026-10-29): checkpoint-saving preference is per book. Persist the preference so the
reader does not need to opt in on every discussion; the exact storage and disable interaction remain
proposed. This preference is separate from the scope of context retrieval. Start with that book's
saved thoughts and relevant chapter context, not account-wide discussion history. General style
preferences could be added separately later; no cross-book topic graph or global memory is required.
Opting into checkpoints does not authorize adding vocabulary, editing translations or deleting records
automatically. An external host still needs to invoke the save tool.

Closing ChatGPT may produce no final tool call. MCP cannot guarantee capture of thoughts that were
never sent. Intermediate saves reduce that gap; they do not provide full automatic transcript capture.

## Checkpoint content

Proposed minimum record:

- Owner-scoped stable book reference, plus optional chapter/file-version provenance.
- The question/topic being discussed.
- Reader thoughts, interpretations or personal connections, attributed accurately.
- Assistant suggestions, separately attributed and not presented as the reader's beliefs.
- Conclusions and open questions; omit empty sections.
- Original language, server save time and a client operation id for retry safety.

Do not manufacture sections or conclusions just to fill a template. Keep quotations distinct from
interpretation. Bound request size; this is a compact discussion record, not an unbounded transcript.
Preserve records in their original language; later discussion may use another language.

## Proposed MCP contract

Names are illustrative, not additional accepted tools:

| Operation | Contract |
|---|---|
| Read checkpoints | Fetch owner/book-scoped entries in stable order with pagination. Support optional chapter scope. Include entry ids and provenance, not raw whole-chat history. |
| Append checkpoint | Persist one entry and return its id and saved time. The same owner/operation id and payload returns the original result; changed payload with that id is a conflict. |
| Delete checkpoint | Delete only an identified owner-scoped entry when requested; preserve unrelated entries. Synchronization tombstones follow a later sync contract. |

For the first retrieval slice, use bounded chronological pages; no embeddings or vector retrieval engine.
If more history exists, return a continuation cursor rather than silently claiming the whole history was read.
Do not expose another user's entries, unshared chapter text or later-chapter material implicitly. Chapter
filtering and spoiler limits need a precise contract before implementation.

The current `save_insight` replaces an entry for the same chapter and may be blocked by an existing
structured review. It must not be reused as append without an explicit compatibility design. Keep old
callers' behavior intact until that design is approved. Existing `book_insight` data remains preserved.
The [SQL draft](v2-library-draft.sql) proposes separate `discussion_checkpoints`, retaining legacy
`book_insight` behavior during transition. No chat/session/message table family is assumed. This is
a schema proposal, not permission to create tables or break current book references.

## Vocabulary parity

Existing code contains `list_my_vocabulary`, `add_vocabulary_words`, `update_vocabulary_word` and
`delete_vocabulary_word`. Verify deployed tool discovery before implementing replacements.

- Add only words requested or agreed to by the reader. Provide language and contextual example.
- Match cards by owner, source language and lowercase spelling; retain distinct word forms.
- Existing card: preserve primary translation and learning state, add a contextual example/translation.
- Explicit update can change the card's translation/definition; an ordinary repeated save cannot.
- Explicit delete removes the selected card. Exact learning-history retention needs its own contract.

Current add skips existing cards; additional-example behavior is a known V2 gap. Example deduplication
must distinguish a retry from genuinely different contexts. Exact example storage remains open.

## Small implementation slices, after schema review

1. **Append and read checkpoints:** decide storage and legacy-tool compatibility; implement owner-scoped,
   idempotent append and paginated read, preserving existing insight/review behavior.
2. **Assistant interaction:** opt-in and save-result messaging; retrieve prior entries before discussion.
   Validate actual MCP host behavior, not only prompt wording.
3. **Vocabulary parity and examples:** verify deployed tools, then extend repeated-save behavior.

Separate deletion UI/API work only if existing saved-insight deletion cannot support independently
identified checkpoints. Do not ship persistent entries with no supported user deletion path.

## Test expectations and acceptance

PostgreSQL integration tests: two separate saves in the same chapter retain both entries; retry creates
one entry; changed retry payload conflicts; cross-owner reads/writes/deletes fail; stable pagination;
book removal preserves entries; no progress row changes; account deletion clears owned checkpoints.
Verify old insight and structured-review callers retain their existing contracts.

Vocabulary integration tests: case-insensitive duplicate, distinct language/forms, retry-safe example
addition, unchanged primary translation and review state, explicit update/delete owner isolation.

Host checks: start a discussion with prior entries; opt in; save midway; reopen and retrieve that checkpoint;
simulate failed save and confirm no false success message. End abruptly and document the unsaved tail.

Acceptance: earlier thoughts remain retrievable, retries do not multiply entries, saving never advances
reading progress, and no complete-transcript capture is claimed. No production cutover or database
change follows from this PDD alone.

## Next step and open questions

Review checkpoint storage in the [SQL draft](v2-library-draft.sql) and its
[lifecycle notes](v2-library-draft.md), then prepare only slice 1's implementation PDD.

- Per-book opt-in: storage and enable/disable interaction?
- Accept the proposed separate checkpoint table while legacy tools remain?
- Retrieval: exact chapter/spoiler boundary and default page size?
- Vocabulary: multiple-example representation and duplicate-context key?
