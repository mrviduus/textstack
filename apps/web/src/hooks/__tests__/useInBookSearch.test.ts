import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, render, act } from '@testing-library/react'
import { createElement, useEffect } from 'react'
import { useInBookSearch, type SearchMatch } from '../useInBookSearch'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import type { ReaderEngine } from '@textstack/reader-engine'

const mounted: ReaderEngine[] = []
/** An engine whose `find` returns one hit per `q` occurrence in `text()`. */
function fakeEngine(href: string, text: () => string) {
  const engine = {
    find: vi.fn((q: string) => text().split(q).slice(1).map((_, i) => ({
      locator: { href, type: 'text/html' as const, locations: { charOffset: i }, text: { highlight: q } }, context: q,
    }))),
  } as unknown as ReaderEngine
  setMountedEngine({ engine, href })
  mounted.push(engine)
  return engine
}
afterEach(() => { mounted.splice(0).forEach(unmountEngine) })

describe('useInBookSearch', () => {
  it('a chapter change starts at the first match of the new chapter', () => {
    let html = '<p>cat cat cat cat</p>'
    fakeEngine('ch-1', () => html)
    const { result, rerender } = renderHook(({ h }) => useInBookSearch(h, 'ch-1'), {
      initialProps: { h: html },
    })
    act(() => result.current.search('cat'))
    act(() => result.current.goToMatch(3))
    expect(result.current.activeMatchIndex).toBe(3)

    html = '<p>one cat</p>'
    rerender({ h: html })
    expect(result.current.activeMatchIndex).toBe(0)
    expect(result.current.activeMatch?.index).toBe(0)
  })

  it('engine_TheListIsTheEnginesFind_SoHitIInTheDrawerIsHitIPainted', () => {
    // The engine paints `find(q)[i]`; the drawer must list the same hits, not its own walk.
    const hit = { locator: { href: 'ch-1', type: 'text/html' as const, locations: { charOffset: 7 }, text: { highlight: 'Cat' } }, context: '...a Cat...' }
    const engine = { find: vi.fn(() => [hit]) } as unknown as ReaderEngine
    setMountedEngine({ engine, href: 'ch-1' })
    mounted.push(engine)
    const { result } = renderHook(() => useInBookSearch('<p>cat cat cat</p>', 'ch-1'))
    act(() => result.current.search(' cat '))
    expect(engine.find).toHaveBeenCalledWith('cat')
    expect(result.current.matches).toEqual([{ index: 0, text: 'Cat', context: '...a Cat...', position: 7, locator: hit.locator }])
  })

  it('engine_BeforeTheOpenLands_NoMatches', () => {
    const engine = fakeEngine('ch-1', () => 'cat cat')
    const { result } = renderHook(() => useInBookSearch('<p>cat cat</p>', null))
    act(() => result.current.search('cat'))
    expect(engine.find).not.toHaveBeenCalled()
    expect(result.current.matches).toEqual([])
  })

  it('engine_SameChapterNewHtml_TheListIsTheReopenedText', () => {
    // A cache → network refresh reopens the same slug: ReaderSection (a child) opens the new html in its
    // effect, which runs before the page's. The list must be the engine's text after that open.
    let engineText = ''
    const engine = {
      find: vi.fn(() => [{ locator: { href: 'ch-1', type: 'text/html' as const, locations: {}, text: { highlight: 'cat' } }, context: engineText }]),
    } as unknown as ReaderEngine
    setMountedEngine({ engine, href: 'ch-1' })
    mounted.push(engine)
    function Section({ html }: { html: string }) {
      useEffect(() => { engineText = html }, [html])   // engine.open swaps its text synchronously
      return null
    }
    let matches: SearchMatch[] = []
    let search: (q: string) => void = () => {}
    function Page({ html }: { html: string }) {
      const s = useInBookSearch(html, 'ch-1')
      matches = s.matches
      search = s.search
      return createElement(Section, { html })
    }
    const { rerender } = render(createElement(Page, { html: 'cached cat' }))
    act(() => search('cat'))
    expect(matches[0].context).toBe('cached cat')
    rerender(createElement(Page, { html: 'network cat' }))
    expect(matches[0].context).toBe('network cat')
  })
})
