import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The web app uses `@textstack/shared`'s API clients, in cookie mode.
 *
 * Until 2026-10 it could not: the shared `authFetch` read its config from `initApi()`, which only
 * mobile called, and it sent a Bearer header while the web's session is a cookie. A shared call from
 * the web threw "API not initialized" — `BookInsightsSection` swallowed exactly that and the
 * конспект never rendered — so every `/me/*` endpoint was written twice.
 *
 * Now `api/client.ts` calls `initApi({ credentials: 'include', ... })` on import (and `main.tsx`
 * imports it first). The rule this file holds:
 *  1. that init exists, in cookie mode, with the refresh hook;
 *  2. no second transport grows back — the only other `authFetch` allowed is the session flow in
 *     `api/auth.ts` (login/refresh/logout must not recurse into the refresh-on-401 wrapper).
 */
const root = dirname(dirname(fileURLToPath(import.meta.url)))

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* sourceFiles(full)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full
  }
}

describe('web runs the shared API clients in cookie mode', () => {
  it('initialises them with credentials: include and a refresh hook', () => {
    const client = readFileSync(join(root, 'api/client.ts'), 'utf8')
    expect(client).toMatch(/initApi\(\{[\s\S]*credentials: 'include'[\s\S]*\}\)/)
    expect(client).toMatch(/onUnauthorized: \(\) => refreshToken\(\)/)
    expect(readFileSync(join(root, 'main.tsx'), 'utf8')).toMatch(/^import '\.\/api\/client'/)
  })

  it('has no second authFetch outside the session flow', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(root)) {
      const rel = relative(root, file)
      if (rel === join('api', 'auth.ts')) continue
      if (/function authFetch\b/.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
