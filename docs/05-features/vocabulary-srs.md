# Vocabulary SRS (Spaced Repetition System)

Save words while reading, review with spaced repetition quizzes.

## Architecture

```
Reader (word select) → POST /me/vocabulary/words → DB save
                                                  → fire-and-forget: ILlmServiceFactory (route `distractor` → Ollama) → distractors + hint + explanation → DB update

Review page → GET /me/vocabulary/review → SRS queue (due words)
           → POST /me/vocabulary/review → SrsEngine.Calculate() → stage/interval update
```

## SRS Stages

| Stage | Name | `GetReviewMode` returns | Card the reader gets | Interval |
|-------|------|------------------------|----------------------|----------|
| 0 | New | multiple_choice | MC | immediate |
| 1 | Recognition | multiple_choice | MC | 1 day |
| 2 | Recall | multiple_choice | MC | 3 days |
| 3 | Context | context *if the word has a sentence*, else multiple_choice | MC, prompted by the cloze sentence | 7 days |
| 4 | Mastered | same as stage 3 | same as stage 3 | 14d → 60d (2x multiplier) |

**Promotion**: Stage 0 needs 1 correct, stages 1-3 need 2 consecutive correct to advance.
**Demotion**: Wrong answer drops 1 stage (mastered drops to recall, not context); stages 0-1 stay
put and retry in 12h.
**Auto-retire**: three consecutive correct at Mastered with an interval ≥14d retires the word from
the queue. A reader tap unretires it at stage 3.

Logic: `backend/src/Vocabulary/TextStack.Vocabulary/SrsEngine.cs`

## Review Modes

**The server emits one card shape.** `ReviewCardBuilder` builds four MC options for every card,
including the context-cloze ones, and rewrites their mode to `multiple_choice` on the way out —
so `ReviewCardDto.reviewMode` is always `"multiple_choice"` over the wire. Typed recall was removed;
`context` survives only as a *prompt* (the sentence with the word blanked) and as a value written to
`vocabulary_reviews.review_mode`, which is computed straight from `SrsEngine.GetReviewMode` and does
still record `context`. See the comment on the field in `packages/shared/src/types/api.ts`.

**The review style is the client's choice**, and shares none of those names:
`ReviewMode = 'blitz' | 'classic'` (`packages/shared/src/vocabularyConstants.ts`).

1. **blitz** — the MC card: prompt plus four options.
2. **classic** — flashcard, self-assessed (Forgot / Almost / Knew). The default.

Persisted per client: `apps/mobile/src/lib/reviewMode.ts` (AsyncStorage) and web
`localStorage['practiceMode']`. Derive it from route params as a plain value and hand *that* to
`startSession` — reading hook state during startup is how #558 shipped, where Blitz was selected and
Flashcards ran every time.

### MC prompt cascade
`MultipleChoiceCard` renders `blankSentence || definition || translation`. There is no downgrade path
— there is no longer another mode to downgrade to.

## Ollama LLM Distractors

MC quiz quality depends on plausible wrong answers. Random words = too easy.

**Solution**: Local Ollama LLM (`gemma4:e2b`) generates 5 semantically similar distractors per word.

### Flow
1. User saves word in reader → API saves to DB immediately (fast response)
2. Fire-and-forget `Task.Run` with `IServiceScopeFactory` → new DB scope
3. `DistractorGenerator.GenerateAsync()` → `ILlmServiceFactory` (task `distractor`, routed to `ollama` in `Ai:Routes`) → parse DISTRACTORS / HINT / EXPLANATION
4. Store JSON array in `vocabulary_words.distractors`
5. If Ollama fails → fallback to random words from user's vocab pool at review time

### Docker
```yaml
ollama:
  image: ollama/ollama:0.23.1
  container_name: textstack_ollama
  volumes:
    - ./data/ollama:/root/.ollama
  healthcheck:
    test: ["CMD-SHELL", "ollama list >/dev/null 2>&1 || exit 1"]
  deploy:
    resources:
      limits:
        memory: 12G   # reservation 8G; GPU via docker-compose.gpu.yml on prod
```

Config: `Ollama:BaseUrl`, `Ollama:Model` (gemma4:e2b), `Ollama:TimeoutSeconds` (90 in `appsettings.json`)

### Model Pull
```bash
docker compose exec ollama ollama pull gemma4:e2b
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/me/vocabulary/words` | Save word (+ async distractor gen) |
| GET | `/me/vocabulary/words` | List words (filter, sort, search, pagination) |
| PATCH | `/me/vocabulary/words/{id}` | Update translation/definition |
| DELETE | `/me/vocabulary/words/{id}` | Delete word |
| DELETE | `/me/vocabulary/words` | Delete all (refuses MCP OAuth tokens) |
| GET | `/me/vocabulary/review?limit=20` | Get review queue (due words) |
| POST | `/me/vocabulary/review` | Submit answer → SRS update |
| GET | `/me/vocabulary/stats` | Today's reviews, correct rate, streak |

Also under `/me/vocabulary`: `stats/daily`, `words/reader`, `words/{id}/known`, `words/{id}/unretire`,
`settings`, `pending/*` (parked words), `lookups/*` (lookup history), `clusters/*`, `concepts` —
see `backend/src/Api/Endpoints/VocabularyEndpoints*.cs`. MCP writes go through the same
POST/PATCH/DELETE routes (rate limit `highlight-write`, per user). New words get **no** dictionary
definition since 2026-10-03 (free dictionary + `DefinitionEnricher` removed).

## Frontend

| File | Purpose |
|------|---------|
| `pages/VocabularyPage.tsx` | Word list, filters, stats cards |
| `pages/VocabularyReviewPage.tsx` | Review session orchestrator |
| `components/vocabulary/MultipleChoiceCard.tsx` | MC quiz card (Blitz) — also renders the context cloze |
| `components/vocabulary/FlashCard.tsx` | Self-assessed flashcard (Classic) |
| `components/vocabulary/NewWordCard.tsx` | First sight of a word before its first review |
| `components/vocabulary/ReviewFeedback.tsx` | Correct/wrong feedback + stage change |
| `components/vocabulary/SessionSummary.tsx` | End-of-session stats |
| `hooks/useVocabulary.ts` | Word CRUD + filtering |
| `hooks/useVocabularyReview.ts` | Review session state machine |
| `api/vocabulary.ts` | API client methods + DTOs |

## E2E Tests

`apps/web/e2e/tests/vocabulary.spec.ts` — serial suite, 3 tests (2026-10-04):
- flashcards is the default mode
- streak badge shows in header when words are due
- start a review session in flashcard mode

The older 10-test suite and its `helpers/vocabulary.ts` no longer exist.

## Database

See [database.md](../02-system/database.md#vocabulary-tables) for full schema.

Key tables: `vocabulary_words`, `vocabulary_reviews`
