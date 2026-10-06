import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { findTextMatches } from '@textstack/reader-overlay'
import { useInBookSearch } from '../useInBookSearch'

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
})
