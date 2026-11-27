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
const BEHIND_THE_SEAM = ['api/userBooks', 'lib/readerSync', 'lib/openBook', 'hooks/useReadingSession']

/**
 * The value imports of `module` (a path under `src/`, no extension) in a file: every `import … from`,
 * `export … from` and `import(…)` of it, except `import type` and a `{ … }` list with only `type` names.
 */
const isTypeOnly = (clause: string) =>
  clause.startsWith('type ') ||
  (/^\{[^}]*\}$/.test(clause) && clause.slice(1, -1).split(',').every((n) => !n.trim() || n.trim().startsWith('type ')))

function valueImports(file: string, module: string): string[] {
  const text = readFileSync(file, 'utf8')
  const spec = `['"][^'"]*\\/${module}(\\.tsx?)?['"]`
  const statements = [...text.matchAll(new RegExp(`(?:import|export)\\s+([^;'"]*?)\\s*from\\s*${spec}`, 'g'))]
    .map((m) => m[1].trim())
    .filter((clause) => !isTypeOnly(clause))
  const dynamic = [...text.matchAll(new RegExp(`import\\(\\s*${spec}`, 'g'))].map(() => 'import()')
  return [...statements, ...dynamic]
}

const outsidePlatform = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'platform') + sep))

describe('the platform seam', () => {
  it('names the build target only inside src/platform', () => {
    const offenders = outsidePlatform.filter((f) => /VITE_TARGET|@platform-target/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('uses the web implementations only through platform', () => {
    const offenders = outsidePlatform.flatMap((f) =>
      BEHIND_THE_SEAM.flatMap((m) => valueImports(f, m).map((clause) => `${relative(SRC, f)}: ${clause} from ${m}`)))
    expect(offenders).toEqual([])
  })

  it('imports the implementation only through platform/index.ts and platform/reader.ts', () => {
    const offenders = outsidePlatform.filter((f) => /['"][./]*\/?platform\/(web|android)(\.reader)?(\.ts)?['"]/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })
})
