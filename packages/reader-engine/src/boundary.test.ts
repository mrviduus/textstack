import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The engine's boundary (ADR-025), enforced by a test instead of a linter: no app code, no UI
 * framework, no network. Hosts own all of that; the engine is handed what it shows.
 */

const SRC = join(__dirname)

/** Module specifiers the engine may never load. */
const FORBIDDEN_MODULES: { rule: string; re: RegExp }[] = [
  { rule: 'imports from apps/', re: /(^|\/)apps\/|^@\// },
  { rule: 'imports React / React Native / Expo', re: /^(@?(react|react-dom|react-native|expo)(\/|-|$)|@(expo|react-native|react-navigation)\/)/ },
  { rule: "imports '@textstack/shared' (use a relative path: the mobile IIFE)", re: /^@textstack\/shared/ },
]
const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/

/** Every specifier: `from '…'`, side-effect `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : sources(p)
    return /\.m?[tj]sx?$/.test(e.name) && !/\.test\.m?[tj]sx?$/.test(e.name) ? [p] : []
  })
}

export function violations(files: { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text: raw }) => {
    // Comments may name what the code must not do; only code counts.
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const specs = [...text.matchAll(SPECIFIER)].map((m) => m[1])
    const found = FORBIDDEN_MODULES.filter(({ re }) => specs.some((s) => re.test(s))).map(({ rule }) => `${path}: ${rule}`)
    if (NETWORK.test(text)) found.push(`${path}: network (the host loads, the engine never does)`)
    return found
  })
}

describe('engine boundary', () => {
  it('src/ has no forbidden import or network call', () => {
    const files = sources(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }))
    expect(files.length).toBeGreaterThan(0)
    expect(violations(files)).toEqual([])
  })

  it('catches each forbidden kind, and names it', () => {
    const planted: [string, string][] = [
      ["import { x } from '../../../apps/web/src/lib/textAnchor'", 'apps/'],
      ["import { useState } from 'react'", 'React'],
      ['const r = await fetch(url)', 'network'],
      ["import { y } from '@/hooks/useApi'", 'apps/'],
      ["import 'react'", 'React'],
      ["const m = await import('expo-haptics')", 'React'],
      ["const r = require('react-native')", 'React'],
      ["import { t } from '@textstack/shared'", '@textstack/shared'],
      ['new WebSocket(url)', 'network'],
      ['navigator.sendBeacon(url, body)', 'network'],
      ["import {\n  a,\n} from 'react/jsx-runtime'", 'React'],
      ["import { I } from '@expo/vector-icons'", 'React'],
      ["import { N } from '@react-navigation/native'", 'React'],
    ]
    for (const [text, rule] of planted) {
      const v = violations([{ path: 'x.ts', text }])
      expect(v, text).toHaveLength(1)
      expect(v[0], text).toContain(rule)
    }
  })

  it('ignores comments and look-alike names', () => {
    const clean = [
      "// never fetch(url) here, never import from 'react'",
      '/* host does: await fetch(url) */',
      'refetch(); prefetch(); const fetchedAt = 1',
      "import { a } from '../../shared/src/reader/textAnchor'",
      "const url = 'https://example.com'",
    ]
    for (const text of clean) expect(violations([{ path: 'x.ts', text }]), text).toEqual([])
  })
})
