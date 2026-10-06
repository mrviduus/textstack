import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appVersionHeaders, isBelowMinimumBuild, isCheckDue, CHECK_INTERVAL_MS } from './appVersion'

describe('isBelowMinimumBuild', () => {
  it('build 22 < min 23 → blocked', () => expect(isBelowMinimumBuild('22', 23)).toBe(true))
  it('build 23 ≥ min 23 → not blocked', () => expect(isBelowMinimumBuild('23', 23)).toBe(false))
  it('newer build → not blocked', () => expect(isBelowMinimumBuild('30', 23)).toBe(false))
  it('numeric current works too', () => expect(isBelowMinimumBuild(9, 10)).toBe(true))
  it.each([[null], [undefined], [''], ['abc'], ['22a'], ['1.0.0'], [NaN]])(
    'unparsable current build %j → never blocks', (current) => {
      expect(isBelowMinimumBuild(current as string | number | null, 23)).toBe(false)
    })
  it.each([[null], [undefined], [0], [-1], [''], [NaN]])('minimum %j → never blocks', (min) => {
    expect(isBelowMinimumBuild('22', min as string | number | null)).toBe(false)
  })
})

describe('isCheckDue', () => {
  it('first check of the launch is always due', () => expect(isCheckDue(null, 0)).toBe(true))
  it('within a day → not due', () => expect(isCheckDue(1000, 1000 + CHECK_INTERVAL_MS - 1)).toBe(false))
  it('a day later → due', () => expect(isCheckDue(1000, 1000 + CHECK_INTERVAL_MS)).toBe(true))
})

describe('appVersionHeaders', () => {
  it('both known', () => {
    expect(appVersionHeaders('1.2.3', '42')).toEqual({ 'X-App-Version': '1.2.3', 'X-App-Build': '42' })
  })
  it('web: no native build → no headers', () => {
    expect(appVersionHeaders(null, null)).toEqual({})
  })
})

/**
 * Wiring guard. The headers only reach the server if every request path carries
 * them; the shared client does once `setupApi` hands them over, the raw fetches
 * in api.ts and the upload XHR have to do it themselves.
 */
describe('X-App-Version wiring', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8')

  it('setupApi passes APP_HEADERS to the shared client, built from the native version', () => {
    const api = read('src/lib/api.ts')
    expect(api).toMatch(/initApi\(\{[^}]*headers: APP_HEADERS[^}]*\}\)/)
    expect(api).toMatch(/APP_HEADERS = appVersionHeaders\(\s*Application\.nativeApplicationVersion/)
  })

  it('every raw fetch in api.ts spreads APP_HEADERS', () => {
    const api = read('src/lib/api.ts')
    const fetches = api.match(/await fetch\([^]*?headers:[^\n]*/g) ?? []
    expect(fetches.length).toBeGreaterThan(0)
    for (const f of fetches) expect(f).toContain('...APP_HEADERS')
  })

  it('the update gate compares the build number, never the version name', () => {
    const gate = read('src/components/ForceUpdateGate.tsx')
    expect(gate).toContain('Application.nativeBuildVersion')
    expect(gate).not.toContain('nativeApplicationVersion')
  })

  it('the upload XHR sets them', () => {
    expect(read('app/my-books/upload.tsx')).toMatch(/APP_HEADERS[^\n]*setRequestHeader/)
  })
})
