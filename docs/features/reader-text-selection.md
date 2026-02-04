# Reader — Text Selection & Highlights

## Overview

Text selection features for the Reader that enable users to highlight, translate, and look up words while reading.

**Features:**
- **Highlights** — 4 colors (yellow, green, pink, blue), persisted to DB
- **Translation** — LibreTranslate (self-hosted), up to 500 chars
- **Dictionary** — Free Dictionary API, single word lookup
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
│  HighlightLayer   Translation  Dictionary    IndexedDB          │
│                    Popup        Popup        (offline)          │
│                      │            │              │              │
└──────────────────────┼────────────┼──────────────┼──────────────┘
                       │            │              │
                       ▼            ▼              ▼
┌──────────────────────────────────────────────────────────────────┐
│                          Backend API                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  POST /api/translate ──────► LibreTranslate (Docker :5000)       │
│  GET  /api/translate/languages                                   │
│                                                                  │
│  GET  /api/dictionary/{lang}/{word} ──► Free Dictionary API      │
│                                                                  │
│  GET    /me/highlights/{editionId}                               │
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

### Dictionary API

**GET /api/dictionary/{lang}/{word}**
```json
// Response 200
{
  "word": "silence",
  "phonetic": "/ˈsaɪ.ləns/",
  "definitions": [
    {
      "partOfSpeech": "noun",
      "definitions": [
        {
          "definition": "The absence of any sound.",
          "example": "The silence was deafening."
        }
      ]
    }
  ]
}

// Response 404 - word not found
// Response 400 - word too long (>100 chars)
```

**Backend:** Proxies to [Free Dictionary API](https://dictionaryapi.dev/).

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
| `HighlightLayer` | SVG overlay rendering highlight rectangles |
| `TranslationPopup` | Shows translation with language selectors |
| `DictionaryPopup` | Shows word definition, phonetic, examples |
| `NoteEditor` | Inline note editor for highlights |
| `useHighlights` | CRUD + offline sync to IndexedDB |
| `useTextTranslation` | Translation API with caching |
| `useDictionary` | Dictionary API with caching |

## IndexedDB Schema

**Store: `highlights`** (DB_VERSION = 5)

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

**Indexes:** `editionId`, `chapterId`, `syncStatus`

## UX Behavior

1. **Selection:** Toolbar appears only on drag selection (not double-click)
2. **Highlight:** Click color → text highlighted, saved to IndexedDB
3. **Dictionary:** Only shown for single words (no spaces, ≤50 chars)
4. **Translation:** Available for any selection up to 500 chars
5. **Notes:** Click highlight → NoteEditor popup
6. **Offline:** Highlights work offline, translation shows "unavailable"

## Docker Services

```yaml
# docker-compose.yml
libretranslate:
  image: libretranslate/libretranslate:latest
  ports:
    - "5000:5000"
  environment:
    - LT_LOAD_ONLY=en,uk,ru,de,fr,es,pl
```

## Configuration

```json
// appsettings.json
{
  "LibreTranslate": {
    "BaseUrl": "http://libretranslate:5000"
  }
}
```

## Files

| Area | Files |
|------|-------|
| Backend Endpoints | `Api/Endpoints/HighlightsEndpoints.cs`, `TranslationEndpoints.cs`, `DictionaryEndpoints.cs` |
| Entity | `Domain/Entities/Highlight.cs` |
| Frontend Hooks | `hooks/useHighlights.ts`, `useTextSelection.ts`, `useTextTranslation.ts`, `useDictionary.ts` |
| Frontend Components | `components/reader/SelectionToolbar.tsx`, `HighlightLayer.tsx`, `TranslationPopup.tsx`, `DictionaryPopup.tsx`, `NoteEditor.tsx` |
| Frontend API | `api/translation.ts`, `api/dictionary.ts` |
| Text Anchor | `lib/textAnchor.ts` |
| Tests | `lib/textAnchor.test.ts`, `HighlightsEndpointTests.cs`, `TranslationEndpointTests.cs`, `DictionaryEndpointTests.cs` |

## Testing

```bash
# Backend tests
dotnet test --filter "Highlights|Translation|Dictionary"

# Frontend tests
pnpm -C apps/web test
```
