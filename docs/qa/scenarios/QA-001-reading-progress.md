# QA-001: Reading Progress, Navigation, and Auto-Save

**Area**: Reader, Library, Progress Sync
**Priority**: High
**Last Tested**: 2026-01-19
**Status**: Passed

---

## Preconditions

- [ ] User is logged in
- [ ] Personal library is empty (all books removed)
- [ ] No existing reading progress for test book (clear localStorage `reading.progress.*`)

## Steps

### 1. Start Reading a Book

1. Open the main page (`/`)
2. Select the first available book
3. Start reading the book
4. **Read until progress reaches >1%** (scroll/paginate enough)

**Verify**:
- [ ] Book is automatically added to **My Library** after **>1% progress** (not immediately)
- [ ] Book appears in library list with correct % shown

> **Note**: Auto-add triggers at >1% actual progress, not when book is first opened.

### 2. Read Through the Book

1. Continue reading until reaching a significant point (e.g., 20%+)
2. Progress should advance naturally as pages are read

**Verify**:
- [ ] Progress bar updates as reading progresses
- [ ] Progress percentage increases (check via localStorage or library)

### 3. Navigate via TOC (Direct Navigation)

1. Note current chapter and scroll position
2. Open TOC (table of contents) or book detail page
3. Select a **different chapter** (e.g., chapter 6)

**Verify**:
- [ ] Reader opens **directly at selected chapter start** (NOT at saved position)
- [ ] Chapter title updates correctly
- [ ] This behavior uses `?direct=1` param internally

> **Critical**: TOC/chapter links must go directly to chapter, not restore saved progress.

### 4. Exit and Resume via Library

1. Scroll partway into the new chapter (to save new position)
2. Navigate away (e.g., go to main page)
3. Open **My Library**
4. Click the same book from library

**Verify**:
- [ ] Reader opens at the **exact position where reading stopped** (not chapter start)
- [ ] Progress bar shows correct **overall book progress** (not chapter %)
- [ ] Navigation is responsive (no ignored clicks)

> **Critical**: Library links must restore saved progress (no `?direct=1`).

---

## Expected Results

| Check | Expected |
|-------|----------|
| Auto-add to library | After >1% progress |
| TOC navigation | Goes directly to selected chapter |
| Library resume | Restores exact saved position |
| Progress bar | Shows overall book % (not chapter %) |
| Auto-save | Position preserved in localStorage + server |

---

## Key Behavior Distinction

| Action | Behavior |
|--------|----------|
| Click chapter from TOC/book page | Direct navigation (`?direct=1`) |
| Click book from Library | Restore saved progress |
| "Start Reading" button | Direct to chapter 1 |

---

## Actual Issues Observed

_Document any bugs found during testing:_

| Date | Issue | Status |
|------|-------|--------|
| — | — | — |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| 2026-01-19 | Claude | ✅ Pass | All steps verified. TOC vs Library distinction working correctly. |
