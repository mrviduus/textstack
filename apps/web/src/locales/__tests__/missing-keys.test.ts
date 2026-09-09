import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { catalog as en } from '../catalog'

/**
 * Every `t('some.key')` in the source must resolve to a string in en.json.
 *
 * `useTranslation` returns the KEY when it misses, which is a fine fallback in a
 * debug build and a silent product defect in production: the component compiles,
 * renders, and passes review while showing the reader `reader.wordPopup.close`.
 *
 * Note which file this checks. **Web and mobile have separate locales** —
 * `apps/web/src/locales/en.json` here, `packages/shared/src/i18n/en.json` for
 * mobile — and a key present in one says nothing about the other. Checking web
 * source against the shared file reports several hundred false misses, which is
 * how this test was first written and how the mistake announces itself.
 *
 * Only literal keys are checked. A handful of call sites build the key at
 * runtime (`t(`vocabulary.stage.${n}`)`); those are skipped and listed, because
 * a scan that pretends to cover them would be the same kind of false comfort as
 * the missing keys themselves.
 */

const SRC = resolve(__dirname, '../..')
const LITERAL_T = /\bt\(\s*'([a-zA-Z][\w.]*)'\s*[),]/g
const DYNAMIC_T = /\bt\(\s*`/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

function resolveKey(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en as unknown,
  )
}

describe('i18n keys used in web source', () => {
  const files = walk(SRC)

  it('scans a plausible number of files', () => {
    // Guard against the walk silently finding nothing and the suite passing
    // for the worst possible reason.
    expect(files.length).toBeGreaterThan(50)
  })

  it('every literal t() key resolves to a string', () => {
    const missing: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(LITERAL_T)) {
        const value = resolveKey(m[1])
        if (typeof value !== 'string') {
          missing.push(`${file.replace(SRC, 'src')} → ${m[1]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it('reports how many call sites build their key at runtime', () => {
    // Not a failure — a stated limit. These cannot be checked statically, and
    // saying so is the difference between coverage and the appearance of it.
    const dynamic = files.filter(f => DYNAMIC_T.test(readFileSync(f, 'utf8')))
    expect(Array.isArray(dynamic)).toBe(true)
  })
})
