import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import web from '../en.json'

/**
 * Web twin of `packages/shared/src/i18n/unusedKeys.test.ts`, for the keys only the website
 * carries (`apps/web/src/locales/en.json`). Same narrow detector: a key is referenced when its
 * exact dotted path appears quoted in web source (or the shared/overlay packages web runs), or
 * it matches one of the runtime templates below. DYNAMIC is the complete set of
 * `` t(`…${…}`) `` shapes in web, grepped, not guessed.
 */
const DYNAMIC = [
  /^home\.comparison\.(competitors|features)\.\w+$/,
  /^home\.faq\.\w+\.[aq]$/,
  /^home\.features\.\w+\.(title|description)$/,
  /^library\.(sort|status|badge)\.\w+$/,
  /^library\.shelves\.\w+\.(title|subtitle)$/,
  /^vocabulary\.(review|stages|filters)\.\w+$/,
  /^tutor\.exercise\.\w+$/,
  /^stats\.(short|medium|long|slow|fast)$/,
  // DeviceVerifyPage builds `${ns}.${suffix}` with ns chosen at runtime
  /^(deviceVerify|connectExtension)\./,
]

const ROOTS = [
  resolve(__dirname, '../..'), // apps/web/src
  resolve(__dirname, '../../../scripts'),
  resolve(__dirname, '../../../../../packages/shared/src'),
  resolve(__dirname, '../../../../../packages/reader-overlay/src'),
]

function read(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'locales'].includes(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) read(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const source = ROOTS.flatMap(d => read(d)).map(p => readFileSync(p, 'utf8')).join('\n')

type Node = Record<string, unknown>
const flatten = (n: Node, p = '', o: string[] = []) => {
  for (const [k, v] of Object.entries(n)) {
    const q = p ? `${p}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v as Node, q, o)
    else o.push(q)
  }
  return o
}

describe('web catalogue has no orphans', () => {
  it('found the web source', () => {
    expect(source.length).toBeGreaterThan(500_000)
  })

  it('every web key is rendered by web', () => {
    const unreferenced = flatten(web as Node).filter(key => {
      if (["'", '"', '`'].some(q => source.includes(`${q}${key}${q}`))) return false
      return !DYNAMIC.some(rx => rx.test(key))
    })
    expect(unreferenced.sort()).toEqual([])
  })
})
