# QA-004: Bookmarks & Autosave

**Area**: Reader, Bookmarks, Progress Sync
**Priority**: High
**Last Tested**: —
**Status**: Not tested

---

## Preconditions

- [ ] Clear IndexedDB: `textstack-reader` database
- [ ] Clear localStorage: `reading.progress.*` keys
- [ ] Have a book with multiple chapters available

---

## Issue to Investigate

**"Bookmarks always active"** - bookmark icon shows as filled when it shouldn't.

Possible causes:
1. `bookSlug` passed to `useBookmarks()` is incorrect/empty
2. IndexedDB has stale data from old sessions
3. CSS/SVG fill state issue
4. Multiple bookmarks for same chapter

---

## Part 1: Bookmarks

### Storage
- IndexedDB store: `bookmarks`
- Key: `id` (generated: `{timestamp}-{random}`)
- Indexed by: `bookId` (bookSlug), `createdAt`

### TC-B1: Add Bookmark

1. Open reader on any chapter
2. Click bookmark icon (should be empty/unfilled)

**Verify**:
- [ ] Icon fills after click
- [ ] Bookmark appears in TOC drawer → Bookmarks tab

### TC-B2: Remove Bookmark

1. Have a bookmarked chapter
2. Click filled bookmark icon

**Verify**:
- [ ] Icon unfills
- [ ] Bookmark removed from drawer

### TC-B3: Bookmark Persists Across Sessions

1. Add bookmark
2. Close tab, reopen same book

**Verify**:
- [ ] Bookmark still exists

### TC-B4: Bookmarks Tab Display

1. Add bookmarks to different chapters
2. Open TOC drawer → Bookmarks tab

**Verify**:
- [ ] All bookmarks listed with chapter titles
- [ ] Sorted newest first

### TC-B5: Delete from Drawer

1. Open Bookmarks tab
2. Click X on a bookmark

**Verify**:
- [ ] Bookmark removed
- [ ] Icon in top bar updates if on that chapter

### TC-B6: No Duplicate Bookmarks

1. Navigate to chapter
2. Click bookmark icon twice

**Verify**:
- [ ] Only one bookmark created (dedup logic in `addBookmark`)

### TC-B7: Scroll Mode (Mobile)

1. Open reader on mobile/narrow viewport
2. Scroll to different chapter
3. Add bookmark

**Verify**:
- [ ] Bookmark uses `visibleChapterSlug` from scroll reader

### TC-B8: "Always Active" Bug

1. Open fresh incognito window
2. Navigate to reader with NO bookmarks

**Verify**:
- [ ] Bookmark icon should be EMPTY (not filled)
- [ ] DevTools → IndexedDB → textstack-reader → bookmarks is empty

---

## Part 2: Autosave (Reading Progress)

### Storage
- localStorage: `reading.progress.{editionId}`
- Server API: `PUT /me/progress/{editionId}` (authenticated only)

### TC-A1: Auto-Save on Page Change (Desktop)

1. Open reader in pagination mode
2. Navigate to page 3
3. Check localStorage

**Verify**:
- [ ] `reading.progress.{editionId}` updated with `locator: "page:2"`

### TC-A2: Auto-Save on Scroll (Mobile)

1. Open reader on mobile
2. Scroll to different chapter
3. Wait 600ms (debounce)
4. Check localStorage

**Verify**:
- [ ] Progress saved with `locator: "scroll:{slug}:{offset}"`

### TC-A3: Time-on-Position Trigger

1. Stay on same page for 3+ seconds
2. Check localStorage

**Verify**:
- [ ] Progress saved (ADR-007 section 3.2)

### TC-A4: Visibility Change Trigger

1. Start reading
2. Switch to another tab (or minimize)

**Verify**:
- [ ] Progress flushed via `visibilitychange` event

### TC-A5: Page Unload Trigger

1. Start reading
2. Navigate away or close tab

**Verify**:
- [ ] Progress saved via `beforeunload` + `sendBeacon`

### TC-A6: Restore Progress on Reopen

1. Read to chapter 3, page 5
2. Close tab
3. Reopen same book

**Verify**:
- [ ] Automatically redirects to chapter 3
- [ ] Restores page 5

### TC-A7: Direct Navigation Skip

1. Save progress at chapter 3
2. Click chapter 1 from TOC (adds `?direct=1`)

**Verify**:
- [ ] Opens chapter 1
- [ ] Does NOT redirect to chapter 3

### TC-A8: Auto-Save Info in Drawer

1. Read partway through book
2. Open TOC drawer → Bookmarks tab

**Verify**:
- [ ] "Auto-saved" entry appears with chapter name

### TC-A9: Server Sync (Authenticated)

1. Log in
2. Read and change pages
3. Check Network tab

**Verify**:
- [ ] `PUT /api/me/progress/{editionId}` after 2s debounce

### TC-A10: Offline Fallback

1. Disconnect network
2. Change pages

**Verify**:
- [ ] Saves to localStorage (no errors)

---

## Debug Commands (Console)

```js
// List all bookmarks
indexedDB.open('textstack-reader', 2).onsuccess = e => {
  e.target.result.transaction('bookmarks').objectStore('bookmarks').getAll().onsuccess = r => console.log(r.target.result);
};

// Check reading progress
Object.keys(localStorage).filter(k => k.startsWith('reading.progress')).map(k => ({key: k, val: JSON.parse(localStorage[k])}));

// Clear all bookmarks (for testing)
indexedDB.open('textstack-reader', 2).onsuccess = e => {
  e.target.result.transaction('bookmarks', 'readwrite').objectStore('bookmarks').clear();
};
```

---

## Expected Results

| Check | Expected |
|-------|----------|
| Add bookmark | Icon fills, appears in drawer |
| Remove bookmark | Icon unfills, removed from drawer |
| Fresh session | Bookmark icon empty |
| Page change | localStorage updated |
| Tab switch | Progress flushed |
| Reopen book | Position restored |

---

## Actual Issues Observed

| Date | Issue | Status |
|------|-------|--------|
| — | "Bookmark always active" - needs investigation | Open |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| — | — | — | — |
