import { describe, it, expect } from 'vitest'
import { bumpCatalog, jump, MANUAL_ONLY } from './catalogBump.mjs'

const YAML = `# a comment that cost a debugging session
nodeLinker: hoisted

packages:
  - apps/web
  - apps/mobile

allowBuilds:
  esbuild: true

# why these are shared
catalog:
  '@playwright/test': ^1.60.0
  react: ^19.2.6
  typescript: ~5.9.2
  vitest: ^3.2.6
`

describe('jump', () => {
  it('names the distance', () => {
    expect(jump('1.2.3', '1.2.4')).toBe('patch')
    expect(jump('1.2.3', '1.3.0')).toBe('minor')
    expect(jump('1.2.3', '2.0.0')).toBe('major')
    expect(jump('1.2.3', '1.2.3')).toBeNull()
  })

  it('never reports a downgrade as an upgrade', () => {
    // pnpm can report an older `latest` for a package pinned off a dist-tag.
    // Rewriting the catalog downwards would be worse than doing nothing.
    expect(jump('2.0.0', '1.9.9')).toBeNull()
    expect(jump('1.3.0', '1.2.9')).toBeNull()
  })
})

describe('bumpCatalog', () => {
  it('applies patch and minor', () => {
    const { text, applied } = bumpCatalog(YAML, {
      '@playwright/test': { latest: '1.62.1' },
      typescript: { latest: '5.9.3' },
    })
    expect(applied).toEqual([
      '@playwright/test ^1.60.0 → 1.62.1 (minor)',
      'typescript ~5.9.2 → 5.9.3 (patch)',
    ])
    expect(text).toContain("'@playwright/test': ^1.62.1")
    // The range prefix is part of the declaration, not noise: ~ pins the minor.
    expect(text).toContain('typescript: ~5.9.3')
  })

  it('refuses majors and says so', () => {
    const { text, applied, skipped } = bumpCatalog(YAML, { vitest: { latest: '4.1.11' } })
    expect(applied).toEqual([])
    expect(skipped).toEqual(['vitest ^3.2.6 → 4.1.11 — major'])
    expect(text).toContain('vitest: ^3.2.6')
  })

  it('refuses the packages tied to the mobile runtime, even for a patch', () => {
    // The one that would pass CI and strand every installed app.
    const { text, applied, skipped } = bumpCatalog(YAML, { react: { latest: '19.2.9' } })
    expect(applied).toEqual([])
    expect(skipped[0]).toContain('pinned to the mobile runtime')
    expect(text).toContain('react: ^19.2.6')
    expect(MANUAL_ONLY.has('react-dom')).toBe(true)
  })

  it('leaves every comment and unrelated line untouched', () => {
    const { text } = bumpCatalog(YAML, { typescript: { latest: '5.9.3' } })
    const commentsBefore = YAML.split('\n').filter(l => l.trim().startsWith('#')).length
    const commentsAfter = text.split('\n').filter(l => l.trim().startsWith('#')).length
    expect(commentsAfter).toBe(commentsBefore)
    expect(text).toContain('nodeLinker: hoisted')
    expect(text).toContain('  - apps/mobile')
  })

  it('does not touch name: value lines outside the catalog block', () => {
    // `esbuild: true` under allowBuilds, and the `packages:` list, are the same
    // shape as a catalog entry to anything reading line by line.
    const { text, applied } = bumpCatalog(YAML, {
      esbuild: { latest: '0.28.3' },
      nodeLinker: { latest: '9.9.9' },
    })
    expect(applied).toEqual([])
    expect(text).toContain('  esbuild: true')
    expect(text).toContain('nodeLinker: hoisted')
  })

  it('ignores a package that is not in the catalog', () => {
    const { applied, skipped } = bumpCatalog(YAML, { 'some-app-dep': { latest: '9.0.0' } })
    expect(applied).toEqual([])
    expect(skipped).toEqual([])
  })
})
