# Reader — Text Selection & Highlights

## Overview

Text selection features for the Reader that enable users to highlight, translate, and look up words while reading.

**Features:**
- **Highlights** — 4 colors (yellow, green, pink, blue), persisted to DB
- **Translation** — OpenAI `gpt-4.1-nano` (`OpenAI:Model`), up to 500 chars (`OpenAI:Translate:MaxTextLength`). LibreTranslate was dropped 2026-04-22
- ~~**Dictionary**~~ — Free Dictionary API removed 2026-10-03; in definition mode (native = book language) the word popup shows the contextual Explain instead
- **Notes** — Inline notes attached to highlights

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  useTextSelection ──► SelectionToolbar ──► useHighlights        │
│         │                    │                    │             │
│         │              ┌─────┴─────┐              │             │
│         │              │           │              │             │
│         ▼              ▼           ▼              ▼             │
│  HighlightOverlay Translation  WordPopup /   IndexedDB          │
│  Layer             Popup       Explain       (offline)          │
│                      │            │              │              │
└──────────────────────┼────────────┼──────────────┼──────────────┘
                       │            │              │
                       ▼            ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Backend API                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  POST /api/translate ──────► OpenAI (gpt-4.1-nano), file cache   │
│  GET  /api/translate/languages                                   │
│                                                                  │
│  POST /api/explain   ──────► OpenAI (gpt-4.1-mini), file cache   │
│                                                                  │
│  GET    /me/highlights/{editionId} · /all · /userbook/{id}       │
│  POST   /me/highlights                                           │
│  PUT    /me/highlights/{id}                                      │
│  DELETE /me/highlights/{id}                                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Text Anchor

Reliable text location using context (survives minor content changes):

```typescript
interface TextAnchor {
  prefix: string       // ~30 chars before selection
  exact: string        // selected text
  suffix: string       // ~30 chars after selection
  startOffset: number  // fallback: offset from start
  endOffset: number    // fallback: end offset
  chapterId: string
}
```

**Search algorithm:**
1. Find `prefix + exact + suffix` in content
2. Fallback to `startOffset/endOffset`
3. Fuzzy match if needed

## API Reference

### Translation API

**POST /api/translate**
```json
// Request
{
  "text": "Hello world",
  "sourceLang": "en",
  "targetLang": "uk"
}

// Response 200
{
  "translatedText": "Привіт світ",
  "sourceLang": "en",
  "targetLang": "uk"
}
```

**Limits:** 500 characters max per request.

**GET /api/translate/languages**
```json
// Response 200
[
  { "code": "en", "name": "English" },
  { "code": "uk", "name": "Ukrainian" },
  // ...
]
```

### Highlights API

**GET /me/highlights/{editionId}**
```json
// Response 200
[
  {
    "id": "uuid",
    "chapterId": "uuid",
    "anchorJson": "{...}",
    "color": "yellow",
    "selectedText": "highlighted text",
    "noteText": null,
    "version": 1,
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z"
  }
]
```

**POST /me/highlights**
```json
// Request
{
  "editionId": "uuid",
  "chapterId": "uuid",
  "anchorJson": "{\"prefix\":\"...\",\"exact\":\"...\",\"suffix\":\"...\"}",
  "color": "yellow",
  "selectedText": "text to highlight"
}

// Response 201
{ "id": "uuid", ... }
```

**PUT /me/highlights/{id}**
```json
// Request
{
  "color": "green",
  "noteText": "My note"
}

// Response 200
```

**DELETE /me/highlights/{id}**
```
// Response 204 No Content
```

## Frontend Components

| Component | Purpose |
|-----------|---------|
| `useTextSelection` | Detects text selection (drag only, no double-click) |
| `SelectionToolbar` | Floating toolbar with color buttons and actions |
| `HighlightOverlayLayer` | Overlay rendering highlights (engine: `@textstack/reader-overlay`) |
| `TranslationPopup` | Shows translation with language selectors |
| `WordPopup` | Single-word popup: translation, or contextual Explain in definition mode (`lib/wordBubbleFetch.ts`) |
| `NoteEditor` | Inline note editor for highlights |
| `useHighlights` | CRUD + offline sync to IndexedDB |
| `useTextTranslation` | Translation API with caching |

## IndexedDB Schema

**Store: `highlights`** (added v3; DB is now v9 — see [offline-reading.md](../05-features/offline-reading.md))

```typescript
interface StoredHighlight {
  id: string
  editionId: string
  chapterId: string
  anchor: TextAnchor
  color: 'yellow' | 'green' | 'pink' | 'blue'
  selectedText: string
  noteText?: string
  syncStatus: 'pending' | 'synced'
  version: number
  createdAt: number
  updatedAt: number
}
```

**Indexes:** `editionId`, `chapterId`, `editionChapter`, `userBookId`

## UX Behavior

1. **Selection:** Toolbar appears only on drag selection (not double-click)
2. **Highlight:** Click color → text highlighted, saved to IndexedDB
3. **Single word:** word popup (translation, or Explain when native = book language) — no dictionary since 2026-10-03
4. **Translation:** Available for any selection up to 500 chars
5. **Notes:** Click highlight → NoteEditor popup
6. **Offline:** Highlights work offline, translation shows "unavailable"

## Configuration

No translation container. `OpenAI:ApiKey`, `OpenAI:Model` (translate), `OpenAI:Explain:Model`,
`OpenAI:Translate:MaxTextLength` in `backend/src/Api/appsettings.json`; server caches under
`data/translate-cache` and `data/explain-cache`. Rate limits: `translate`, `explain` policies + nginx
`translate_limit` (5r/m).

## Files

| Area | Files |
|------|-------|
| Backend Endpoints | `Api/Endpoints/HighlightsEndpoints.cs`, `TranslationEndpoints.cs` |
| Entity | `Domain/Entities/Highlight.cs` |
| Frontend Hooks | `hooks/useHighlights.ts`, `useTextSelection.ts`, `useTextTranslation.ts` |
| Frontend Components | `components/reader/SelectionToolbar.tsx`, `HighlightOverlayLayer.tsx`, `TranslationPopup.tsx`, `WordPopup.tsx`, `ExplanationPopup.tsx`, `NoteEditor.tsx` |
| Frontend API | `api/translation.ts`, `api/explain.ts` |
| Text Anchor | `lib/textAnchor.ts` |
| Tests | `lib/textAnchor.test.ts`, `HighlightsEndpointTests.cs`, `TranslationEndpointTests.cs` |

## Testing

```bash
# Backend tests
dotnet test --filter "Highlights|Translation"

# Frontend tests
pnpm -C apps/web test
```
