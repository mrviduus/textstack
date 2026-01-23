# 🔴 PRIORITY TODO List

**Created:** 2026-01-23

---

## Task 1: SSG Cleanup (Atomic Swap)

**Priority:** HIGH
**Time:** ~1 hour

### Problem

При SSG rebuild orphan files (удалённые книги) остаются на диске.

## Solution

Atomic swap: build to temp → swap → delete old.

## Implementation Plan

См. полный план: `~/.claude/plans/drifting-foraging-quasar.md`

## Quick Summary

| Slice | File | Time |
|-------|------|------|
| 1 | `prerender.mjs` — add `--output-dir` | 15 min |
| 2 | `ssg-worker.mjs` — atomic swap | 30 min |
| 3 | `deploy.yml` — update CI/CD | 10 min |
| 4 | `Makefile` — new targets | 5 min |
| 5 | `SSG_REBUILD.md` — docs | 10 min |

**Total: ~1 hour**

## Start Command

```bash
claude
# Then say: "Implement SSG cleanup plan from TODO-SSG-CLEANUP.md"
```

---

## Task 2: SEO Fields Not Used in SSG ✅ DONE

**Priority:** HIGH
**Time:** ~30 min

### Problem

SEO поля из админки НЕ используются:

| Field | Admin | SSG Output |
|-------|-------|------------|
| MetaTitle | "White Fang by Jack London - Read Free Online" | "White Fang \| TextStack" ❌ |
| MetaDescription | Custom SEO description | Full book description ❌ |

### Root Cause

1. `GET /books/{slug}` API не возвращает `metaTitle`, `metaDescription`
2. `BookDetailPage.tsx` не использует SEO поля
3. `SeoHead` получает только `title` и `description`

### Fix

**Backend (BooksEndpoints.cs):**
```csharp
MetaTitle = edition.MetaTitle,
MetaDescription = edition.MetaDescription,
```

**Frontend (BookDetailPage.tsx):**
```typescript
<SeoHead
  title={book.metaTitle || book.title}
  description={book.metaDescription || book.description}
/>
```

### Test

После фикса + SSG rebuild:
```bash
curl -s https://textstack.app/en/books/white-fang | grep '<title>'
# Expected: "White Fang by Jack London - Read Free Online | TextStack"
```

---

*Добрых снов! 🌙*
