# Assistant handoff — the chat lives elsewhere, the conclusions live in the book

You read a book here. You discuss it in Claude or ChatGPT, where your assistant already has your
profile and a year of history. What you work out comes back and is stored against the book, so you
can return to it later by category: here is what I concluded, here is what to watch for, here is
what we argued about.

TextStack is not trying to be the chat. It is the book, the markup, and the memory of having read it.

**Status: half-built.** The write side works; the read side does not. See
[What is missing](#what-is-missing) — that gap is what the current sprint closes.

Reference for the protocol surface itself: [`mcp.md`](mcp.md). This document is the product view —
what the feature is for, what is missing, and what the sprint owes.

## Why not an in-app chat

We built six. They are scattered across the app, unfinished, and run on cheap models. Lifetime usage
to 2026-09-09: **16 conversations, 26 messages, 5 tutor sessions.**

The reasoning a reader wants cannot be reproduced here at any sensible cost, and more importantly it
should not be: the assistant that knows them lives in their own account, with their own memory. What
belongs to TextStack is the *result* — and the book to hang it on.

So the product is a handoff, not a chat:

```
TextStack                       Claude / ChatGPT
  book, progress, markup   ──▶  opening brief (a link, ≤1200 chars)
  MCP connector            ◀──▶ reads chapters, progress, highlights, vocabulary
  BookInsight              ◀──  writes conclusions back, keyed to a chapter
```

Both halves are deliberately independent. Without the connector the button still opens a real
conversation about a real book — the reader just carries the outcome back by hand.

## What exists today

| | |
|---|---|
| **MCP bridge** | 13 tools, stdio + streamable HTTP. Auth by connect key (`tsk_…`) or device flow. `textstack.app/mcp` |
| **`BookInsight`** | Conclusions written back, keyed by `(user, book, chapterSlug)`. One per target — a re-run replaces rather than accumulates |
| **`DiscussWithAssistant`** | Button on 4 screens: catalog + upload detail, web + mobile. Opens `claude.ai/new?q=…` or `chatgpt.com/?q=…` with a prepared brief |
| **`BookInsightsSection`** | Renders the conclusions on the same 4 screens |

## What is missing

**The assistant can write but cannot read.** It is told to call `save_insight` and `save_highlight`,
and it does. None of the 13 tools returns reading progress, position, a shelf, or any history.

| What the reader expects | What the system can actually answer |
|---|---|
| "It knows what I've read" | **No.** Only the title of the one book the button was on. The shelf cannot be enumerated — `search_my_library` requires a search term, so the assistant has to guess a word |
| "It knows where I am" | **Only in the opening message, and only for uploads.** Catalog screens hold the progress and do not pass it. By the second message, or the next day, the assistant is blind |
| "It knows what I'm about to do" | **No field, no tool** |

Two consequences worth naming:

- The brief names `get_my_insights` and `save_insight` and **no highlight tool at all**, so a typical
  session reads insights, writes insights, and never looks at what the reader marked.
- Position is not exposed at all. It used to leak as a refusal from `ask_book`'s spoiler gate; that
  tool is gone, so now there is nothing — an assistant cannot avoid spoiling a book because it cannot
  ask how far the reader has got. `ReadingProgress.MaxChapterNumber` still records exactly that and is
  currently write-only, waiting for `get_book_progress`.

**The conclusions have nowhere to return to.** `BookInsight` hangs on the book's spine correctly, but
there is no category field, the UI is a flat list at the bottom of one book's page, there is no
`/insights` route (unlike `/highlights`, `/vocabulary`, `/stats`), and there is no DELETE — a bad
conclusion is permanent.

## Measured on production — 2026-09-09

Counted against the live database, not estimated.

**The owner's own account (`mrviduus@`)** — the only real user of this feature:

| | |
|---|---|
| Uploaded books | 33 |
| Catalog editions with progress | 42 |
| Vocabulary words | 253 |
| Highlights | **7** |
| Reading sessions | 59 |
| **Insights written** | **0** |

**Reading progress across the whole database — 4650 rows:**

| | |
|---|---|
| Real (non-guest) users | **71 rows, 18 people** |
| Guests | 4579 rows across 4549 guests — one each, noise |
| `percent IS NULL` | **4112 of 4650 (88%)**; 2 of 42 on the owner's account |
| `position_json IS NULL` | 4641 of 4650 (99.8%) — the ADR-015 logical position is barely used in production |
| Editions with progress but **not** in `/me/library` | **2154** |
| Rows whose chapter no longer exists | **0** |

**RAG index: 7 books out of 1498** (4 catalog editions of 1423, 3 uploads of 75).

### What the numbers decide

- **Percent is a weak signal.** Two of forty-two. The dependable context is *chapter slug + date +
  title*, with percent as a bonus. Uploads are better: `user_books.progress_percent` is populated.
- **Highlights are not the win they looked like.** Seven of them. The real answer to "what have I
  read" is the shelf of 33 books and 253 vocabulary words.
- **Zero insights.** The feature shipped and has never been used, including by its author. That is
  the argument for fixing the read side first: there is nothing to write a conclusion *about* until
  the assistant understands where the reader is.
- **7 indexed books of 1498** settles the RAG question — freeze it.

## Where this stands — 2026-09-10, end of day

Four PRs merged (#596–#599) and deployed. Production is healthy; the manifest serves 13 tools;
`mcp_access_keys` exists with **0 rows** — nobody has minted a key yet, which is now a choice rather
than an impossibility.

**Proved end to end locally, not just unit-tested:** mint a key → call `POST /mcp` with it →
`list_my_vocabulary` returns the account's data, the same call without it returns "authentication
required", and `last_used_at` is stamped. That covers the bridge path
(`HttpContextTokenProvider` → `TextStackApiClient` → API), which the integration tests do not.

| Shipped | |
|---|---|
| The cut | Six chat surfaces and the whole retrieval spine, −21,846 lines across 148 files |
| `McpAccessKey` | Long-lived, revocable, SHA-256 stored; middleware above the rate limiter |
| Connect page | On `/mcp`: create a key, see it once, copy a ready-to-paste config, revoke |
| Catalog brief | Was handing tools an identifier they reject — the Discuss button had never worked |
| Web insights | Was calling an API layer the web never initialises — the конспект section had never rendered |

### What is left, in the order it should be done

1. **Mobile connect screen** — in progress on `feat/mobile-connect-screen`. The key is
   account-level, so one minted on the phone works in Claude Desktop too, and vice versa.
2. **The three read tools** — `get_my_reading` (build on the existing `GET /me/library/shelves`),
   `get_book_progress`, `set_book_progress`. This is the actual ask: "Claude should know what I've
   read and where I am". Today it knows neither past the opening message.
   Note `ReadingProgress.MaxChapterNumber` is write-only until `get_book_progress` exists.
3. **Insight categories** — *Conclusions · Watch for · Discussed · Questions*, tabs in the book, and
   DELETE (there is none; a bad conclusion is permanent).
4. **Mobile `Linking.openURL`** still swallows its failure — no app installed means a tap does
   nothing at all.
5. **Tutor's wiring** — `ExerciseType` is rendered as a badge while `ReviewCardBuilder` emits
   `multiple_choice` unconditionally, so the plan never changes the session. It also lost
   `get_example_sentence` with the RAG cut; `VocabularyWord.Sentence` already holds the sentence a
   word was saved from, so restoring that needs no retrieval.
6. **Tech debt, recorded and deliberately untouched** — ten progress-path defects (`LocatorKind` on
   the catalog path, web and mobile writing different mark-as-read locators, `ReadingProgressDto`
   mirrored twice in TS, `MayReplace` refusing a write and reporting success) plus five web modules
   that were already dead before this work. All in `STATUS.md`.

### Only the owner can do these

- **Do the Claude and ChatGPT mobile apps accept custom MCP connectors?** Item 1 above is worth
  building either way (the key is account-level), but item 4 and the mobile half of the product
  depend on the answer.
- **Mint a key on textstack.app and hold a real conversation about a real book**, then check the
  conclusion comes back. Every test so far has used an empty throwaway account.
- ~~Android developer verification~~ — **already done**, verified in the console 2026-09-10:
  `app.textstack.mobile` is Registered with both signing keys, last updated 2026-05-15, and Identity
  is filled from the developer account. The September notification is informational; it was read as a
  to-do here in error. **Do not re-raise it** — the earlier wording here has already misled one agent
  into reporting it as an urgent deadline.

### Left behind by the cut — ~~a follow-up~~ done in PR #597

Removing the chat left inert plumbing on the mobile side: `apps/mobile/src/lib/sse.ts` and
`sseParser.ts` (+ its test), `ReaderShell`'s `citationChapterSlug` / `makeSnippet` imports and its
permanently-null `pendingCitationRef`, `packages/shared/src/reader/citation.ts`, and the `AskCitation`
/ `AskResponse` / `AskTurnDto` / `AskTarget` types. **All removed in #597** — verified 2026-09-10:
every one of those names now has zero references anywhere in `apps/` or `packages/`, and the files
are gone. The list is kept struck through rather than deleted because the reasoning (the web's own
`lib/sse.ts` is NOT dead — `useExplain` still streams through it) is the part worth not re-deriving.

### Found while cutting — decisions still open

1. ~~**`GET /books/{slug}/similar`**~~ — **decided: deleted.** The rail was fed by
   `editions.embedding`, and **4 editions of 1423 had one**, so it was already blank on 99.7% of book
   pages. It was the only reader-facing thing in the cut, which is why it was put to the owner rather
   than assumed. If similar-books is wanted back, genre + author + FTS would serve all 1423 rather
   than four, and would cost nothing to run — that is a small build, not a restore.
2. **Three tools are RAG-backed and two of them serve things that stay.**
   `SearchBookTool` (`search_book`) is reachable from Explain via the `EarlierReference` signal;
   `GetExampleSentenceTool` is in Tutor's tool list; `FindEarlierDefinitionTool` has no live caller.
   Explain's tool-calling path last fired **2026-06-13**, three months ago, so losing `search_book`
   costs little in practice — but it means `BookToolSignal.EarlierReference` maps to nothing
   afterwards.
3. **Tutor loses its grounded example sentence.** Removing `get_example_sentence` leaves the plan
   without a worked example on a miss. Worth noting that `VocabularyWord.Sentence` already stores the
   sentence the word was saved from, so the same capability is available with no retrieval at all —
   that is a rewire, not a deletion, and it is not in this pass.
4. **`RagIndexStatus` columns sit on both `Edition` and `UserBook`** (7 columns each). Dropping them
   is a second migration and touches DTOs both clients read.

## Sprint TODO

| # | Item | Slice |
|---|---|---|
| 1 | ~~`get_my_reading` — the shelf, over the existing `GET /me/library/shelves`~~ — shipped 2026-09-10 | 1 |
| 2 | ~~`get_book_progress` — where am I in this book~~ — shipped 2026-09-10 | 1 |
| 3 | ~~`set_book_progress` — record progress made on another medium~~ — shipped 2026-09-10 | 1 |
| 4 | ~~`chapterSlug` on `LibraryShelfItemDto` — the service already selects it~~ — shipped 2026-09-10 | 1 |
| 5 | ~~Restore `chapterId` to the `get_book` projection (defect 2 below)~~ — shipped 2026-09-10 | 1 |
| 6 | ~~Validate the chapter slug on upload progress writes (defect 1)~~ — shipped 2026-09-10 | 1 |
| 7 | ~~Stop reporting success when `MayReplace` refused the write (defect 3)~~ — shipped 2026-09-10 | 1 |
| 8 | Brief names highlights and vocabulary, within the 1200-char budget | 1 |
| 9 | Catalog screens pass progress into the handoff | 1 |
| 10 | Mobile handoff stops swallowing the open failure | 1 |
| 11a | ~~DELETE for an insight~~ — shipped 2026-09-10, reader-only, no MCP counterpart | 2 |
| 11b | ~~Insight categories~~ — **not being built**, owner chose per-book retrieval; see below | 2 |
| 12 | Hide the six chats and the RAG UI behind a flag | 3 |
| 13 | One mark-as-read locator across web and mobile (defect 4) | later |
| 14 | `LocatorKind` + `MayReplace` on the catalog path (defects 5, 6) | later |
| 15 | `markAsUnread` should lower `MaxChapterNumber` (defect 7) | later |
| 16 | Delete the chats for real | 2–3 weeks |

**Slice 1 needs no database migration.** The routes it needs are already written and simply not
wired to MCP — including `GET /me/library/shelves`, which already returns titles *and* progress for
uploads and catalog books in one response and which no MCP tool calls.

## What this does to the architecture

The bet changes the shape of the backend: **inference moves out, data access stays.** An MCP tool is
not an agent — it is an HTTP call to the same public API the web app uses. The bridge holds no DB
context, no EF, no OpenAI client. So the thing being retired is the *orchestration layer*, not the
data layer, and what replaces it is ordinary REST plus a thin translator.

```
before   reader → in-app agent → ILlmService → OpenAI/Ollama → tools → DB
after    reader → Claude/ChatGPT → MCP bridge → public HTTP API → DB
                  └── inference paid for by the reader's own subscription
```

### The AI code, measured

`backend/src/Ai/*` is 167 files / ~11,400 lines; the AI-shaped folders under `Application/` add
~6,000 more.

| | files | lines |
|---|---:|---:|
| `Ai.Mcp` | 20 | 3,150 |
| `Ai.EvalSuite` | 38 | 2,963 |
| `Ai.Llm` | 25 | 1,988 |
| `Ai.Rag` | 21 | 1,222 |
| `Ai.Core` · `Ai.Agents` · `Ai.Tools` · `Ai.Evals` | 63 | 2,110 |
| `Application/Agents` | 29 | 2,259 |
| `Application/Tools` | 20 | 1,646 |
| `Application/Ai` | 18 | 1,366 |
| `Application/Rag` | 6 | 694 |

### The LLM stack cannot be deleted — it is load-bearing well outside chat

`ILlmService` has 50+ call sites. Only a minority are the reader-facing chats. Everything below stays
regardless of what happens to the chat surfaces:

| Consumer | What it powers |
|---|---|
| `TranslationEndpoints` · `ExplainEndpoints` · `DictionaryEndpoints` | Translate and Explain in the reader |
| `Vocabulary/DistractorGenerator` | **Vocabulary SRS** — distractors, hint, explanation per saved word (Ollama) |
| `Worker/BookMetadataGenerator` | Genre, year, description generated on every upload |
| `Worker/TagSuggestionGenerator` · `PodcastScriptBuilder` | Tags; podcast scripts |
| `Infrastructure/Rag/PdfVisionParser` | **PDF ingestion** (ADR-012) — the core reading path for half the library |
| `Application/Agents/{AutoPublish,Seo,Field}Crew`, `Drafter/Critic/Editor/Researcher` | **SEO auto-publish and backfill** — not reader chat at all |
| `AdminSeoBackfillEndpoints` · `AdminAutoPublishEndpoints` | The admin side of the same |

Of the 29 files in `Application/Agents`, only `LibrarianAgent`, `TutorAgent`, `StudyBuddyAgent` and
their result types are reader chat. The rest is the publishing pipeline.

### What actually retires

| Goes | lines |
|---|---:|
| `BookChatEndpoints` | 649 |
| `TutorEndpoints` | 413 |
| `StudyBuddyEndpoints` | 183 |
| `LibrarianEndpoints` | 110 |
| `AskEndpoints` · `UserBookAskEndpoints` | 195 |
| `Application/BookChat/*`, the three chat agents | — |
| `Application/Tools/*` — the in-app tool implementations MCP replaces | ~1,600 |

`Application/Tools` is the interesting one: `GetChapterTool`, `SearchLibraryTool`,
`GetUserVocabularyTool` and the rest are the in-app equivalents of MCP tools. Two implementations of
one idea; MCP is the one with a client worth having. Exceptions to keep: `ReadingProgressGate`
(the spoiler gate `ask_book` still uses), `ExternalTextSanitizer`, `ChapterLabel`.

**RAG stays frozen rather than deleted**, because `ask_book` is an MCP tool and runs on
`RagAskService`. Index endpoints (`BookIndexEndpoints`, `UserBookIndexEndpoints`) stay with it. If
`ask_book` is later dropped too, `Ai.Rag` + `Application/Rag` + the chunk tables + `ChapterEmbeddingWorker`
go together — but 7 indexed books of 1498 means nothing is lost by leaving it switched off first.

### The tension worth stating out loud

This stack is also the **AI portfolio** — phases 1-9 plus the RLOps work — and it is the source
material for the articles. Evals (`Ai.EvalSuite`, 2,963 lines) exist to measure the very features
being retired: `TutorEvalRunner`, `StudyBuddyEvalRunner`, `RagEvalRunner`, `CrewAbEvalRunner`.

Deleting the features deletes the thing the writing is about. Two honest options: keep the eval suite
as an artefact and let it go stale, or write the retirement up as the article — "we built six chats,
measured 26 messages, and replaced them with a protocol" is a better piece than another eval run.
That is a decision for the owner, not a code question.

### One thing the cut did NOT remove

**pgvector stays.** The `DropRagSpine` migration drops the two chunk tables, `editions.embedding` and
its HNSW index — not the extension. Vector columns are still live on `vocabulary_words.embedding`
(concept clustering) and on the drift centroids, so `Pgvector` and `Pgvector.EntityFrameworkCore`
remain referenced by `Infrastructure`. Anything that reads "pgvector is gone" is shorthand for the
retrieval vectors, not the type.

## Defects found along the way

These exist independently of this feature; they were found while tracing it. Also listed in
[`STATUS.md`](../STATUS.md).


1. ~~**No slug validation on upload progress writes.**~~ Fixed 2026-09-10: the write is checked
   against `UserChapters` for that book and an unknown slug is refused, the way `AddBookmarkAsync`
   always has been.
2. ~~**Catalog MCP tools drop `chapterId`.**~~ Fixed 2026-09-10 for `get_book`, which is the one
   `save_highlight`'s description names and the one `set_book_progress` needs to resolve a slug to
   the GUID the catalog route requires. `get_chapter` still projects without it — it carries the
   chapter the caller already asked for by slug, so nothing is unreachable through it.
3. ~~**A refused write reports success.**~~ Fixed 2026-09-10: the refusal returns `(false, …)` and
   the endpoint answers 400 with the reason, so `set_book_progress` reports a failure instead of
   telling a person their progress was recorded.
4. ~~**Web and mobile write different locators for the same action.**~~ Fixed 2026-09-10. The
   sentinels are now one definition — `PROGRESS_LOCATOR_END` / `_START` in
   `packages/shared/src/reader/progressLocators.ts` — and mobile's "mark finished" goes through
   `markProgressFinished` instead of sending `scroll:<lastSlug>:0`, which reopened a finished book at
   the top of its last chapter.
5. ~~**The catalog INSERT branch stores `Percent` with no unit check.**~~ Fixed 2026-09-10: the
   insert builds an empty row and hands it to `ApplyProgressUpdate`, the same method the update path
   uses, so there is one copy of the rule instead of two that had already drifted. It also fixes a
   second consequence nobody had named — a book finished in a single write never got a `CompletedAt`.
   Covered by `ProgressUnitEndpointTests`, which fails against the old build.
6. **The catalog request has no `LocatorKind`** and never calls `LocatorSpace.MayReplace`.
   **Deliberately not fixed, 2026-09-10.** The guard exists because an upload can be read two ways —
   Original-layout PDF (`page:<n>`) and reflow (`scroll:…`). A catalog edition has no PDF and no
   second space, so there is nothing for the guard to protect. Worse, it would break what it was
   meant to protect: `MayReplace` refuses any write whose locator belongs to no space, and
   `{"type":"end"}` — the mark-as-read sentinel both clients now write — is exactly that. Revisit
   only if catalog books ever render as originals.
7. **`markAsUnread` never lowers `MaxChapterNumber`** — **moot since 2026-09-10.** The only reader
   of that column was the RAG spoiler gate, which was deleted with `ask_book`. It is now written by
   two code paths and read by none: a drop candidate, not a bug. Left in place because dropping a
   column on a production table to delete a value nobody reads is the more expensive mistake.

8. **An untrusted percent unit is discarded silently** — `ProgressUnit.IsTrusted` false, the write
   succeeds, the number is absent, no error is returned. **Kept**, and the reason is in `ProgressUnit`
   itself: the callers that omit the unit are installed builds that cannot act on an error and would
   retry into it. What changed on 2026-09-10 is that the one caller who CAN act — an assistant over
   MCP — always declares `"book"`, so it never lands in this branch. The refusal that *is* worth
   reporting (`MayReplace`) now is.
9. ~~**`ReadingProgressDto` is mirrored twice in TypeScript.**~~ Fixed 2026-09-10: web imports the
   shared type and re-exports it, so the twenty-odd `from '../api/auth'` imports keep working against
   one definition.
10. **`ReadingProgressDto.ChapterSlug` lags under infinite scroll** (#496/#500/#501), which is why
    `continueReading.ts:150` prefers the locator via `resumeChapterSlug`. Anything reading the slug
    directly reads a stale value.

## Decisions taken by the owner — 2026-09-10

**The in-app chat goes.** The owner's stated reason was cost. Measured afterwards, that reason does
not survive — but the decision does, for a better one.

### Lifetime LLM spend, measured 2026-09-10: $4.39 total

| feature_tag | calls | USD |
|---|---:|---:|
| **`pdf.parse`** (vision PDF transcription) | 1470 | **$4.1406 — 94% of everything** |
| `rag.ask` | 62 | $0.1482 |
| `bookmeta.agent` | 232 | $0.0412 |
| `eval.judge` | 405 | $0.0216 |
| `rag.summarize` | 51 | $0.0168 |
| `explain.toolcall` | 180 | $0.0112 |
| `tutor.agent` · `librarian.agent` · `studybuddy` | 86 | **$0.0097 combined** |
| `translate` · `explain` · `podcast.script` | 121 | $0.0037 |
| `distractor` · `bookmeta` · `tagsuggestion` | 840 | **$0.0000 — Ollama, local** |

**The six chat surfaces cost 16 cents over their entire life.** Cost is not an argument against them.

The expensive thing is the *preparation* — vision transcription of PDFs so a book can be asked
questions at all: $4.14 across 1470 calls, which bought 7 indexed books out of 1498. A batch sweep
over the 75 uploads multiplies that by an order of magnitude, irreversibly and up front.

### So the real argument is this

Our chat is worse than what the reader already has, and making it good would mean **paying for
indexing** — the one line item that is actually visible. The handoff sidesteps exactly that: an
outside assistant reads `get_my_chapter` as plain text and needs no index at all.

Consequences:

- Book Chat retires. The "keep one live streaming surface as an interview demo" option is declined.
- **Vision RAG loses both its justification and its only consumer.** `PdfVisionParser` is called from
  exactly one place — `BookChunkingService.cs:397` — and the reader never touches it: PDF text for
  reading and search comes from `PdfPageTextExtractor` / `PdfTextExtractor`, deterministic and
  LLM-free, covered in CI by `TextStack.Extraction.Tests`.
- The connector stops being a convenience and becomes the product: if inference happens in the
  reader's own client, the connector is the only thing that makes the book reachable at all.
- **Tutor is removed from the retirement list.** It is not a chat and not expensive — a bounded
  ≤4-iteration agent with a hard cost cap, $0.0038 lifetime. It is the one AI surface sitting on the
  product thesis: it joins due SRS cards, weak words and *recent reading* into one study plan, which
  `SrsEngine` cannot do because it schedules on interval alone. Its value is currently blocked by one
  wiring gap, not by its concept — `TutorPlanItem.ExerciseType` is rendered as a badge while
  `ReviewCardBuilder` emits `multiple_choice` unconditionally, so the plan never changes the session.
  Open sub-question: whether the selection needs a model at all, or is a query over
  `VocabularyWord.BookTitle` + SRS stage plus one generated sentence.

**Deferred by the owner:** tester recruitment and the Play production gate are out of scope.

## Open questions

1. **Do the mobile Claude and ChatGPT apps support custom MCP connectors?** Unverified, and it gates
   the entire mobile half: without connectors the phone gets a brief with no access to the book. The
   slice-1 tools are needed by every client either way, so they are not blocked on this.
2. **Hide the six chats or delete them outright?** Currently planned as hide-behind-a-flag, so the
   rollback is one line.
3. **"What I'm about to do"** — the third expectation has no field and no tool, and it is not obvious
   where the system would learn it. Ask at the moment the button is pressed, or infer from position?
4. **Should progress made elsewhere count toward reading statistics** (`ReadingSession`, streaks,
   goals, achievements)? Proposed: **no.** A session means measured time in the reader, not claimed
   time. Move the progress, leave the statistics alone.

## Links

- [`mcp.md`](mcp.md) — the 13 tools, client setup, authentication
- [`ADR-015`](../01-architecture/adr/ADR-015-reader-position-model.md) — why position is a text
  anchor, not a pixel
- `backend/src/Domain/Entities/BookInsight.cs` — the design rationale for "a catalog, not a
  transcript" lives in the entity's own doc comment

## Insight categories — what the consilium settled, and what it did not

Three independent readings of the code (2026-09-10), arguing for fixed categories, against them, and
over the lifecycle. They disagreed on the answer and converged on the question.

**Settled, and shipped:**

- **DELETE first, reader-only.** All three agreed, for the same reason: replacing covers a poor
  conclusion about the *right* chapter, and nothing covers one filed against the *wrong* chapter.
  Shipped as `DELETE /me/insights/{id}` with an affordance on both clients.
- **No MCP delete tool.** The asymmetry is categorical: `save_insight`'s worst case is one bad
  paragraph removed in a tap; a delete tool's worst case is a year of конспект gone, from a stateless
  bridge that cannot confirm intent, against a table with no soft-delete and no trash.
- **Not tabs.** Both sides refused them independently. The panel renders *nothing* when empty, on
  purpose; a tab bar must render before you know what is behind it, and at ≤10 insights per book
  three of four tabs are empty. It also replaces reading order — the ordering this design committed
  to — with a grouping of four.
- **If a category column ever lands, it stays OUT of the unique index.** In the key, the write
  ceiling the entity exists to hold goes from `1 × chapters` to `4 × chapters` (a 40-chapter book:
  41 rows → 164 — "approximately two hundred notes", which is the number the entity comment names as
  the thing being prevented), and the replace promise in the tool description becomes false in five
  documents at once. Facet → key later is a free re-index on tens of rows; key → facet later forces
  you to choose which row per chapter survives.

**Answered by the owner, 2026-09-10 — and the answer removes the work.** Asked concretely, both
questions came back the way that needs no schema:

- **The return path is per-book.** "I open *Dracula* and see what I worked out about it." Categories
  buy nothing there: a chapter label and reading order carry it, and both already ship. No column, no
  migration, no tabs.
- **One insight per chapter, refined over time** — so even if a category is ever added, it stays a
  label and the unique key does not move. Re-running keeps refreshing the конспект instead of
  accumulating four rows per chapter.

So the category enum is **not being built**. What the panel was actually missing for "come back a
month later" was a date, which is one pure function and no schema — shipped instead. Revisit only if
the retrieval ever turns cross-book ("every open question across all 33 books"), which is the one
shape that genuinely needs a typed field, and which would also need the filter-less `/me/insights`
route that answers 400 today.

**Two findings from the lifecycle read, not yet acted on:**

- `Source` is write-once-constant: hardcoded `"mcp"` at save and untouched on replace. It is the
  field any future scoping would key on, so it has to become honest before it is relied upon.
- The Edition FK is `OnDelete(Cascade)`: deleting one catalog edition hard-deletes every reader's
  insights about it. Low risk today (re-ingestion deletes chapters, not editions), but it is
  destruction of user content triggered by an admin action.
