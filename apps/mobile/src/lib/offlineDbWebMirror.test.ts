import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// CLAUDE.md "Rules that bite": offlineDb.web.ts mirrors EVERY export of offlineDb.ts, or the web
// bundle (which mobile e2e runs against) fails to resolve. bookRoutes.test.ts checks two names only.
const exportsOf = (file: string) =>
  new Set([...readFileSync(resolve(__dirname, file), 'utf8').matchAll(/^export (?:async )?(?:function|const|interface|type) (\w+)/gm)].map((m) => m[1]))

describe('offlineDb.web.ts', () => {
  it('exports_EveryNativeExport_HasAWebTwin', () => {
    const web = exportsOf('offlineDb.web.ts')
    expect([...exportsOf('offlineDb.ts')].filter((n) => !web.has(n))).toEqual([])
  })
})
