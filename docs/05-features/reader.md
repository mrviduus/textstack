# Reader

Kindle-like reading experience with customization, progress tracking, and offline support.

## Features Overview

| Feature | Description |
|---------|-------------|
| Pagination | Page-based reading with smooth transitions |
| Progress sync | Auto-saves position locally + server (auth) |
| Customization | Font, size, theme, width, line height |
| Fullscreen | Immersive mode with auto-hiding bars |
| Keyboard | Arrow keys, F for fullscreen, ? for help |
| Mobile | Swipe navigation, tap zones, immersive mode |
| Offline | Cache-first loading from IndexedDB |
| Bookmarks | Save/manage reading positions |
| In-book search | Find text within chapter |

## Page Structure

```
┌────────────────────────────────────────────────────────┐
│                    ReaderTopBar                         │
│  [Back] [Title] [Settings] [TOC] [Search] [Fullscreen] │
├────────────────────────────────────────────────────────┤
│                                                        │
│                   ReaderContent                        │
│                                                        │
│     ┌────────────────────────────────────────┐        │
│     │                                        │        │
│     │           Chapter Content              │        │
│     │          (paginated view)              │        │
│     │                                        │        │
│     └────────────────────────────────────────┘        │
│                                                        │
│  [←]                                            [→]   │
│                   ReaderPageNav                        │
├────────────────────────────────────────────────────────┤
│                  ReaderFooterNav                       │
│  [Prev Chapter] [Page X/Y] [Progress %] [Next Chapter] │
└────────────────────────────────────────────────────────┘
```

## Settings

### Typography

| Setting | Options | Default |
|---------|---------|---------|
| Font size | 14-28px | 18px |
| Line height | 1.2-2.0 | 1.6 |
| Font family | Serif, Sans-serif, System | Serif |
| Text align | Left, Justify | Left |

### Layout

| Setting | Options | Default |
|---------|---------|---------|
| Column width | 400-900px | 700px |
| Theme | Light, Sepia, Dark | Light |

### Storage

Settings persisted in localStorage as `reader.settings`:
```json
{
  "fontSize": 18,
  "lineHeight": 1.6,
  "maxWidth": 700,
  "theme": "light",
  "fontFamily": "serif",
  "textAlign": "left"
}
```

## Progress Tracking

### Local Storage

Key: `reading.progress.{editionId}`
```json
{
  "chapterSlug": "chapter-1",
  "locator": "page:5",
  "percent": 0.15,
  "updatedAt": 1704067200000
}
```

### Server Sync (Authenticated)

```
POST /me/progress
{
  "editionId": "uuid",
  "chapterId": "uuid",
  "locator": "page:5",
  "percent": 0.15
}
```

### Progress Calculation

```typescript
// Word-count based overall progress
const totalWords = chapters.reduce((sum, c) => sum + c.wordCount, 0)
const wordsBeforeCurrent = chapters.slice(0, currentIndex).reduce(...)
const wordsRead = wordsBeforeCurrent + currentChapter.wordCount * pageProgress
overallProgress = wordsRead / totalWords
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `←` / `↑` | Previous page |
| `→` / `↓` | Next page |
| `Home` | First page |
| `End` | Last page |
| `F` | Toggle fullscreen |
| `Esc` | Exit fullscreen / Close drawer |
| `?` | Show shortcuts help |
| `Ctrl+F` | In-book search |

## Mobile Experience

### Tap Zones

```
┌─────────────────────────────────────┐
│           TOP (toggle bars)         │
├─────────┬───────────────┬───────────┤
│         │               │           │
│  LEFT   │    CENTER     │   RIGHT   │
│  (prev) │ (toggle bars) │  (next)   │
│         │               │           │
├─────────┴───────────────┴───────────┤
│          BOTTOM (toggle bars)        │
└─────────────────────────────────────┘
```

### Immersive Mode

- Auto-hides bars after 3 seconds
- Tap center to show temporarily
- Double-tap to toggle fullscreen

### Swipe Navigation

- Swipe left → Next page
- Swipe right → Previous page

## Offline Loading

Cache-first strategy:

```typescript
// 1. Check IndexedDB cache
const cached = await getCachedChapter(editionId, chapterSlug)
if (cached) {
  setChapter(cached)  // Instant render
  return
}

// 2. Fetch from API
const chapter = await api.getChapter(bookSlug, chapterSlug)

// 3. Cache for next time
await cacheChapter(editionId, chapter)
```

## Bookmarks

### Structure

```typescript
interface Bookmark {
  id: string
  editionId: string
  chapterSlug: string
  locator: string    // "page:5"
  title?: string     // User label
  createdAt: number
}
```

### Auto-save Indicator

- Visual bookmark icon shows current position is auto-saved
- Toast notification on first auto-save: "Auto-saved"

## In-Book Search

### Features

- Real-time search within chapter HTML
- Highlight all matches
- Navigate between matches (prev/next)
- Clear search

### Implementation

```typescript
const { query, matches, activeMatchIndex, search, nextMatch, prevMatch } =
  useInBookSearch(chapter.html)
```

## Drawers

### TOC Drawer (Table of Contents)

- Chapter list with current highlighted
- Click to navigate
- Shows auto-save position

### Settings Drawer

- Font size slider
- Line height slider
- Width slider
- Theme picker (light/sepia/dark)
- Font family picker
- Text alignment

### Search Drawer

- Search input
- Match count display
- Prev/Next navigation

## Auto-Library Add

Automatically adds book to library when:
- User reaches page 2, OR
- 1% overall progress (for single-page chapters)

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/pages/ReaderPage.tsx` | Main reader page (~800 lines) |
| `apps/web/src/hooks/useReaderSettings.ts` | Settings state & persistence |
| `apps/web/src/hooks/useReaderKeyboard.ts` | Keyboard shortcut handling |
| `apps/web/src/hooks/usePagination.ts` | Page calculations |
| `apps/web/src/hooks/useReadingProgress.ts` | Progress sync (local + server) |
| `apps/web/src/hooks/useRestoreProgress.ts` | Restore position on load |
| `apps/web/src/hooks/useScrollReader.ts` | Continuous scroll mode (mobile) |
| `apps/web/src/hooks/useBookmarks.ts` | Bookmarks CRUD |
| `apps/web/src/hooks/useInBookSearch.ts` | Chapter text search |
| `apps/web/src/hooks/useSwipe.ts` | Touch navigation |
| `apps/web/src/hooks/useFullscreen.ts` | Fullscreen API wrapper |
| `apps/web/src/components/reader/` | UI components |

### Reader Components

| Component | Purpose |
|-----------|---------|
| `ReaderTopBar` | Header with actions |
| `ReaderContent` | Paginated content view |
| `ScrollReaderContent` | Continuous scroll view |
| `ReaderFooterNav` | Navigation footer |
| `ReaderPageNav` | Side arrows |
| `ReaderSettingsDrawer` | Settings panel |
| `ReaderTocDrawer` | Table of contents |
| `ReaderSearchDrawer` | In-book search |
| `ReaderShortcutsModal` | Keyboard shortcuts help |

## CSS

Reader-specific styles in `apps/web/src/styles/reader.css`:

- Theme variables (colors, backgrounds)
- Typography scaling
- Page transitions
- Mobile adaptations
- Fullscreen mode
- Drawer animations

## Network Recovery

`useNetworkRecovery` hook handles:
- Tab sleep/wake detection
- Auto-retry on network failure
- Abort signal cleanup
