import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appVersionHeaders, compareVersions, isBelowMinimum, isCheckDue, CHECK_INTERVAL_MS } from './appVersion'

describe('compareVersions', () => {
  it.each([
    ['1.2.10', '1.2.9', 1],
    ['1.2.9', '1.2.10', -1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '1.99.99', 1],
    ['1.2', '1.2.0', 0],
    ['1.2.0', '1.2.1', -1],
    [' 1.0.0 ', '1.0.0', 0],
    ['1.1.0-beta.1', '1.1.0', 0],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected)
  })

  it.each([[null, '1.0.0'], ['1.0.0', ''], ['abc', '1.0.0'], ['1.0.0', 'v1.0'], ['1..0', '1.0.0']])(
    'unparsable %s vs %s → null', (a, b) => {
      expect(compareVersions(a, b)).toBeNull()
    })
})

describe('isBelowMinimum', () => {
  it('older than the minimum → blocked', () => expect(isBelowMinimum('1.0.0', '1.1.0')).toBe(true))
  it('equal → not blocked', () => expect(isBelowMinimum('1.1.0', '1.1.0')).toBe(false))
  it('newer → not blocked', () => expect(isBelowMinimum('1.2.10', '1.2.9')).toBe(false))
  it.each([[null], [''], ['  '], ['not-a-version']])('minimum %j → never blocks', (min) => {
    expect(isBelowMinimum('1.0.0', min)).toBe(false)
  })
  it('unknown current version (web, dev) → never blocks', () => expect(isBelowMinimum(null, '9.0.0')).toBe(false))
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

  it('the upload XHR sets them', () => {
    expect(read('app/my-books/upload.tsx')).toMatch(/APP_HEADERS[^\n]*setRequestHeader/)
  })
})
