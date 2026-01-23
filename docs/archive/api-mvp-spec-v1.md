# TextStack – API Contract (Public vs Authenticated)

This document defines the **API surface area** for TextStack MVP, grouped by access level.
Paths are suggestions; keep the access rules even if your route names differ.

---

## 0. Conventions

- **Public endpoints**: must not require authentication
- **Authenticated endpoints**: must require a valid session
- Errors:
  - `401` for unauthenticated access
  - `403` for authenticated but not authorized (admin only)
  - `404` for missing resources
- Pagination:
  - `page`, `pageSize` (or cursor) for lists

---

## 1. Public API (SEO + Reader)

### 1.1 Books
- [ ] `GET /books`
  - query: `q`, `author`, `lang`, `page`, `pageSize`
  - returns: list of books + minimal metadata

- [ ] `GET /books/{bookSlug}`
  - returns: book metadata + chapter list (id/slug/title/order)

### 1.2 Chapters
- [ ] `GET /books/{bookSlug}/chapters/{chapterSlug}`
  - returns: chapter HTML + navigation pointers (prev/next)

### 1.3 Search
- [ ] `GET /search?q={query}`
  - returns: results across chapters
  - each result includes: book, chapter, snippet, rank

---

## 2. Authentication

### 2.1 Google sign-in
- [ ] `GET /auth/google/start?returnUrl={url}`
  - starts OAuth challenge
  - redirects to Google

- [ ] `GET /signin-google`
  - OAuth callback handled by backend middleware
  - on success: issues session + redirects to returnUrl

### 2.2 Session
- [ ] `GET /me`
  - returns: current user profile (id, name, email)
  - `401` if not logged in

- [ ] `POST /auth/logout`
  - clears session cookie

---

## 3. Authenticated API (User Features)

### 3.1 My Library
- [ ] `GET /me/library`
  - list of saved books

- [ ] `POST /me/library/{bookId}`
  - adds a book to library (idempotent)

- [ ] `DELETE /me/library/{bookId}`
  - removes a book from library (idempotent)

### 3.2 Reading progress
- [ ] `GET /me/progress/{bookId}`
  - returns last saved progress (chapter + locator)

- [ ] `PUT /me/progress/{bookId}`
  - body: `{ chapterId, locator }`
  - updates progress (idempotent overwrite)

### 3.3 Bookmarks (Phase 4)
- [ ] `GET /me/bookmarks?bookId=...`
- [ ] `POST /me/bookmarks`
- [ ] `DELETE /me/bookmarks/{bookmarkId}`

### 3.4 Notes (Phase 4)
- [ ] `GET /me/notes?bookId=...`
- [ ] `POST /me/notes`
- [ ] `PUT /me/notes/{noteId}`
- [ ] `DELETE /me/notes/{noteId}`

---

## 4. Admin API (Ingestion)

Admin endpoints require **admin role** or equivalent protection.

### 4.1 Upload & ingestion
- [ ] `POST /admin/books/upload`
  - multipart file upload
  - returns: `{ bookId, jobId }`

- [ ] `GET /admin/ingestion/jobs`
  - returns: jobs list (status, errors)

- [ ] `GET /admin/ingestion/jobs/{jobId}`
  - returns: detailed job info

### 4.2 Publish controls (optional MVP)
- [ ] `POST /admin/books/{bookId}/publish`
- [ ] `POST /admin/books/{bookId}/unpublish`

---

## 5. Acceptance Criteria

- [ ] Public API allows full reading and search without login
- [ ] User features return `401` without auth
- [ ] Admin endpoints return `403` without admin privileges
- [ ] Frontend can complete Google login and return to the original page
