import { describe, it, expect, beforeEach } from 'vitest'
import type { VocabMap } from '../hooks/useReaderVocabulary'
import {
  ACTIVE_HIGHLIGHT_NAME,
  HIGHLIGHT_NAMES,
  computeVocabMatches,
  groupByHighlight,
  highlightNameForStage,
} from './vocabHighlightEngine'

function mkMap(entries: Array<[string, { stage: number; translation?: string }]>): VocabMap {
  return new Map(
    entries.map(([k, v]) => [k, { stage: v.stage, translation: v.translation }]),
  )
}

describe('highlightNameForStage', () => {
  it('returns the mapped name for known stages 0..4', () => {
    for (const stage of [0, 1, 2, 3, 4]) {
      expect(highlightNameForStage(stage)).toBe(HIGHLIGHT_NAMES[stage])
    }
  })

  it('falls back to the stage-0 name for unknown stages', () => {
    expect(highlightNameForStage(-1)).toBe(HIGHLIGHT_NAMES[0])
    expect(highlightNameForStage(99)).toBe(HIGHLIGHT_NAMES[0])
  })
})

describe('computeVocabMatches', () => {
  let root: HTMLElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  it('returns no matches for nullish container', () => {
    expect(computeVocabMatches(null, { vocabMap: new Map() })).toEqual([])
    expect(computeVocabMatches(undefined, { vocabMap: new Map() })).toEqual([])
  })

  it('returns no matches when vocabMap is empty and no active bubble', () => {
    root.textContent = 'hello world'
    expect(computeVocabMatches(root, { vocabMap: new Map() })).toEqual([])
  })

  it('matches saved words with proper stage + translation + range', () => {
    root.innerHTML = '<p>The quick brown fox jumps.</p>'
    const map = mkMap([
      ['quick', { stage: 1, translation: 'быстрый' }],
      ['fox', { stage: 3, translation: 'лиса' }],
    ])
    const matches = computeVocabMatches(root, { vocabMap: map })

    expect(matches).toHaveLength(2)
    const [quick, fox] = matches
    expect(quick.key).toBe('quick')
    expect(quick.stage).toBe(1)
    expect(quick.translation).toBe('быстрый')
    expect(quick.isActive).toBe(false)
    expect(quick.range.toString()).toBe('quick')
    expect(fox.range.toString()).toBe('fox')
  })

  it('tags the active-bubble word as isActive when not already saved', () => {
    root.textContent = 'learning new words'
    const matches = computeVocabMatches(root, {
      vocabMap: new Map(),
      activeBubble: { word: 'Learning', translation: 'изучение' },
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].isActive).toBe(true)
    expect(matches[0].stage).toBe(0)
    expect(matches[0].translation).toBe('изучение')
    expect(matches[0].range.toString()).toBe('learning')
  })

  it('prefers the saved entry over the active bubble for the same word', () => {
    root.textContent = 'learning matters'
    const map = mkMap([['learning', { stage: 4, translation: 'mastered-tr' }]])
    const matches = computeVocabMatches(root, {
      vocabMap: map,
      activeBubble: { word: 'learning', translation: 'active-tr' },
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].isActive).toBe(false)
    expect(matches[0].stage).toBe(4)
    expect(matches[0].translation).toBe('mastered-tr')
  })

  it('ignores activeBubble when word is empty', () => {
    root.textContent = 'plain text here'
    const matches = computeVocabMatches(root, {
      vocabMap: new Map(),
      activeBubble: { word: '', translation: 't' },
    })
    expect(matches).toEqual([])
  })

  it('skips SCRIPT, STYLE and NOSCRIPT content', () => {
    root.innerHTML =
      '<script>fox</script><style>quick</style><noscript>fox</noscript><p>the fox</p>'
    const map = mkMap([
      ['fox', { stage: 0 }],
      ['quick', { stage: 0 }],
    ])
    const matches = computeVocabMatches(root, { vocabMap: map })
    expect(matches).toHaveLength(1)
    expect(matches[0].range.toString()).toBe('fox')
  })

  it('skips content inside a [data-vocab-overlay] subtree', () => {
    root.innerHTML =
      '<div data-vocab-overlay><span>fox</span></div><p>real fox here</p>'
    const map = mkMap([['fox', { stage: 0 }]])
    const matches = computeVocabMatches(root, { vocabMap: map })
    expect(matches).toHaveLength(1)
    // only the <p> instance matched
    const startText = matches[0].range.startContainer.textContent ?? ''
    expect(startText).toContain('real fox here')
  })

  it('handles multiple occurrences of the same word', () => {
    root.textContent = 'fox and fox and fox'
    const map = mkMap([['fox', { stage: 2 }]])
    const matches = computeVocabMatches(root, { vocabMap: map })
    expect(matches).toHaveLength(3)
    expect(matches.every((m) => m.range.toString() === 'fox')).toBe(true)
  })

  it('normalizes case so the match is stable regardless of source casing', () => {
    root.textContent = 'Fox FOX fox'
    const map = mkMap([['fox', { stage: 0 }]])
    const matches = computeVocabMatches(root, { vocabMap: map })
    expect(matches).toHaveLength(3)
    expect(matches.map((m) => m.range.toString())).toEqual(['Fox', 'FOX', 'fox'])
    expect(new Set(matches.map((m) => m.key))).toEqual(new Set(['fox']))
  })

  it('matches a saved word through the soft hyphens extraction puts in long words (#796)', () => {
    root.innerHTML = '<p>An extra­or­dinary keeper.</p>'
    const matches = computeVocabMatches(root, { vocabMap: mkMap([['extraordinary', { stage: 0 }]]) })

    expect(matches.map((m) => [m.key, m.range.toString()])).toEqual([['extraordinary', 'extra­or­dinary']])
  })

  it('leaves non-vocabulary words untouched', () => {
    root.textContent = 'the quick brown fox'
    const matches = computeVocabMatches(root, {
      vocabMap: mkMap([['fox', { stage: 0 }]]),
    })
    expect(matches).toHaveLength(1)
    expect(matches[0].key).toBe('fox')
  })

  it('skips text nodes with empty / whitespace-only content', () => {
    root.innerHTML = '<p>   </p><p>fox</p>'
    const matches = computeVocabMatches(root, {
      vocabMap: mkMap([['fox', { stage: 0 }]]),
    })
    expect(matches).toHaveLength(1)
  })

  it('translation defaults to null when none is stored', () => {
    root.textContent = 'fox'
    const matches = computeVocabMatches(root, {
      vocabMap: new Map([['fox', { stage: 0 }]]),
    })
    expect(matches[0].translation).toBeNull()
  })

  describe('multi-word phrase keys', () => {
    it('matches a phrase across word boundaries', () => {
      root.textContent = 'From my perspective, this is fine.'
      const map = mkMap([['from my perspective', { stage: 0, translation: 'с моей точки зрения' }]])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(1)
      expect(matches[0].key).toBe('from my perspective')
      expect(matches[0].range.toString()).toBe('From my perspective')
      expect(matches[0].translation).toBe('с моей точки зрения')
    })

    it('matches case-insensitively', () => {
      root.textContent = 'FROM MY PERSPECTIVE this works'
      const map = mkMap([['from my perspective', { stage: 1 }]])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(1)
      expect(matches[0].range.toString()).toBe('FROM MY PERSPECTIVE')
    })

    it('respects word boundaries (rejects partial matches)', () => {
      root.textContent = 'unfortunate make sense ofthese ideas'
      const map = mkMap([['make sense of', { stage: 0 }]])
      const matches = computeVocabMatches(root, { vocabMap: map })
      // "make sense of" is followed by "t" → no afterOk → reject
      expect(matches).toHaveLength(0)
    })

    it('prefers the longer phrase when phrases overlap', () => {
      root.textContent = 'I want to make sense of this'
      const map = mkMap([
        ['make sense', { stage: 0 }],
        ['make sense of', { stage: 1 }],
      ])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(1)
      expect(matches[0].key).toBe('make sense of')
      expect(matches[0].range.toString()).toBe('make sense of')
    })

    it('matches multiple occurrences of the same phrase', () => {
      root.textContent = 'on the other hand foo on the other hand bar'
      const map = mkMap([['on the other hand', { stage: 0 }]])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(2)
      expect(matches.every((m) => m.range.toString() === 'on the other hand')).toBe(true)
    })

    it('still matches single-token entries that fall outside the phrase span', () => {
      root.textContent = 'A case in point is the fox'
      const map = mkMap([
        ['a case in point is', { stage: 0 }],
        ['fox', { stage: 2 }],
      ])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(2)
      expect(matches.find((m) => m.key === 'a case in point is')).toBeTruthy()
      expect(matches.find((m) => m.key === 'fox')).toBeTruthy()
    })

    it('does not double-match tokens inside a claimed phrase span', () => {
      root.textContent = 'I want to make sense of this'
      const map = mkMap([
        ['make sense of', { stage: 0 }],
        ['sense', { stage: 0 }],
        ['of', { stage: 0 }],
      ])
      const matches = computeVocabMatches(root, { vocabMap: map })
      // "sense" and "of" are claimed by the phrase; "make" was never in the map
      expect(matches).toHaveLength(1)
      expect(matches[0].key).toBe('make sense of')
    })

    it('mixes phrases and single tokens in one document', () => {
      root.innerHTML = '<p>Conversely, this stems from a different premise.</p>'
      const map = mkMap([
        ['this stems from', { stage: 0, translation: 'это происходит из-за' }],
        ['conversely', { stage: 1, translation: 'напротив' }],
      ])
      const matches = computeVocabMatches(root, { vocabMap: map })
      expect(matches).toHaveLength(2)
      expect(new Set(matches.map((m) => m.key))).toEqual(
        new Set(['this stems from', 'conversely']),
      )
    })
  })
})

describe('groupByHighlight', () => {
  function rangeFromText(text: string): Range {
    const host = document.createElement('span')
    host.textContent = text
    document.body.appendChild(host)
    const r = document.createRange()
    r.selectNodeContents(host)
    return r
  }

  it('buckets matches by their highlight name', () => {
    const matches = [
      {
        key: 'a',
        word: 'a',
        stage: 0,
        translation: null,
        range: rangeFromText('a'),
        isActive: false,
      },
      {
        key: 'b',
        word: 'b',
        stage: 0,
        translation: null,
        range: rangeFromText('b'),
        isActive: false,
      },
      {
        key: 'c',
        word: 'c',
        stage: 3,
        translation: null,
        range: rangeFromText('c'),
        isActive: false,
      },
    ]
    const groups = groupByHighlight(matches)
    expect(groups.get(HIGHLIGHT_NAMES[0])?.length).toBe(2)
    expect(groups.get(HIGHLIGHT_NAMES[3])?.length).toBe(1)
    expect(groups.has(ACTIVE_HIGHLIGHT_NAME)).toBe(false)
  })

  it('routes active-bubble matches into the dedicated active bucket', () => {
    const matches = [
      {
        key: 'x',
        word: 'x',
        stage: 0,
        translation: null,
        range: rangeFromText('x'),
        isActive: true,
      },
    ]
    const groups = groupByHighlight(matches)
    expect(groups.get(ACTIVE_HIGHLIGHT_NAME)?.length).toBe(1)
    expect(groups.has(HIGHLIGHT_NAMES[0])).toBe(false)
  })

  it('returns an empty map for no matches', () => {
    expect(groupByHighlight([]).size).toBe(0)
  })
})
