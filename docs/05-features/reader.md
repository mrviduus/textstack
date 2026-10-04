# Reader

Kindle-like reading experience with customization, progress tracking, and offline support.

> Web section re-checked against `apps/web/src` on 2026-10-04. The web reader is a **vertical
> scroll over one chapter** (one chapter per document since #161) — there is no pagination, no
> page-flip keys and no swipe. PDF uploads render as the original document (ADR-012,
> `PdfOriginalView`).

## Features Overview (web)

| Feature | Description |
|---------|-------------|
| Scroll reading | One chapter per page, vertical scroll; prev/next chapter in `ReaderNav` / `ReaderFooterNav` |
| Progress sync | Text-anchor position (ADR-015), local + server |
| Customization | Font size, line height, font family, alignment, theme, TTS speed/voice |
| Immersive | Bars auto-hide after 3 s (`useImmersiveMode`) |
| Keyboard | `Esc` closes drawers / exits; `Ctrl/Cmd+F` opens in-book search |
| Offline | IndexedDB cache — see [offline-reading.md](offline-reading.md) |
| Bookmarks | `useReaderBookmarks` |
| In-book search | `useInBookSearch` + `SearchOverlayLayer` |
| Highlights / vocab / translate / explain / TTS | `ReaderHighlights` orchestrates the overlay layers |

## Settings

`ReaderSettings` in `apps/web/src/hooks/useReaderSettings.ts`, stored in localStorage as
`reader.settings.v1`. Defaults:

```json
{
  "fontSize": 18,              // 16-26
  "lineHeight": 1.8,           // 1.5 | 1.65 | 1.8
  "textAlign": "center",       // left | center | justify
  "theme": "light",            // light | sepia | dark
  "fontFamily": "serif",       // serif | sans | dyslexic
  "ttsSpeed": 1.0,             // 0.75-2.0
  "ttsVoiceEn": "en-US-AriaNeural",
  "showReaderStats": true,
  "showInlineTranslations": true
}
```

## Progress Tracking

- Local: `reading.progress.{editionId}` in localStorage.
- Server: `PUT /me/progress/{editionId}` with `percentUnit: "book"` (`apps/web/src/api/auth.ts`).
  Uploads use `PUT /me/books/{id}/progress`.
- Position is a text anchor, not a pixel — [ADR-015](../01-architecture/adr/ADR-015-reader-position-is-logical.md).
- Book-wide percent: `computeBookProgress` in `@textstack/shared` (keep the server formula in sync).

## Mobile Experience

### Native app: one chapter at a time (since 2026-10-03)

The Android/iOS reader (`apps/mobile`, a WebView) shows **one chapter per document**, like the web
reader since #161. It used to append the next chapter as you scrolled; that gave "which chapter is
the reader in" two answers (route vs. visible), which is where most ADR-015 position bugs lived, and
it misfiled highlights, toolbar chevrons and "Discuss" against the opened chapter.

At the end of the chapter, inside the document (not a modal), there is a block
(`src/lib/chapterEnd.ts` decides, `readerHtml.ts` → `__tsSetChapterEnd` draws):

- **Next: {title} ›** (full width, ≥56dp) with "n / N" under it
- **✦ Discuss this chapter** when the chapter is reviewable — saves progress first, then opens the
  reader's assistant (the server refuses a review beyond the saved progress)
- **‹ {previous title}**
- Last chapter: **You finished {book}** + Discuss + **Review {N} words** (if any were saved this
  visit) + **Back to library**

When the block scrolls into view the next chapter is put on the device (`ensureChapter`: SQLite
first, then network), so Next is instant and survives losing signal. Offline and not on the device,
the block says so and offers Retry. No swipe, no auto-advance (both fight word selection). The
footer chevrons stay.

A chapter change is `router.replace`, which **remounts** the reader screen. What belongs to the
visit — one reading session, the saved-word count, "finished a chapter" — is handed to the next
chapter through `src/lib/readerVisit.ts`, so a chapter turn neither ends the session nor resets the
counter. The session percent is book-wide, so finishing a chapter never marks the book complete.

### Gestures

No page tap zones and no swipe navigation — the reader scrolls, and swipe/auto-advance fight word
selection. The only swipe is swipe-down to close the image lightbox (`readerHtml.ts`). Bars
toggle on tap.

## Offline Loading

SQLite-first on mobile, IndexedDB on web — the details, and why it is cache-first rather than
network-first, are in [offline-reading.md](offline-reading.md).

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

- Font size, line height
- Theme (light/sepia/dark)
- Font family (serif/sans/dyslexic)
- Text alignment (left/center/justify)
- TTS speed, inline translations, stats widget

### Search Drawer

- Search input
- Match count display
- Prev/Next navigation

## Auto-Library Add

Catalog books are added to the library once overall progress reaches 1% (`ReaderPage.tsx`).

## Key Files (web)

| File | Purpose |
|------|---------|
| `apps/web/src/pages/ReaderPage.tsx` | Main reader page (~860 lines) |
| `apps/web/src/hooks/useReaderChapter.ts` | Chapter loading (public / userbook modes) |
| `apps/web/src/hooks/useReaderScrollSync.ts` | Scroll ↔ position sync |
| `apps/web/src/hooks/useReaderProgress.ts`, `useReadingProgress.ts`, `useRestoreProgress.ts` | Progress save/restore |
| `apps/web/src/hooks/useReaderSettings.ts` | Settings state & persistence |
| `apps/web/src/hooks/useReaderKeyboard.ts` | Esc / Ctrl+F |
| `apps/web/src/hooks/useReaderBookmarks.ts` | Bookmarks |
| `apps/web/src/hooks/useInBookSearch.ts` | Chapter text search |
| `apps/web/src/hooks/useImmersiveMode.ts` | Auto-hiding bars |
| `apps/web/src/components/reader/` | UI components |

### Reader Components

| Component | Purpose |
|-----------|---------|
| `ReaderTopBar` | Header with actions |
| `ReaderSection` | Chapter content |
| `ReaderNav` / `ReaderFooterNav` | Chapter navigation |
| `ReaderSettingsDrawer` / `ReaderTocDrawer` / `ReaderSearchDrawer` | Drawers |
| `ReaderHighlights` | Selection toolbar, translate/explain popups, TTS wiring |
| `PdfOriginalView` (+ `PdfPage`, `PdfHighlightLayer`) | PDF original layout |

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
