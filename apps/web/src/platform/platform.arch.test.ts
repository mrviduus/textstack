import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** The seam's rule (ADR-035): only `src/platform/` knows the platform. Screens and hooks never branch on it. */
const SRC = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : []
  })
}

/** The web implementations behind the seam. Outside `src/platform/` a file imports only their types. */
const BEHIND_THE_SEAM = ['api/userBooks']

/** The names a file imports as values from `module` (a path under `src/`, no extension). */
function valueImports(file: string, module: string): string[] {
  const text = readFileSync(file, 'utf8')
  const from = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+'[./]*${module}'`, 'g')
  return [...text.matchAll(from)].flatMap((m) => (m[1] ? [] : m[2].split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '))))
}

const outsidePlatform = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'platform') + sep))

describe('the platform seam', () => {
  it('names the build target only inside src/platform', () => {
    const offenders = outsidePlatform.filter((f) => /VITE_TARGET|@platform-target/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('uses the web implementations only through platform', () => {
    const offenders = outsidePlatform.flatMap((f) =>
      BEHIND_THE_SEAM.flatMap((m) => valueImports(f, m).map((name) => `${relative(SRC, f)}: ${name} from ${m}`)))
    expect(offenders).toEqual([])
  })

  it('imports the implementation only through platform/index.ts', () => {
    const offenders = outsidePlatform.filter((f) => /['"][./]*\/?platform\/(web|android)(\.ts)?['"]/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })
})
