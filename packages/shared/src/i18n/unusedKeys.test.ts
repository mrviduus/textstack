import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * Keys this catalogue carries that neither app renders.
 *
 * Nothing checked this before and 100 had accumulated — a whole `review` namespace,
 * most of `vocabulary`, `onboarding` copy for a flow that changed. They cost bundle
 * size on a phone and, worse, they read as intent: the next person opening the file
 * cannot tell which strings are actually shown.
 *
 * **It checks BOTH consumers, and that is not a detail.** The web app no longer keeps
 * its own copy of a shared string, so a key used only by the website lives only here.
 * A first pass at this test looked at mobile alone and reported 278 orphans; deleting
 * them removed 244 keys the website renders, and `apps/web/src/locales/__tests__/
 * missing-keys.test.ts` failed instantly with `Footer.tsx → footer.privacy`. Since
 * slice 3, "unused by mobile" and "unused" are different questions.
 *
 * **The detector is deliberately narrow, because a wrong answer deletes a working
 * screen.** An earlier general version called `privacy.*` dead — 49 keys behind a
 * Google Play store-listing URL — because they are reached through a shared list of
 * key names rather than a literal `t('…')`.
 *
 * A key counts as referenced when EITHER the exact dotted path appears quoted
 * anywhere in either app or here (covering `t('a.b')` and key tables such as
 * `PRIVACY_SECTIONS`), OR it matches one of the templates below.
 *
 * DYNAMIC is the complete set of `` t(`…${…}`) `` shapes in both apps, taken by
 * grepping for them rather than guessed. Add a new template to an app without adding
 * it here and this test starts calling live keys dead — loudly, which is the point.
 */
const DYNAMIC = [
  // mobile
  /^contact\.reachOut\w+$/,
  /^library\.badge\.\w+$/,
  /^library\.sort\.\w+$/,
  /^library\.status\.\w+$/,
  /^reader\.ask\.starters\.\w+$/,
  /^terms\.use\w+$/,
  /^tutor\.exercise\.\w+$/,
  // web
  /^home\.comparison\.(competitors|features)\.\w+$/,
  /^home\.faq\.\w+\.[aq]$/,
  /^home\.features\.\w+\.(title|description)$/,
  /^home\.testimonials\.\w+\.(name|quote|role)$/,
  /^library\.shelves\.\w+\.(title|subtitle)$/,
  // web's DeviceVerifyPage builds `${ns}.${suffix}` with ns chosen at runtime
  /^(deviceVerify|connectExtension)\./,
]

/**
 * Kept on purpose despite having no reference, `key: 'why'`. Empty today. Asserted by
 * EQUALITY, so a key that starts being used must also be removed from here — an
 * allowlist nobody prunes stops meaning anything.
 */
const KNOWN_UNREFERENCED: Record<string, string> = {}

const ROOTS = [
  resolve(__dirname, '..'),                                  // packages/shared/src
  resolve(__dirname, '../../../../apps/mobile/src'),
  resolve(__dirname, '../../../../apps/mobile/app'),
  resolve(__dirname, '../../../../apps/web/src'),
  resolve(__dirname, '../../../../apps/web/scripts'),
]

function read(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.expo', '__fixtures__', 'locales'].includes(entry)) continue
    const p = join(dir, entry)
    let isDir: boolean
    try { isDir = statSync(p).isDirectory() } catch { continue } // ios/Pods has broken symlinks
    if (isDir) read(p, out)
    else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p)
  }
  return out
}

const source = ROOTS.flatMap(d => read(d)).map(p => readFileSync(p, 'utf8')).join('\n')

type Node = Record<string, unknown>
const flatten = (n: Node, p = '', o: Record<string, unknown> = {}) => {
  for (const [k, v] of Object.entries(n)) {
    const q = p ? `${p}.${k}` : k
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v as Node, q, o)
    else o[q] = v
  }
  return o
}

const catalog = flatten(JSON.parse(readFileSync(resolve(__dirname, 'en.json'), 'utf8')))

describe('shared catalogue has no orphans', () => {
  it('found both apps', () => {
    // A walk that silently returns nothing would make every key look dead and this
    // whole file pass for the worst possible reason.
    expect(source.length).toBeGreaterThan(500_000)
  })

  it('every key is reachable from one of the apps, or written down as deliberately not', () => {
    const unreferenced = Object.keys(catalog).filter(key => {
      if (["'", '"', '`'].some(q => source.includes(`${q}${key}${q}`))) return false
      return !DYNAMIC.some(rx => rx.test(key))
    })
    expect(unreferenced.sort()).toEqual(Object.keys(KNOWN_UNREFERENCED).sort())
  })
})
