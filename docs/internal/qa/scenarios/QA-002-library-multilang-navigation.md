# QA-002: Library Navigation for Multi-Language Books

**Area**: Library, Localization, Navigation
**Priority**: High
**Last Tested**: 2026-01-22
**Status**: Passed

---

## Preconditions

- [ ] User is logged in
- [ ] At least one book in Ukrainian (`uk`) language exists
- [ ] At least one book in English (`en`) language exists
- [ ] Both books are added to user's library

## Steps

### 1. Add Books to Library

1. Navigate to `/en/books` (English books list)
2. Open any English book and read until >1% (auto-add to library)
3. Navigate to `/uk/books` (Ukrainian books list)
4. Open any Ukrainian book and read until >1% (auto-add to library)

**Verify**:
- [ ] Both books appear in My Library

### 2. Test Library Navigation (Different UI Language)

1. Navigate to `/en/library` (library page in English UI)
2. Click on the **Ukrainian** book

**Verify**:
- [ ] Book opens correctly at `/uk/books/{slug}`
- [ ] Page loads without 404 error
- [ ] Reading position is restored (if any)

### 3. Test Reverse Navigation

1. Navigate to `/uk/library` (library page in Ukrainian UI)
2. Click on the **English** book

**Verify**:
- [ ] Book opens correctly at `/en/books/{slug}`
- [ ] Page loads without 404 error
- [ ] Reading position is restored (if any)

### 4. Test Continue Reading with Progress

1. Read Ukrainian book to ~20%
2. Exit to main page
3. Go to `/en/library` (English UI)
4. Click "Continue Reading" or the book card

**Verify**:
- [ ] Opens at `/uk/books/{slug}/{chapterSlug}`
- [ ] Exact reading position restored
- [ ] Progress bar shows correct percentage

---

## Expected Results

| Check | Expected |
|-------|----------|
| Library shows books | All languages mixed in one list |
| Click UK book from EN library | Opens `/uk/books/...` |
| Click EN book from UK library | Opens `/en/books/...` |
| Resume reading | Correct language prefix + chapter |

---

## Bug History

| Date | Issue | Fix |
|------|-------|-----|
| 2026-01-22 | Library links used UI language instead of book language | Added `language` field to `LibraryItemDto`, use `Link` with book language |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| 2026-01-22 | Claude | ✅ Pass | Fix verified: UK book from EN library → /uk/..., EN book from UK library → /en/... |
