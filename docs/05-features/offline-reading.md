# Offline Reading

Two implementations of one idea: cache the chapters, read without a connection.
**Web** uses IndexedDB and covers catalogue editions (below). **Mobile** uses
SQLite and covers *both* catalogue editions and the reader's own uploads
([Mobile](#mobile), added 2026-09-14).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Reader Page                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   1. Check IndexedDB cache                                  │
│      ↓ hit? serve cached                                    │
│      ↓ miss? fetch from API                                 │
│                                                             │
│   2. After API fetch → cache in IndexedDB                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Download Manager                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   DownloadContext (React Context)                           │
│     ├── downloads: Map<editionId, DownloadInfo>             │
│     ├── startDownload(editionId, slug, title, lang)         │
│     ├── cancelDownload(editionId)                           │
│     ├── isDownloading(editionId): boolean                   │
│     └── getProgress(editionId): number | null               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## IndexedDB Schema

Database: `textstack-reader` (version 2)

### Object Stores

| Store | Key | Purpose |
|-------|-----|---------|
| `chapters` | `${editionId}:${chapterSlug}` | Cached chapter HTML |
| `cachedBooks` | `editionId` | Book download metadata |
| `bookmarks` | `id` | Local bookmarks (v1 legacy) |

### CachedChapter

```typescript
interface CachedChapter {
  key: string           // "${editionId}:${chapterSlug}"
  editionId: string
  chapterSlug: string
  html: string          // Chapter content
  title: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
  cachedAt: number      // timestamp
}
```

### CachedBookMeta

```typescript
interface CachedBookMeta {
  editionId: string
  slug: string
  totalChapters: number
  cachedChapters: number
  cachedAt: number
}
```

## Download Flow

```
User clicks "Download for offline"
    ↓
DownloadContext.startDownload()
    ↓
Check storage quota (need 50MB+ free)
    ↓ fail → show error "Not enough storage"
    ↓ pass
    ↓
Fetch book metadata (GET /books/{slug})
    ↓
Initialize CachedBookMeta in IndexedDB
    ↓
For each chapter:
    ├── Skip if already cached (resume support)
    ├── Fetch chapter (GET /books/{slug}/chapters/{chapterSlug})
    ├── Cache in IndexedDB
    ├── Update progress
    └── 200ms delay (avoid server overload)
    ↓
Mark complete
```

## Resume Support

Downloads can be paused/resumed:

1. **Paused state**: User closes browser or cancels download
2. **Resume**: Click "Resume download" in menu
3. **Skip cached**: Loop checks `getCachedChapter()` before fetching
4. **Track progress locally**: Increment counter instead of querying IndexedDB

## UI Components

### OfflineBadge

Shows offline status on book cards:

| Status | Icon | Condition |
|--------|------|-----------|
| Full | Download icon | `cachedChapters >= totalChapters` |
| Downloading | Spinner | `partial && isDownloading` |
| Paused | Pause icon | `partial && !isDownloading` |
| None | (hidden) | No cached chapters |

### BookCardMenu

Kindle-style 3-dots menu:

- **View details** → Navigate to book page
- **Mark as read/unread** → Toggle read status
- **Download for offline** → Start download (if not cached)
- **Resume download** → Resume paused download
- **Cancel download** → Cancel active download
- **Remove download** → Delete cached data
- **Remove from library** → Unsave book

## Storage Limits

- **Minimum**: 50MB free required to start download
- **QuotaExceededError**: Caught and shown to user
- **Estimate API**: Uses `navigator.storage.estimate()` if available

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/lib/offlineDb.ts` | IndexedDB operations |
| `apps/web/src/context/DownloadContext.tsx` | Global download state |
| `apps/web/src/components/OfflineBadge.tsx` | Status indicator |
| `apps/web/src/components/library/BookCardMenu.tsx` | Context menu |
| `apps/web/src/pages/ReaderPage.tsx` | Cache-first chapter loading |

## Error Handling

| Error | Handling |
|-------|----------|
| Network failure | Mark chapter as failed, continue next |
| QuotaExceeded | Stop download, show "Storage full" |
| Unknown | Log error, continue with next chapter |

## Future Improvements

- [ ] Background sync via Service Worker
- [ ] Compression (gzip cached HTML)
- [ ] Smart preloading (next N chapters)
- [ ] Automatic stale cache cleanup

---

## Mobile

`apps/mobile`. Same shape as web, different store — `expo-sqlite`, in
`src/lib/offlineDb.ts` (with a no-op `offlineDb.web.ts` twin, because this app
also builds for web and expo-sqlite's web shim cannot be bundled there; **every
export must exist in both files** or the web bundle fails to resolve).

**Delivery: this needed a Play build, not an update, and that is why it was late.**
Landing on `main` (#612, 2026-09-14) put it on nobody's phone. The EPUB share sheet
below uses `expo-sharing` — a native module with a config plugin — so the runtime
fingerprint moved, and `app.json` sets `runtimeVersion: { policy: "fingerprint" }`:
an OTA can only reach builds whose fingerprint matches. `mobile-ota.yml` refused
correctly the same night and the feature waited twelve days for somebody to notice a
failed run. It ships in **build 28**, dispatched 2026-09-27 to Internal and then
submitted to Closed. Since then a refusal starts the build itself rather than
reporting that one is needed. If you add a native
module here, that is the path your change takes too: a build, and testers have to
install it before any later update can reach them.

### Tables

| Table | Key | Holds |
|---|---|---|
| `chapters` | `(edition_id, chapter_slug)` | Catalogue chapter HTML |
| `cached_books` | `edition_id` | Catalogue download meta |
| `user_chapters` | `(book_id, chapter_slug)` | Upload chapter HTML + ordinal + source page |
| `cached_user_books` | `book_id` | Upload download meta, incl. `is_pdf` |

The two pairs are parallel rather than one pair with a discriminator: an edition
id is public and shared, an upload id is private to one account, and the
catalogue rows carry a route slug an upload has no use for.

The schema script is all `CREATE TABLE IF NOT EXISTS` and runs on every cold
start, so **adding a table is the whole migration** for an install that already
has the others.

### What is cached, and what is not

Chapters. Not the original PDF of a PDF upload: the Original-layout viewer
streams it with Range requests and a Bearer token (ADR-012), which has no
offline form. Offline, a PDF upload opens in the reflow reader over its
extracted text, and the download button says so *before* the tap.

That fallback has a hazard worth knowing about. The offline session produces a
chapter-space position (`scroll:<slug>:<offset>`) while the book's stored
position is a page (`page:<N>`). If the connection returns mid-chapter, an
ordinary progress write would overwrite the reader's real page with a coordinate
from a different space. `useUserBookReaderSource` suppresses the **server** write
for exactly that case (`offlineReflowOfPdfRef`) and keeps the local one, so the
offline session still resumes itself.

### Resume, offline

`src/lib/progressStorage.ts` holds chapter slug, chapter percent, scroll offset,
serialised `TextPosition` and PDF page per upload. The server is the resume
authority whenever it can be reached; this record answers only when the request
cannot be made at all. Every field except `bookPercent` is assigned rather than
carried forward — a stale chapter slug beside a fresh page number is a record
that contradicts itself.

### Sign-out

Catalogue downloads survive it (an edition is public; the download belongs to the
device). Cached **uploads are wiped** — one account's private file must not be
left on disk for whoever signs in next.

### Key files

| File | Purpose |
|---|---|
| `apps/mobile/src/lib/offlineDb.ts` | SQLite operations (+ `.web.ts` stub) |
| `apps/mobile/src/context/DownloadContext.tsx` | One download loop for both libraries |
| `apps/mobile/src/lib/userBookChapters.ts` | The chapter key the download and the reader route must agree on |
| `apps/mobile/src/lib/cachedUserBookDetail.ts` | Rebuilds the detail payload from the cache |
| `apps/mobile/src/lib/exportEpub.ts` | Authenticated EPUB export → share sheet |
| `apps/mobile/src/components/reader/useUserBookReaderSource.ts` | Cache fallbacks for chapter, TOC, resume |
