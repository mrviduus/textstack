import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The engine's boundary (ADR-025), enforced by a test instead of a linter: no app code, no UI
 * framework, no network. Hosts own all of that; the engine is handed what it shows.
 */

const SRC = join(__dirname)

const FORBIDDEN: { rule: string; re: RegExp }[] = [
  { rule: 'imports from apps/', re: /from\s+['"][^'"]*\/apps\/|from\s+['"]@\// },
  { rule: 'imports React / React Native / Expo', re: /from\s+['"](react|react-dom|react-native|expo)[^'"]*['"]/ },
  { rule: 'fetches (the host loads, the engine never does)', re: /\bfetch\s*\(|XMLHttpRequest/ },
]

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sources(p)
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : []
  })
}

export function violations(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) =>
    FORBIDDEN.filter(({ re }) => re.test(text)).map(({ rule }) => `${path}: ${rule}`),
  )
}

describe('engine boundary', () => {
  it('src/ has no forbidden import or network call', () => {
    const files = sources(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))
    expect(files.length).toBeGreaterThan(0)
    expect(violations(files)).toEqual([])
  })

  it('catches each forbidden kind', () => {
    const planted = [
      { path: 'a.ts', text: "import { x } from '../../../apps/web/src/lib/textAnchor'" },
      { path: 'b.ts', text: "import { useState } from 'react'" },
      { path: 'c.ts', text: 'const r = await fetch(url)' },
      { path: 'd.ts', text: "import { y } from '@/hooks/useApi'" },
    ]
    expect(violations(planted)).toHaveLength(4)
  })
})
