import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The web app must not call `@textstack/shared`'s API clients.
 *
 * `packages/shared/src/api/*` routes every request through its `authFetch`, which reads base URL and
 * token from `initApi()`. **Only the mobile app calls `initApi`** — the web app has its own
 * `authFetch` because its token lives in a cookie (`credentials: 'include'`), not a header. A shared
 * API call made from the web therefore throws "API not initialized" before it reaches the network.
 *
 * Not hypothetical. `BookInsightsSection` imported `insightsApi` from the shared package and
 * swallowed the rejection with `.catch(() => {})` — a reasonable posture for a supplementary panel —
 * so the конспект section, the destination of the entire assistant handoff, never rendered on the web
 * at all. Its own unit test stayed green throughout, because it mocked `@textstack/shared` and so
 * replaced the broken dependency with a working one. A test that mocks the thing that is broken
 * cannot see it; this file looks at the imports instead.
 *
 * Types, pure helpers and constants from the shared package are fine and used everywhere. Only the
 * api clients are the problem. Add one to this list the day it is written, not the day it breaks.
 */
const API_CLIENTS = [
  'insightsApi', 'vocabularyApi', 'readingProgressApi', 'libraryApi',
  'highlightsApi', 'userBooksApi', 'authApi', 'createBooksApi',
]

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* sourceFiles(full)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) yield full
  }
}

describe('web never calls the shared API clients', () => {
  it('because the web app does not initialise them', () => {
    // dirname(fileURLToPath(...)) rather than URL.pathname: the latter drops the leading
    // path on some platforms and resolved to a bare '/src' here.
    const root = dirname(dirname(fileURLToPath(import.meta.url)))
    const offenders: string[] = []

    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8')
      // Only imports FROM the shared package matter; a local symbol of the same name is fine.
      const imports = src.match(/import\s+\{[^}]*\}\s+from\s+'@textstack\/shared'/g) ?? []
      for (const stmt of imports) {
        for (const client of API_CLIENTS) {
          if (new RegExp(`\\b${client}\\b`).test(stmt)) {
            offenders.push(`${relative(root, file)} imports ${client}`)
          }
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
