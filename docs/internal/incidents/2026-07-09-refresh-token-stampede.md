# Spurious 'Unauthorized' mid-session (refresh-token stampede)

**Date:** 2026-07-09
**Status:** Resolved

## Impact

Readers were logged out mid-session for no reason.

## Root cause

Concurrent requests each triggered their own refresh; the rotated token invalidated the others.

## Fix

Single-flight the refresh.

## Lesson

Token rotation turns concurrent refreshes into mutual invalidation. Single-flight it.

## Detection

User-visible: readers were logged out mid-session and said so.

---

## Full write-up

*Preserved verbatim from the CHANGELOG entry of 2026-07-09. This is the long-form record — the source
material for articles and the detail a future reader needs.*

Fixed the reader dead-ending on **"Error loading chapter — Unauthorized"** after ~an hour, even though the user was still signed in (Google/email). Root cause: the access token expires at 60 min, and the reader fires many authenticated requests in parallel (chapter, book, progress, bookmarks…), so they all 401 at the same instant and each independently called `/auth/refresh`. The server **rotates** the refresh token on every refresh (deletes the presented token, issues a new one), so only the first concurrent refresh won — the rest presented the now-deleted token and got 401, surfacing as a spurious mid-session logout. Fix: `refreshToken()` in `apps/web/src/api/auth.ts` is now **single-flight** — concurrent callers share one in-flight `/auth/refresh`, so there's exactly one rotation and one fresh cookie, then every caller retries. This makes silent refresh reliable, so an active user stays signed in across the full rotating refresh-token window (i.e. until they explicitly log out or are inactive past the TTL) instead of being bounced hourly. Pure client change, no backend/token-config change. `tsc` clean, `vite build` green, **22 auth/api vitest** green (3 new: concurrent-dedup, fresh-request-after-settle, lock-clears-on-failure). Mobile (`apps/mobile/src/lib/api.ts`) already single-flights refresh — not affected.
