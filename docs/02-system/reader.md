# Reader Design Spec

> **Note**: This is the original design specification. For implementation details and current features, see [Reader Feature Docs](../05-features/reader.md).

This document defines a **Bookmate-like** reading experience for **TextStack**.
Goal: a **reading-first**, "product-like" UI with minimal distractions, optimized for **SEO chapter URLs** and fast iteration.

---

## 1. Goals

- **Reading-first**: text is the hero; UI is secondary.
- **Distraction-free**: chrome hides while reading.
- **Mobile + desktop**: equally comfortable.
- **SEO-friendly**: each chapter is a real URL with HTML content.
- **Persisted preferences**: reader settings saved locally (MVP) and later to user profile.
- **No monetization** in MVP (no banners, no paywall, no upsells inside the chapter).

---

## 2. Information Architecture

### Core routes
- **Book page**: `/books/:bookSlug`
- **Chapter reader**: `/books/:bookSlug/:chapterSlug`

### Reader must support
- Back to book page
- Prev/Next chapter
- Table of contents (TOC)
- Reader settings (Aa)
- Bookmark
- Progress indicator

---

## 3. Reader Layout

### Page container
- `min-height: 100vh`
- Calm “paper” background (not pure white)
- Centered content

### Text column
- Max width:
  - Mobile: full width with padding
  - Desktop: **720–840px**
- Horizontal padding:
  - Mobile: 16–20px
  - Desktop: 24–32px
- Vertical padding:
  - Top: 24–48px (depends on top bar)
  - Bottom: 72–120px (avoid “hard stop” at screen end)

### Principle
- **No sidebars** in MVP.
- TOC and Settings appear as overlays (drawer/modal).

---

## 4. Top Bar (Auto-hide)

### Behavior (critical)
Top bar is **hidden by default** while reading.

**Show top bar when:**
1. User scrolls **up** (even slightly)
2. User **taps/clicks** the page (or upper zone)

**Hide top bar when:**
- User scrolls **down**
- OR after **2.5–4 seconds** of inactivity (if no overlay is open)

### Content (left → right)
- Back button (`←`) to book page
- Book title + chapter title (truncate on small screens)
- Progress (`%` or `chapter x/y` minimal)
- Icons:
  - TOC
  - Aa (Settings)
  - Bookmark

### Placement & styling
- `position: fixed; top: 0; left: 0; right: 0`
- Backdrop blur + subtle shadow
- Height:
  - Mobile: ~52–56px
  - Desktop: ~56–64px

---

## 5. Typography

### Default values
- `font-size`: **18–20px**
- `line-height`: **1.65–1.8**
- `font-weight`: 400–500
- Paragraph spacing: ~0.85–1.1em

### Fonts
Offer **2–3 options max**:
- Serif (book-like)
- Sans (clean web-like)
- System fallback

### Chapter HTML normalization
Ensure consistent styling for:
- `h1/h2/h3`, `p`, `blockquote`, `ul/ol`, `hr`
- Images: `max-width: 100%`

---

## 6. Reader Settings (Aa) — Drawer / Popover

### Entry
- “Aa” button in top bar
- Mobile: bottom drawer (preferred)
- Desktop: right drawer or popover

### Settings (MVP)
1. **Font size**: 16–26 (step 1)
2. **Line height**: 1.5 / 1.65 / 1.8
3. **Column width**: Narrow / Normal / Wide
   - Narrow: 680px
   - Normal: 760px
   - Wide: 840px
4. **Theme**: Light / Sepia / Dark
5. **Font family**: Serif / Sans

### Persistence
- Save immediately to `localStorage`
- Key: `reader.settings.v1`

---

## 7. Themes (Light / Sepia / Dark)

### Rules
- Background should be calm and non-harsh.
- Text contrast must be strong enough but not “laser black on white”.
- Selection highlight should be subtle.

### Tokens (CSS variables)
Define variables for each theme:
- `--bg`
- `--fg`
- `--muted`
- `--border`
- `--selection`
- `--link`

Implementation suggestion:
- Apply theme via `html[data-theme="sepia"]` (and `light`, `dark`)
- Tailwind uses `var(--bg)` etc.

---

## 8. TOC (Table of Contents)

### Entry
- TOC icon in top bar

### UI
- Mobile: full-screen modal or bottom sheet
- Desktop: right drawer

### Content
- Chapter list with:
  - Title (and optional number)
  - Highlight current chapter
  - Optional “read” indicator (later)

### Optional (later)
- Search within TOC
- Filters (e.g., parts/sections)

---

## 9. Progress Tracking

### In-chapter progress
- Compute: `scrollTop / (scrollHeight - viewportHeight)`
- Display:
  - thin progress line under top bar **or**
  - small percent text in bar

### Save reading position (MVP)
- Store in `localStorage`:

Key format:
- `reader.progress.{bookId}` → JSON like:
  - `chapterSlug`
  - `scrollY` or `percent`
  - `updatedAt`

### Restore rules
- If user clicks **Continue reading** → restore saved position
- If user opens a chapter from TOC/book page → start at top (unless “resume” explicitly chosen)

Performance:
- Throttle scroll saves (e.g., every 200–400ms)

---

## 10. Bookmarks (MVP)

### Save action
Bookmark stores:
- `bookId`
- `chapterSlug`
- `scrollY` (or percent)
- `createdAt`

UI:
- Click → toast “Bookmark saved”
- Listing bookmarks can be deferred (MVP optional)

---

## 11. Prev/Next Chapter Navigation

### Footer navigation (required)
At the end of chapter:
- “← Previous chapter”
- “Next chapter →”

Buttons should be large and touch-friendly.

### Keyboard (desktop)
- Left/Right arrows → prev/next
- `Esc` closes overlay

---

## 12. Loading / Skeleton

While loading chapter content:
- Show text skeleton (3–6 lines)
- Keep column width stable to avoid layout jumps

---

## 13. Accessibility (baseline)

- Tap targets >= 44px on mobile
- Visible focus states for keyboard users
- Respect `prefers-reduced-motion`
- Contrast friendly themes

---

## 14. React Component Model

### Components
- `ReaderPage`
  - `ReaderTopBar` (auto-hide)
  - `ReaderContent` (renders chapter HTML)
  - `ReaderFooterNav` (prev/next)
  - `ReaderSettingsDrawer`
  - `ReaderTocDrawer`

### State
- Settings: context + localStorage sync
- Progress: throttled scroll listener
- Top bar: scroll direction + inactivity timer (disabled while overlays are open)

---

## 15. Don’ts (to keep the Bookmate-like vibe)

- Don’t keep a permanent big header while reading.
- Don’t add sidebars next to the text in MVP.
- Don’t insert ads or banners inside the chapter.
- Don’t over-animate. Keep transitions subtle.
- Don’t overload the book page with “marketplace” UI.

---

## 16. Implementation Status

**MVP Complete** (Jan 2025)

### Core Features ✅
- [x] Chapter reader route (`/books/:bookSlug/:chapterSlug`)
- [x] Centered text column with typography baseline
- [x] Auto-hide top bar (show on scroll up / tap, hide on scroll down / timeout)
- [x] Settings drawer (font size, line height, width, theme, font)
- [x] Settings persisted in localStorage
- [x] TOC drawer with current chapter highlight + bookmarks tab
- [x] Progress indicator (chapter + overall book)
- [x] Reading position persisted (localStorage + server sync)
- [x] Bookmark save/remove + toast
- [x] Prev/Next chapter footer nav
- [x] Skeleton loading states
- [x] Basic a11y pass (skip link, focus states)

### Enhanced Features ✅
- [x] Page-based pagination (column layout)
- [x] Keyboard shortcuts (←/→, F, B, S, T, ?, 1-4 for themes)
- [x] Swipe navigation (desktop)
- [x] Mobile tap zones (left/right edges for prev/next)
- [x] Mobile immersive mode (auto-hide bars after 3s)
- [x] Fullscreen mode with auto-show bars on mouse move
- [x] In-book search (chapter text only)
- [x] Auto-add to library after page 2
- [x] Auto-save indicator in top bar

### Future Enhancements
- [ ] Eye/head tracking scroll (see TODO.md)
- [ ] Text selection + notes
- [ ] Audio narration (TTS)

