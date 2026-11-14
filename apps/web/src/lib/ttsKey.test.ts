import { describe, expect, it } from 'vitest'
import { makeTtsKey } from './offlineDb'

// #1272: the audio cache is keyed by language, speed and text (a changed speed replayed the old speed's audio).

describe('makeTtsKey', () => {
  it('at1x_TheKeyUsedSoFar', () => {
    expect(makeTtsKey('de', 'Teich')).toBe(makeTtsKey('de', 'Teich', 1))
    expect(makeTtsKey('de', 'Teich')).toMatch(/^de:[^:]+$/)
  })

  it('anotherSpeed_AnotherEntry', () => {
    expect(makeTtsKey('de', 'Teich', 1.5)).not.toBe(makeTtsKey('de', 'Teich'))
    expect(makeTtsKey('de', 'Teich', 1.5)).not.toBe(makeTtsKey('de', 'Teich', 2))
    expect(makeTtsKey('de', 'Teich', 1.5)).toMatch(/^de:1\.50:/)
  })

  it('anotherLanguageOrText_AnotherEntry', () => {
    expect(makeTtsKey('pt-BR', 'lagoa', 1)).not.toBe(makeTtsKey('pt', 'lagoa', 1))
    expect(makeTtsKey('de', 'Teich', 1)).not.toBe(makeTtsKey('de', 'Wald', 1))
  })
})
