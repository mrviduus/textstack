# Chapter review — the reader's assistant reviews a chapter, the result comes home as structure

**Status:** Slices A+B (backend + MCP) built 2026-09-29, PR 1; C+D (button on every chapter row + summary page, web + mobile) built 2026-09-30, PR 2; E–G next. Stage 2 of TextStack × ChatGPT/Claude.
**Depends on** stage 1 (personal connect URL `/mcp/k/<tsk_key>`), built separately — assumed present.
**Decision record:** [ADR-016](../01-architecture/adr/ADR-016-chapter-review-lives-in-book-insight.md).
Context: [assistant-handoff.md](assistant-handoff.md), [mcp.md](mcp.md).

The reader finishes a chapter (read here, or listened to elsewhere), presses **Review chapter**, and
their own ChatGPT or Claude runs the review by the TextStack method over MCP. We run no LLM.

**Done when:** the owner reviews a DDIA chapter (a PDF upload) via ChatGPT and sees the result on the
chapter summary page, as badges on his highlights in the reader, and in the Practice page's
"Chapter questions" section.

Out of scope: pre-chapter questions, "explain it yourself" grading, book cheat-sheet, review
versions, OAuth + ChatGPT app publishing.

## 1. Flow

```
[Review chapter] ─ handoffUrl(chatgpt|claude, chapterReviewBrief) ─▶ new chat, prompt prefilled
chat ─▶ get_chapter_review(bookId|editionId, chapterSlug[, part])     ONE call (+ parts if long)
        ◀── method · chapter text · my highlights in it · my words · open threads · prior review
chat ─▶ (chapter has no highlights) asks "what do you remember?"
chat ─▶ save_chapter_review(…, review) ── 400 with EVERY error ─▶ model fixes all, resaves
TextStack: book_insight.review_json + Text (markdown) · review_question rows (own SRS queue)
```

## 1a. One flow: Discuss, then review (2026-10-01)

"Discuss book" and "Review chapter" are now one entry: **Discuss** on a chapter. The prefilled
message is `I'm reading "<book>" by <author> in TextStack, at the chapter "<chapter>". Let's talk
about it.` plus the id line (`(TextStack: book <id>, chapter <slug>)` or `(TextStack: catalog
<slug>, edition <id>, chapter <slug>)`). The rules live in the MCP server `instructions`
(`McpBridgeCore.Instructions`), not in the message:

- **Conversation first, free.** Any topic, jump around.
- **Soft spoilers.** The assistant may go to later chapters but warns and asks first.
- **The assistant offers the review** when the talk winds down or the reader says done; only on
  yes does it run `get_chapter_review` → method → `save_chapter_review`. Method v3 builds the
  blocks from the chapter *and* the conversation and skips "what do you remember?" when the talk
  already showed it.
- Conclusions not about the chapter → `save_insight` without `chapterSlug`. No chapter in the id
  line (not started) → plain book discussion, `save_insight`.
- **Server frontier unchanged:** `get_chapter_review` / `save_chapter_review` still refuse chapters
  past the reader's position (§7). The review itself covers this chapter only.

## 2. What exists (verified)

| Seam | Where | Note |
|---|---|---|
| `BookInsight`, one per (user, book, slug), save replaces | `Domain/Entities/BookInsight.cs:23-27`; `Infrastructure/Persistence/AppDbContext.Insights.cs:42-49` | XOR CHECK, `NULLS NOT DISTINCT` |
| `/me/insights` | `Api/Endpoints/InsightsEndpoints.cs:49-57`; slug check `:175-193`; upsert `:199` | logic inline in endpoint |
| `save_insight` / `get_my_insights` | `Ai/TextStack.Ai.Mcp/Tools/McpToolCatalog.cs:781`, `:836` | the SDK does **not** validate `InputSchema` (`:760-762`) |
| Bridge error handling | `Http/TextStackApiClient.cs:373-392` | **any non-2xx → null**; server error text never reaches the model |
| `get_my_chapter` cap | `Tools/HtmlText.cs:18` `DefaultMaxChars = 40_000` | DDIA chapter (~15–20k words ≈ 100–130k chars) is **already truncated today** |
| Tool count 16, asserted 4× | `McpManifestDriftTests.cs:59`, `McpStdioSmokeTests.cs:56`, `McpOverTheWireTests.cs:281`, `IntegrationTests/McpManifestEndpointTests.cs:85`; mirror `Contracts/Mcp/McpManifest.cs` | → 18 |
| Handoff | `packages/shared/src/lib/assistantHandoff.ts:28` (1200 chars), `:113` `handoffUrl` | `AssistantMenu` web + mobile |
| Insight UI | `BookInsightsSection` web + mobile, on `BookDetailPage:360`, `UserBookDetailPage:483`, mobile `book/[slug].tsx:548`, `my-books/[id].tsx:803` | |
| Upload progress | `UserBook.ProgressChapterSlug/ProgressLocator` (`UserBook.cs:25-26`); write `UserBookService.cs:576` | |
| **PDF progress has no chapter** | `packages/shared/src/reader/pdfProgress.ts:49-55`: `chapterSlug: null, locator: "page:<N>"` | chapter derived from page |
| PDF chapter page ranges | `UserChapter.SourceStartPage/SourceEndPage` (`UserChapter.cs:19-20`), set `UserIngestionService.cs:222-223` | PDFs get `UserChapter` rows with `PlainText` (`:11`) from deterministic `PdfTextExtractor` |
| Catalog high-water | `ReadingProgress.MaxChapterNumber`, `max()` in `UserDataEndpoints.cs:262` | "write-only" until now; `set_book_progress` goes through the same PUT |
| Highlights | reflow uploads: `Highlight.UserChapterId`; **PDF highlights omit it** (`apps/web/src/hooks/useHighlights.ts:136,154`); page in `anchor_json {kind:"pdf",page,rects}` jsonb (`HighlightsEndpoints.cs:378-390`) | |
| Rate limits | `highlight-write` per **user** (`ServiceCollectionExtensions.RateLimiting.cs:152`); `insights` per **IP** (`:172`) — all MCP calls share the bridge's one IP, so 60/min is shared by every MCP user | re-key in A |
| SRS math | `SrsEngine.Calculate` (`Vocabulary/TextStack.Vocabulary/SrsEngine.cs:14`) pure/stateless; `ShouldAutoRetire` `:60`; `ISrsEngine` singleton | reused, not modified |
| "Practice page" | merged into `/vocabulary` (`VocabularyPage.tsx:306` practice card; PR #67). Highlight review is `/highlights/review` (`App.tsx:133`). `PracticePage` in CLAUDE.md is stale | |
| Reader layers | HTML `HighlightOverlayLayer.tsx` (Overlayer `add(key, range, draw)`), PDF `PdfHighlightLayer.tsx` + `hitTestHighlightRects` (`PdfOriginalView.tsx:471`) | |
| Words | `VocabularyWord.UserBookId/EditionId/Sentence`. It **does** have `ChapterId` (`VocabularyWord.cs:17`, catalog only) — unused, per-book by decision | |

## 3. Data model

ADR-016: the review lives in the chapter's `BookInsight`; SRS state gets its own table.

**`Domain/Entities/BookInsight.cs`** + `public string? ReviewJson { get; set; }` — column `review_json jsonb NULL`.

**`Domain/Entities/ReviewQuestion.cs`** (new, `ISiteScoped`), table `review_question`:

| column | type | note |
|---|---|---|
| `id` | uuid PK | |
| `user_id` / `site_id` | uuid FK cascade | site query filter like `book_insight` |
| `book_insight_id` | uuid FK → `book_insight` **ON DELETE CASCADE** | |
| `block_index` | int | 0-based, for display order |
| `prompt` | varchar(500) | |
| `answer` | varchar(1500) | |
| `prompt_hash` | varchar(16) | first 16 hex of sha256(normalized prompt) |
| `stage` / `interval_days` / `consecutive_correct` | int / float8 / int | same meaning as `vocabulary_words` |
| `next_review_at` | timestamptz | new question = now |
| `last_reviewed_at` | timestamptz NULL | |
| `total_reviews` / `correct_reviews` | int | |
| `is_retired` | bool default false | `ShouldAutoRetire` |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `UNIQUE (book_insight_id, prompt_hash)`; `(user_id, is_retired, next_review_at)`.
**Migration:** `AddChapterReview` (`dotnet ef migrations add AddChapterReview --project backend/src/Infrastructure --startup-project backend/src/Api`).
Additive only; `Down` drops the table and the column.

`review_json` stored shape (`methodVersion` and thread `id`s are server-owned):

```jsonc
{ "methodVersion": 1,
  "recall": "…" | null,
  "blocks": [ { "title": "…", "problem": "…", "rootCause": "…", "rule": "…",
                "highlightIds": ["uuid"], "question": { "prompt": "…", "answer": "…" } } ],
  "applications": ["…"],
  "openThreads": [ { "id": "t_3fa9c1d2", "text": "…" } ],
  "closedThreadIds": ["t_…"] }
```

`Text` = `ReviewMarkdownRenderer.Render(review, chapterTitle)` — `## {block.title}`, then
`**Example.** …`, `**Root cause.** …`, `> **Rule:** …`, `**Check yourself:** …`; then
`## Where this shows up`, `## Open threads`, `## Closed`. `Question = "Chapter review"`,
`Source = "mcp"`. Existing readers of insights keep working untouched.

## 4. API (slice A)

All under auth, `Api/Endpoints/ChapterReviewEndpoints.cs`, thin → `Application/ChapterReview/ChapterReviewService.cs`.

| Route | Purpose |
|---|---|
| `GET /me/chapter-review?userBookId=\|editionId=&chapterSlug=&part=1` | the review context (tool 1) |
| `PUT /me/chapter-review` (rate limit `insights`) | validate + save (tool 2) |
| `GET /me/review-questions/due?limit=20` | own SRS queue |
| `POST /me/review-questions/{id}/answer` | self-assessment |
| `GET /me/insights` | unchanged route; `BookInsightDto` gains `ChapterReviewDto? Review` (appended last, additive) |

**Error format** (every non-2xx from the two review routes; bridge relays it verbatim):

```json
{ "error": "review_invalid",
  "message": "3 problems — fix all of them and call save_chapter_review again.",
  "errors": [ { "path": "blocks[1].rootCause", "code": "multiline", "message": "must be one line (≤300 chars)" } ] }
```

`error` ∈ `bad_request` (400, target/part), `review_invalid` (400), `not_found` (404: book / chapter —
same wording as `InsightsEndpoints`), `chapter_not_reached` (409, §6, adds `currentChapterSlug`,
`currentChapterTitle`), `review_exists` (409 on `POST /me/insights` over a reviewed row).
`code` ∈ `required`, `too_long`, `too_short`, `count`, `multiline`, `invalid_json`,
`unknown_property`, `unknown_highlight`, `highlight_beyond_chapter`, `highlight_required`,
`recall_required`, `unknown_thread`, `duplicate_question`, `too_large`.

## 5. MCP tools (16 → 18)

Keyed like the insight tools: `bookId` XOR `editionId` (`TryReadInsightTarget`) + `chapterSlug`.
One upstream call each; the bridge serializes the API DTO unchanged as the tool text.
New client methods return `ApiResult<T>(T? Value, string? Error)`: on 400/404/409 `Error` = `message`
+ one line per `errors[]` entry (`path: message`), and the handler returns `Error(...)` with it.

**`get_chapter_review`**

```json
{ "type": "object", "additionalProperties": false, "required": ["chapterSlug"],
  "properties": {
    "bookId": { "type": "string", "format": "uuid" },
    "editionId": { "type": "string", "format": "uuid" },
    "chapterSlug": { "type": "string", "minLength": 1, "maxLength": 300 },
    "part": { "type": "integer", "minimum": 1, "maximum": 20 } } }
```

Description (mirror verbatim in `McpManifest.cs`): *"Start a TextStack chapter review — everything in
one call (requires authentication). Give EITHER bookId (an uploaded book) OR editionId (a catalog
book), plus chapterSlug. Returns the review METHOD to follow, the chapter text, the reader's
highlights in it, their saved words from this book, open threads from earlier chapters and any
previous review of this chapter. If chapter.partCount > 1, call again with part = 2..partCount
before writing. Follow the method exactly and save with save_chapter_review. Do not use or reveal
anything from later chapters."*

Output (part 1; parts ≥ 2 return only `book` + `chapter`):

```jsonc
{ "book": { "kind": "userbook", "bookId": "…", "editionId": null, "title": "…", "author": "…" },
  "chapter": { "slug": "…", "title": "…", "part": 1, "partCount": 3, "text": "…" },
  "method": "…markdown…", "methodVersion": 1,
  "highlights": [ { "id": "uuid", "text": "…", "note": "…" | null } ],   // this chapter only
  "words": [ { "word": "…", "translation": "…", "definition": "…", "sentence": "…" | null } ],  // ≤200
  "openThreads": [ { "id": "t_…", "text": "…", "openedInChapter": "title" } ],
  "existingReview": { /* review_json */ } | null,
  "recallRequired": true,              // = highlights is empty
  "saveWith": "save_chapter_review" }
```

**`save_chapter_review`**

```json
{ "type": "object", "additionalProperties": false, "required": ["chapterSlug", "review"],
  "properties": {
    "bookId": { "type": "string", "format": "uuid" },
    "editionId": { "type": "string", "format": "uuid" },
    "chapterSlug": { "type": "string", "minLength": 1, "maxLength": 300 },
    "review": { "type": "object", "additionalProperties": false,
      "required": ["blocks", "applications"],
      "properties": {
        "recall": { "type": "string", "maxLength": 3000 },
        "blocks": { "type": "array", "minItems": 3, "maxItems": 6, "items": {
          "type": "object", "additionalProperties": false,
          "required": ["title", "problem", "rootCause", "rule", "highlightIds", "question"],
          "properties": {
            "title": { "type": "string", "minLength": 1, "maxLength": 120 },
            "problem": { "type": "string", "minLength": 1, "maxLength": 1200 },
            "rootCause": { "type": "string", "minLength": 1, "maxLength": 300 },
            "rule": { "type": "string", "minLength": 1, "maxLength": 300 },
            "highlightIds": { "type": "array", "maxItems": 20, "items": { "type": "string", "format": "uuid" } },
            "question": { "type": "object", "additionalProperties": false, "required": ["prompt", "answer"],
              "properties": { "prompt": { "type": "string", "minLength": 1, "maxLength": 500 },
                              "answer": { "type": "string", "minLength": 1, "maxLength": 1500 } } } } } },
        "applications": { "type": "array", "minItems": 1, "maxItems": 5,
          "items": { "type": "string", "minLength": 1, "maxLength": 400 } },
        "openThreads": { "type": "array", "maxItems": 10, "items": { "type": "object",
          "additionalProperties": false, "required": ["text"],
          "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 300 } } } },
        "closedThreadIds": { "type": "array", "maxItems": 20, "items": { "type": "string", "maxLength": 20 } } } } } }
```

Description: *"Save a finished TextStack chapter review (WRITE on the reader's account — requires
authentication). Same book/chapter ids as get_chapter_review. `review` must follow the method
get_chapter_review returned: 3–6 blocks, each with a concrete problem, a one-line rootCause, a rule
to memorize, the ids of the reader's highlights it covers (never invent ids) and one question with
its answer; plus applications and threads. Saving again REPLACES the chapter's review. If the
save is refused, the error lists every problem — fix all of them and save again."*

Output: `{ "saved": true, "insightId": "…", "chapterSlug": "…", "questionCount": 4,
"openThreads": [{ "id": "t_…", "text": "…" }], "closedThreadIds": ["t_…"], "updatedAt": "…" }`.

The bridge forwards `review` as the raw `JsonElement` (only top-level keys checked by
`ArgReader.TryObject`); the server is the only validator.

## 6. Validation (`ChapterReviewValidator`, pure) — collect ALL errors

The endpoint binds `SaveChapterReviewRequest(Guid? UserBookId, Guid? EditionId, string ChapterSlug,
JsonElement Review)` and deserializes `Review` itself with `UnmappedMemberHandling.Disallow`; a
`JsonException` becomes one `invalid_json`/`unknown_property` error at `ex.Path`.

1. Exactly one target; book owned / exists; slug resolves → `bad_request` / `not_found`.
2. Spoiler gate (§7) → `chapter_not_reached`.
3. `blocks` 3..6; every field present, non-blank, in length; `rootCause` and `rule` single-line.
4. Each `highlightIds[i]` belongs to this user + this book (`unknown_highlight`) and to a chapter ≤
   target (`highlight_beyond_chapter`). Lenient on the exact chapter because PDF chapters start
   mid-page. Never creates highlights.
5. Target chapter has ≥1 highlight → at least one block references one (`highlight_required`).
   Has 0 → `recall` required, ≥40 chars (`recall_required`) — the audiobook path.
6. `applications` 1..5; `openThreads` ≤10; `closedThreadIds` ⊆ open set for this chapter
   (`unknown_thread`, message lists valid ids).
7. Question prompts unique by `prompt_hash` (`duplicate_question`); serialized review ≤ 40,000 chars
   (`too_large`).

**Save** (one `SaveChangesAsync`): upsert `BookInsight` on the same key as `SaveInsight`; assign
thread ids; stamp `methodVersion`; set `ReviewJson`, `Text`, `Question`, `UpdatedAt`; sync
`review_question` by `prompt_hash` (unchanged prompt → keep SRS state, update answer/block_index;
missing → delete; new → stage 0, `next_review_at = now`).
**`POST /me/insights`** on a row with `ReviewJson != null` → 409 `review_exists` (ADR-016 §3;
`save_insight` description gains: *"A chapter that has a structured review cannot be overwritten
here — use save_chapter_review."*).
**Rate limit:** `insights` policy re-keyed by user id (copy `highlight-write`'s partitioner), applied
to `POST /me/insights` and `PUT /me/chapter-review`.
**Logs:** `chapter_review.saved` (bookKind, blocks, questions, threadsOpened/Closed) and
`chapter_review.rejected` (codes) at Information — the rejection rate is the signal for tuning.

## 7. Spoiler rule — "passed chapters"

Pure `ChapterFrontier.Resolve(ProgressSnapshot, IReadOnlyList<ChapterRef>, int? maxReviewedNumber)
→ int?` (max allowed `chapter_number`; ordering key only, never displayed).

| Book | Frontier |
|---|---|
| Catalog | `CompletedAt` → last; else `MaxChapterNumber`; else number of `ChapterId` |
| Upload, reflow | `CompletedAt` or `ProgressPercent ≥ 0.99` → last; else chapter of `ProgressChapterSlug` |
| Upload, PDF original | `ProgressLocator` = `page:N` → chapter with greatest `SourceStartPage ≤ N`; no ranges → `ceil(ProgressPercent × count)` (≥1) |
| Upload, any | `max(above, maxReviewedNumber)` — re-reading ch. 2 must not lock out re-running ch. 7 |
| No progress | `null` → every chapter refused |

Refusal (409, GET and PUT): *"The reader has not reached '{title}' in TextStack (they are at
'{current}'). If they finished it elsewhere — audiobook, paper — confirm with them, call
set_book_progress for this chapter, then retry."* Reuses the existing tool; honest that it
overwrites a PDF's stored page.

Bounded output: only the target chapter's text; highlights of the target chapter (reflow:
`UserChapterId`/`ChapterId`; PDF: `anchor.page` in `[SourceStartPage, SourceEndPage]` — load the
user's highlights for the book and place them in memory with pure `HighlightPlacement`); open threads
from chapters **< target** only; a word's `sentence` only if it occurs in the target chapter's
`PlainText` (whitespace-normalized, case-insensitive) — a sentence saved in a later chapter is a
spoiler. The model's own knowledge of the book cannot be prevented — accepted.

## 8. Open threads (pure `OpenThreads`)

`Compute(reviews, targetNumber)`: reviews whose chapter number < target (unresolvable slug →
skipped), in reading order: ∪ `openThreads` − ∪ `closedThreadIds`. Id = `"t_" + hex(sha256(chapterSlug
+ "|" + normalize(text)))[..8]` — deterministic, so an identical re-save keeps ids; an edited thread
gets a new id and a dangling close is ignored. No table (ADR-016 alt. F).

## 9. The method — one file

**`backend/src/Application/ChapterReview/ReviewMethod.md`**, `<EmbeddedResource>` in
`Application.csproj` (pattern: `Infrastructure.csproj:30`), read once by
`Application/ChapterReview/ReviewMethod.cs` (`public static string Text`, `public const int Version`,
`TextSha256` pinned by a test — edit the text, bump both). ~~`Version = 1`~~ — v2 (2026-09-30, stopped
naming screens that didn't exist yet), **v3** (2026-10-01, "If you have already been talking", §1a).
Served inside `get_chapter_review` → changing it is an API deploy, not an MCP rebuild or a manifest
change. Stamped into each saved review. **Appendix A is the original v1 draft, kept for history — the
live text is the `.md` file.**

## 10. Long chapters — `part`

Pure `ChapterParts.Split(plainText, maxChars = 40_000)` at paragraph (`\n\n`) boundaries, falling
back to sentence then hard cut; concatenation equals input. Uses stored `PlainText`, not stripped
HTML. DDIA ≈ 3–4 parts. `part > partCount` → `bad_request`. 40k matches `get_my_chapter`; ChatGPT's
real ceiling unknown (Q1) — the constant is the knob.

## 11. Review questions — own queue, own section

Owner decision: a **separate "Chapter questions" section on the Practice page**, not mixed into the
word session. Word SRS (`VocabularyWord`, `SrsEngine`, `ReviewCardBuilder`, `/me/vocabulary/*`,
`useVocabularyReview`) untouched.

- `GET /me/review-questions/due?limit=20` (1..50) →
  `{ "totalDue": 7, "items": [ { "id", "prompt", "answer", "blockTitle", "rule", "bookTitle",
  "chapterTitle", "chapterSlug", "userBookId", "editionId" } ] }`, `is_retired = false AND
  next_review_at <= now`, oldest due first.
- `POST /me/review-questions/{id}/answer` `{ "selfAssessment": "forgot" | "almost" | "knew" }` →
  `isCorrect = knew` (same mapping as `FlashCard.tsx`) → `ISrsEngine.Calculate`, then
  `ShouldAutoRetire` → `{ "stage", "nextReviewAt", "retired" }`. 404 if not the caller's.
- Web: a "Chapter questions" card on `/vocabulary` next to the practice card (due count + Start) →
  new route `/:lang/review/questions` (`ChapterQuestionReviewPage`, modeled on
  `HighlightReviewPage`: flip, forgot/almost/knew). Mobile: same card on `(tabs)/vocabulary.tsx` +
  `app/review-questions.tsx` (slice G).

## 12. UI surfaces (slices C–G)

- **Button** — `ReviewChapterButton` on chapter rows; the book-level `AssistantMenu` on the 4 detail screens: chapter
  picker (default = position chapter; titles only) + Claude/ChatGPT links. Shared
  `buildChapterReviewBrief({title, author, bookId|editionId, chapterSlug, chapterTitle})` (≤1200
  chars) names both tools and says what to do without a connector. Reader-menu entry later (E).
- **Summary page** — web `/:lang/library/my/:id/review/:chapterSlug` and
  `/:lang/books/:slug/review/:chapterSlug` (auth, not prerendered); mobile
  `app/chapter-review.tsx?userBookId|editionId&chapterSlug`. Data: `GET /me/insights` (now carries
  `review`). Cards per block: title, example, **root cause**, **rule**, linked highlight quotes (tap →
  reader; deleted → "highlight removed"), question with reveal; then applications, threads.
  `BookInsightsSection` links reviewed rows to it.
- **Reader badges** — one `/me/insights` fetch → `Map<highlightId, {chapterSlug, blockTitle, rule}>`.
  HTML: extra Overlayer namespace `reviewed-mark` with a custom `DrawFn` (dot after the last rect) —
  no engine change. PDF: `PdfHighlightLayer` `reviewedIds` prop, dot at the first rect, scaled.
  Tap (existing `onHighlightClick` / `hitTestHighlightRects`) → popover row "Reviewed · {block} ·
  {rule} · Open review".

## 13. Slices → PRs (4 PRs; 1–3 meet "done when")

### PR 1 — Slices A+B: backend + MCP, no UI (tonight)

Files:
- Domain: `Entities/BookInsight.cs` (+`ReviewJson`), `Entities/ReviewQuestion.cs` (new)
- Application: `Common/Interfaces/IAppDbContext.cs` (+`DbSet<ReviewQuestion> ReviewQuestions`);
  `ChapterReview/` → `ChapterReviewService.cs` (GetContext, Save), `ReviewQuestionService.cs`
  (Due, Answer), `ChapterReviewValidator.cs`, `ChapterFrontier.cs`, `OpenThreads.cs`,
  `ChapterParts.cs`, `HighlightPlacement.cs`, `ReviewMarkdownRenderer.cs`, `ReviewMethod.cs`,
  `ReviewMethod.md`; `Application.csproj` (EmbeddedResource)
- Contracts: `ChapterReview/ChapterReviewDtos.cs` (context, input, stored review, save result,
  error, due item, answer req/resp); `Insights/InsightDtos.cs` (+`Review`)
- Infrastructure: `Persistence/AppDbContext.Insights.cs` (`review_json` jsonb + `ReviewQuestion`
  mapping, site filter, cascades, indexes), `AppDbContext.cs` DbSet, `Migrations/*_AddChapterReview.cs`
- Api: `Endpoints/ChapterReviewEndpoints.cs` (4 routes), `InsightsEndpoints.cs` (409 + DTO
  `Review`), `Program.cs` (map), `Extensions/ServiceCollectionExtensions.Content.cs` (2 scoped
  services), `Extensions/ServiceCollectionExtensions.RateLimiting.cs` (`insights` per user)
- MCP: `Tools/McpToolCatalog.cs` (2 builders; `save_insight` description), `Http/TextStackApiClient.cs`
  (`GetChapterReviewAsync`, `SaveChapterReviewAsync` → `ApiResult<T>`), `Contracts/Mcp/McpManifest.cs`,
  `README.md`; `docs/05-features/mcp.md`; CLAUDE.md MCP section (16 → 18).

DoD: MCP Inspector against local API, on a PDF upload with page ranges: get (multi-part) → save
invalid (all errors in one message) → save valid → `get_my_insights` shows the rendered text →
`/me/review-questions/due` lists the questions → answer moves `next_review_at`. `dotnet test` green.

Tests:
- `tests/TextStack.UnitTests/ChapterReview/` — `ChapterReviewValidatorTests` (each code;
  aggregation; recall vs highlight rule; unknown property path), `ChapterFrontierTests` (catalog
  completed/high-water/chapterId; reflow slug; PDF page→range incl. page before first chapter, gaps,
  null ranges → percent; reviewed-max rescue; none), `OpenThreadsTests` (order, earlier-only,
  re-review an earlier chapter, dangling close, id determinism), `ChapterPartsTests` (boundaries,
  lossless, single part), `HighlightPlacementTests` (reflow + pdf anchor), `ReviewMarkdownRendererTests`,
  `ReviewMethodTests` (loads; mentions every validator field name; sha256 of text pinned beside
  `Version` so editing text forces a version bump), `ReviewQuestionAnswerTests` (knew/almost/forgot
  → `SrsEngine`, retire).
- `tests/TextStack.IntegrationTests/ChapterReviewEndpointTests.cs` (pattern `InsightsEndpointTests`):
  401s; 400 error list shape; 409 beyond frontier → PUT progress → 200; round trip + `get insights`
  has `review` and `text`; `POST /me/insights` 409 on reviewed row; re-save keeps SRS of unchanged
  prompt, drops removed; foreign highlight → `unknown_highlight`; other user's book 404; insight
  DELETE cascades questions; due/answer.
- `tests/TextStack.Ai.Mcp.Tests`: counts 16→18 (4 files), drift, `StubBackend` routes for both tools
  incl. a 400 with `errors[]` → tool `IsError` text contains every `path`; get with `part`.

Rollback: revert the PR; `Down` drops `review_question` and `review_json`; nothing else touched.

### PR 2 — Slices C+D: button + summary page, web + mobile
Scope §12 first two bullets; `ChapterReviewDto` in `packages/shared/src/types/api.ts`; mobile
`Linking.openURL` failure surfaced for this button (handoff TODO #10). DoD: owner's DDIA end to end
to the summary page on web and phone. Tests: Vitest brief (≤1200, both book kinds, no-connector
line); summary render (recall-only, removed highlight); mobile `tsc`; web e2e seed-via-API → summary.

### PR 3 — Slices E+F: web reader badges (HTML + PDF) + Chapter questions section (web)
DoD: marks on reviewed highlights in DDIA Original layout, tap shows the rule; `/vocabulary` shows
"Chapter questions (N)", session answers move them. Tests: `HighlightOverlayLayer.test`,
`PdfHighlightLayer.test` (dot only for reviewed ids), page test; e2e seed → badge → popover; seed →
section → answer → count drops.

### PR 4 — Slice G: mobile reader badges + mobile Chapter questions
Device smoke first (workflow rule), then one mobile e2e spec.

## 14. Risks

- ChatGPT tool-output ceiling / refusal to page → part-size knob; nothing silently truncated.
- DDIA chapter detection from the PDF outline: bad ranges → wrong frontier and wrong "highlights
  in this chapter". Check the owner's copy (Q2).
- Strict validation vs model quality → retry loops; `chapter_review.rejected` tells us which rule.
- `save_insight` 409 is a behaviour change mid-session; the message names the fix.
- Uploads have no high-water mark → a reader who jumped back is refused on later chapters until
  `set_book_progress` or an earlier review rescues it (Q3).
- Edition FK cascade (pre-existing) now also deletes reviews + questions.
- **The owner's DDIA has 8 "chapters" that are the book's Parts** (PDF upload `7c3a0099-…`, Part I =
  pp. 23–166 etc.; 0 highlights). PDF chapter detection reads outline level 1 only, so a "chapter"
  review there is a whole Part, in recall mode, split into many 40k parts. **Follow-up slice (not in
  PR 1):** PDF chapter extraction from outline level 2 + re-extract existing uploads. Re-extraction
  regenerates slugs, so reviews keyed on the old Part slugs stop resolving (kept, unplaced — the
  `BookInsight` slug rule).

## 15. Open questions — resolved by the owner, 2026-09-29

1. Part size: **keep 40,000 chars** (`ChapterParts.DefaultMaxChars`).
2. DDIA upload: 8 chapters = the Parts, 0 highlights — see §14; outline-level-2 extraction is a
   follow-up slice.
3. **No `UserBook.MaxChapterNumber`** — the reviewed-max rescue in `ChapterFrontier` stays.
4. `POST /me/insights` over a reviewed row → **409 `review_exists`**.
5. Guests **allowed** (no LLM cost to us) — no `RequireAiAccount`.
6. **No highlights card** on Practice.

## Appendix A — `ReviewMethod.md`, draft v1

> **Historical.** Superseded by v2 and v3 — read `backend/src/Application/ChapterReview/ReviewMethod.md` for the text the server actually sends.

> Lives at `backend/src/Application/ChapterReview/ReviewMethod.md`. Edit there only; bump
> `ReviewMethod.Version`.

```markdown
# TextStack chapter review — method v2

You are reviewing ONE chapter with the reader. The goal is not a summary. The goal is that a month
from now they still know the few ideas in this chapter that matter, can recognise them in their
own work, and can answer a question about each without looking.

## Ground rules
- Use only this chapter and what came before it. Do not run ahead: no later chapters, no "as the
  author shows later", even if you know the book. If the reader asks about later material, say it
  comes later and stay here.
- Read the whole chapter first. If `chapter.partCount` is more than 1, fetch every part before you
  write anything.
- The reader's highlights are what they found important. Build around them. Reference them only by
  the `id` you were given — never invent an id, never quote a highlight as if it were a new one.
- Use their saved words where they fit naturally; do not turn the review into a vocabulary lesson.
- If `existingReview` is present, improve it rather than starting over, unless the reader asks.
- Talk to the reader in their language; keep the saved review in the language of the book.

## If the chapter has no highlights (`recallRequired: true`)
They probably listened to it or read it elsewhere. Before anything else, ask:
"What do you remember from this chapter?" Wait for the answer. Put their answer, in their words,
into `recall`. Build the blocks around what they remembered and fill the gaps from the text —
say which ideas they missed.

## Structure: 3 to 6 blocks
Split the chapter by IDEA, not by heading. Fewer, sharper blocks beat many shallow ones. For each:
1. `title` — the idea in a few words.
2. `problem` — a concrete example of the problem this idea solves: a specific system, situation or
   failure, with names and numbers where the chapter gives them. No abstractions here.
3. `rootCause` — why the problem happens, in ONE line.
4. `rule` — the takeaway phrased to be memorized verbatim: short, imperative or declarative, no
   hedging. If the reader should remember one sentence from this block, this is it.
5. `highlightIds` — the ids of the reader's highlights this block explains (may be empty for one
   block, but if the chapter has highlights, use them).
6. `question` — one self-check `prompt` that tests the rule, not trivia, with a short `answer`.
   It will be shown to them later as a flashcard, out of context: make it answerable on its own.

## Where this shows up
`applications`: 1–5 places this chapter shows up in the reader's life or work. Use what you know
about them; if you know nothing, ask one short question before writing these.

## Threads
- `openThreads` you receive are questions earlier chapters left open. If this chapter answers one,
  put its `id` in `closedThreadIds` and say so to the reader.
- Add new `openThreads` for questions this chapter raises and does not answer — things worth
  watching for in the chapters ahead. Short, one per line, at most 10.

## Before saving
Walk the reader through the blocks briefly and let them correct you. Then call
`save_chapter_review` once. If it is refused, the error lists every problem: fix all of them and
save again. Tell the reader it is saved to the chapter in TextStack, and that its self-check
questions will come back to them for review. Do not name specific pages or screens.
```
