import { beforeEach, describe, expect, it, vi } from 'vitest'

// #1271 review: the route a save, edit or restore actually took, kept on its answer and the card in it (routeOf): the V2
// reader makes a local row only from a V2 card, never by asking the probe again after the call.

let v2On = true
vi.mock('./v2', () => ({
  switched: (v2: (...a: unknown[]) => unknown, legacy: (...a: unknown[]) => unknown) => async (...a: unknown[]) => (v2On ? v2(...a) : legacy(...a)),
  v2Book: async () => ({ currentFile: null }), v2Store: { cards: new Map() }, v2Epoch: () => 0,
}))
const card = (id: string) => ({ id, word: 'pond', language: 'en', stage: 0, translation: null })
vi.mock('@textstack/shared', () => ({
  vocabularyApi: {
    saveWord: async () => ({ outcome: 'srs', word: card('legacy') }),
    updateWord: async () => card('legacy-edit'),
    promoteLookup: async () => card('promoted'),
  },
  createV2Vocabulary: () => ({
    saveV2Word: async () => ({ outcome: 'srs', word: card('v2') }),
    updateV2Word: async () => card('v2-edit'),
    restoreV2Word: async () => card('v2-restored'),
  }),
}))
vi.mock('expo-modules-core', () => ({ uuid: { v4: () => '00000000-0000-4000-8000-000000000000' } }))

import { routeOf, vocabularyApi } from './vocabularyApi'

beforeEach(() => { v2On = true })

describe('routeOf', () => {
  it('a save through V2: its answer and the card in it are V2', async () => {
    const resp = await vocabularyApi.saveWord({ word: 'pond', language: 'en' } as never)
    expect(routeOf(resp)).toBe('v2')
    expect(routeOf(resp.word)).toBe('v2')
  })

  it('a save through the legacy API stays legacy, even when the probe says V2 right after (a re-probe)', async () => {
    v2On = false
    const resp = await vocabularyApi.saveWord({ word: 'pond', language: 'en' } as never)
    v2On = true
    expect(routeOf(resp.word)).toBe('legacy')
  })

  it('an edit carries its route; a restore is V2; a promote (always legacy, unrouted) is none', async () => {
    expect(routeOf(await vocabularyApi.updateWord('c1', { translation: 'x', onlyIfEmpty: true }))).toBe('v2')
    v2On = false
    expect(routeOf(await vocabularyApi.updateWord('c1', { translation: 'x', onlyIfEmpty: true }))).toBe('legacy')
    expect(routeOf(await vocabularyApi.restoreWord('c1'))).toBe('v2')
    expect(routeOf(await vocabularyApi.promoteLookup('l1'))).toBeUndefined()
    expect(routeOf(null)).toBeUndefined()
  })
})
