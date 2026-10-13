import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { findTextMatches } from '@textstack/reader-overlay'
import { useInBookSearch } from '../useInBookSearch'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import type { ReaderEngine } from '@textstack/reader-engine'

// The drawer's list (text) and the painted overlay (DOM) must agree index for
// index: "3 of 5" in the drawer is the 3rd orange outline on the page.
function domCount(html: string, q: string): number {
  const root = document.createElement('div')
  root.innerHTML = html
  return Array.from(findTextMatches(root, q)).length
}

describe('useInBookSearch', () => {
  it.each([
    ['nbsp in the text, space in the query', '<p>Mr.&nbsp;Darcy and Mr. Darcy</p>', 'mr. darcy', 2],
    ['a match across an inline element', '<p>Mr. <em>Darcy</em> came.</p>', 'mr. darcy', 1],
    ['overlapping occurrences', '<p>hahahaha</p>', 'haha', 2],
    ['surrounding spaces in the query', '<p>one two one</p>', ' one ', 2],
  ])('counts like the overlay: %s', (_name, html, q, expected) => {
    const { result } = renderHook(() => useInBookSearch(html))
    act(() => result.current.search(q))
    expect(result.current.matches).toHaveLength(expected)
    expect(domCount(html, q.trim())).toBe(expected)
  })

  it('a chapter change starts at the first match of the new chapter', () => {
    const { result, rerender } = renderHook(({ html }) => useInBookSearch(html), {
      initialProps: { html: '<p>cat cat cat cat</p>' },
    })
    act(() => result.current.search('cat'))
    act(() => result.current.goToMatch(3))
    expect(result.current.activeMatchIndex).toBe(3)

    rerender({ html: '<p>one cat</p>' })
    expect(result.current.activeMatchIndex).toBe(0)
    expect(result.current.activeMatch?.index).toBe(0)
  })

  it('engine_TheListIsTheEnginesFind_SoHitIInTheDrawerIsHitIPainted', () => {
    // READER_ENGINE: the engine paints `find(q)[i]`; the drawer must list the same hits, not its own walk.
    const hit = { locator: { href: 'ch-1', type: 'text/html' as const, locations: { charOffset: 7 }, text: { highlight: 'Cat' } }, context: '...a Cat...' }
    const engine = { find: vi.fn(() => [hit]) } as unknown as ReaderEngine
    setMountedEngine({ engine, href: 'ch-1' })
    try {
      const { result } = renderHook(() => useInBookSearch('<p>cat cat cat</p>', 'ch-1'))
      act(() => result.current.search(' cat '))
      expect(engine.find).toHaveBeenCalledWith('cat')
      expect(result.current.matches).toEqual([{ index: 0, text: 'Cat', context: '...a Cat...', position: 7 }])
    } finally {
      unmountEngine(engine)
    }
  })
})
