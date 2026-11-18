# Vocabulary SRS (Spaced Repetition System)

Save words while reading, review them with self-assessed flashcards. Checked against code 2026-11-17.

## Architecture

```
Reader (word select) → PUT /me/v2/vocabulary/words → VocabularySyncService → vocabulary_words (+ vocabulary_examples)

Review page → GET /me/v2/vocabulary/due → SRS queue (due words)
           → POST /me/v2/vocabulary/reviews → SrsEngine.Calculate() → stage/interval update
```

The server owns the word key (`WordKeys`) and the schedule; protocol in
[`v2-sync-protocol.md`](../internal/v2/v2-sync-protocol.md) "Payloads → Vocabulary".

## SRS Stages

| Stage | Name | Interval |
|-------|------|----------|
| 0 | New | immediate |
| 1 | Recognition | 1 day |
| 2 | Recall | 3 days |
| 3 | Context | 7 days |
| 4 | Mastered | 14d → 60d (2x multiplier) |

**Promotion**: Stage 0 needs 1 correct, stages 1-3 need 2 consecutive correct to advance.
**Demotion**: Wrong answer drops 1 stage (mastered drops to recall, not context); stages 0-1 stay
put and retry in 12h.
**Auto-retire**: three consecutive correct at Mastered with an interval ≥14d retires the word from
the queue.

Logic: `backend/src/Vocabulary/TextStack.Vocabulary/SrsEngine.cs`

## API Endpoints (`/me/v2`, `V2Endpoints.cs`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/vocabulary/changes` | Change feed (cursor) |
| GET | `/vocabulary/due` | Review queue (due words) |
| PUT | `/vocabulary/words` | Save word |
| GET/PATCH/DELETE | `/vocabulary/words/{id}` | Read, edit, delete a word |
| POST | `/vocabulary/words/{id}/restore` | Undo a delete |
| POST | `/vocabulary/words/{id}/examples` | Add a source sentence |
| POST | `/vocabulary/reviews` | Submit answer → SRS update |

MCP writes go through the same routes. Settings, pending words, lookups and concepts are not on V2
yet ([#1366](https://github.com/mrviduus/textstack/issues/1366)).

## Frontend (web)

| File | Purpose |
|------|---------|
| `pages/VocabularyPage.tsx` | Word list |
| `pages/VocabularyReviewPage.tsx` | Review session orchestrator |
| `components/vocabulary/FlashCard.tsx` | Self-assessed flashcard (Forgot / Almost / Knew) |
| `components/vocabulary/NewWordCard.tsx` | First sight of a word before its first review |
| `components/vocabulary/SessionSummary.tsx` | End-of-session stats |
| `hooks/useVocabulary.ts` | Word list + edits |
| `hooks/useVocabularyReview.ts` | Review session state machine |
| `api/vocabulary.ts` | API client methods + DTOs |

## Database

Tables: [data model](data-model.md) — `vocabulary_words`, `vocabulary_examples`,
`vocabulary_reviews`.
