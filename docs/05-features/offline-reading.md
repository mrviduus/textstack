# Offline Reading

PWA-style offline reading via IndexedDB chapter caching.

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
