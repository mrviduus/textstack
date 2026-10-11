import { describe, it, expect } from 'vitest'
import { rekeyVocabMap, vocabMapKey } from './vocabMapKey'

describe('vocabMapKey', () => {
  it('TR-1: a map cached by an older build under raw lowercase keys is found by vocabMapKey', () => {
    const cached = { 'pocketed,': { id: 'w1' }, 'don’t': { id: 'w2' } }

    const map = rekeyVocabMap(cached)

    expect(map[vocabMapKey('Pocketed,')]).toEqual({ id: 'w1' })
    expect(map[vocabMapKey('don’t')]).toEqual({ id: 'w2' })
  })
})
