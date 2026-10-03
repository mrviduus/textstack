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
failed run. It ships in **build 28** (2026-09-27), submitted to Internal. Getting it
to the Closed track is a **promotion in Play Console**, not a second submit: Play
identifies a release by `versionCode`, so `eas submit` on an already-uploaded build
fails with "You've already submitted this version of the app." One build reaches one
track per upload — which is why 2026-09-11 shows two submissions and they were two
different builds, 26 and 27. Since then a refusal starts the build itself rather than
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
has the others. A new **column** is not: `chapters.chapter_id` (2026-09-28) is
declared in the `CREATE` for fresh installs and added by an `ALTER TABLE` in a
`try` for every install that already had the table, which is how SQLite does
`ADD COLUMN IF NOT EXISTS`. Rows written before it keep a NULL and stay readable.

### What is cached, and what is not

Chapters **and, since 2026-09-27, the original file of a PDF upload**
(`src/lib/originalFileCache.ts`, `Paths.document/originals/<bookId>.pdf`, 2 GB
budget with LRU eviction). A PDF therefore opens offline in the same
Original layout it has online — same coordinate space, nothing suppressed, no
images missing. It used to be substituted with its extracted text, which was
worse than it sounds: ADR-012 also dropped inline image extraction, on the
reasoning that the PDF renders its own images — true only while the PDF is the
thing being rendered.

The reflow substitution is still the fallback when the original is absent
(evicted, or a download that failed), and that fallback has a hazard worth
knowing about. The offline session produces a
chapter-space position (`scroll:<slug>:<offset>`) while the book's stored
position is a page (`page:<N>`). If the connection returns mid-chapter, an
ordinary progress write would overwrite the reader's real page with a coordinate
from a different space. `useUserBookReaderSource` suppresses the **server** write
for exactly that case (`offlineReflowOfPdfRef`) and keeps the local one, so the
offline session still resumes itself.

### Reading order: device first, always

Both chapter loaders read SQLite **before** the network, and the server's answer
only refreshes the stored row (`refreshCachedChapter`, an `UPDATE` that leaves
`cached_at` alone — the insert-or-replace would reorder the offline table of
contents, which has no chapter number to sort by). The rendered chapter is never
swapped, or position restoration re-runs under someone mid-page.

This was network-first until 2026-09-28, with the cache as the failure path. That
is fine on a plane, where `fetch` rejects in milliseconds, and wrong on every
network that is *present but useless* — a captive portal, a tunnel, hotel Wi-Fi
that opens the socket and never answers — where the reader waited out the whole
timeout in front of a downloaded book. Infinite scroll was worse: the catalogue
appender read no cache at all, and its failure branch is
`disableInfiniteScroll()`, so a downloaded catalogue book scrolled to the bottom
of chapter one and then quietly stopped. (Infinite scroll is gone since 2026-10-03;
its successor is `ensureChapter`, which puts the next chapter on the device when the
end-of-chapter block scrolls into view — SQLite first, then network, and a row
written for a book that was never downloaded is harmless: nothing lists it.)
`chapterLoadOrder.test.ts` pins all four call sites, because nothing in CI can feel
any of this.

### Deleted elsewhere, deleted here

The automatic sweep removes downloads whose book the account no longer has
(`chooseOrphanedDownloads`). Its safety is entirely in *where* it runs: the one
place that has just asked the server what the library is, where a failed listing
throws rather than returning an empty one — so an empty answer means the reader
deleted everything, not that the server was unreachable.

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
| `apps/mobile/src/lib/shareOriginal.ts` | Hands back the uploaded file — from disk when it is there, so no network |
| `apps/mobile/src/components/reader/useUserBookReaderSource.ts` | Cache-first chapter, TOC and resume for uploads |
| `apps/mobile/src/hooks/useReaderChapter.ts` | Cache-first chapter for the catalogue |
| `apps/mobile/src/lib/originalFileCache.ts` | Stored originals: download, LRU touch, eviction |
| `apps/mobile/src/lib/autoDownloadPolicy.ts` | What to fetch unasked, and what to remove |
