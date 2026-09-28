import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Expo-router resolves routes from the file tree, so a wrong path literal is not a
 * type error — it silently falls through to `app/+not-found.tsx`, whose remap only
 * fires for `/en|/uk`-prefixed deep links. The user just gets "Page not found".
 *
 * Two such literals shipped at once: `/auth/login` (the file is `app/(auth)/login.tsx`)
 * and `/books/{slug}` (the detail screen is `app/book/[slug].tsx`; `/books` is the
 * plural list). The second made every catalog item in every library shelf a dead tap.
 *
 * This is a stopgap until routes move behind typed builders. It is deliberately dumb:
 * it greps, it names the file, it fails loudly.
 */

const ROOTS = ['app', 'src']
const SKIP_DIRS = new Set(['node_modules', '__snapshots__'])

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /['"`]\/auth\/login/,
    why: "no such route — the login screen is `app/(auth)/login.tsx`, so use '/(auth)/login'",
  },
  {
    pattern: /['"`]\/books\/\$\{/,
    why: "no such route — `/books` is the list; the detail screen is `/book/{slug}`",
  },
  {
    pattern: /export\/epub/,
    why: 'deleted 2026-09-28 (both routes) — the app shares the stored original instead, via `shareOriginal.ts`',
  },
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('route literals', () => {
  const files = ROOTS.flatMap(r => walk(r))

  it('finds source files to scan', () => {
    // Guards against the walk silently returning [] and the suite passing vacuously.
    expect(files.length).toBeGreaterThan(50)
  })

  for (const { pattern, why } of FORBIDDEN) {
    it(`has no ${pattern.source} — ${why}`, () => {
      const offenders = files.filter(f => pattern.test(readFileSync(f, 'utf8')))
      expect(offenders).toEqual([])
    })
  }
})
