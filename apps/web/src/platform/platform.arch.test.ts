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

const outsidePlatform = sourceFiles(SRC).filter((f) => !f.startsWith(join(SRC, 'platform') + sep))

describe('the platform seam', () => {
  it('names the build target only inside src/platform', () => {
    const offenders = outsidePlatform.filter((f) => /VITE_TARGET|@platform-target/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })

  it('imports the implementation only through platform/index.ts', () => {
    const offenders = outsidePlatform.filter((f) => /from '[./]*\/platform\/(web|android)'/.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => relative(SRC, f))).toEqual([])
  })
})
