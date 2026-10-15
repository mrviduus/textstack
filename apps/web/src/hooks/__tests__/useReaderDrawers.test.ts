import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useReaderDrawers } from '../useReaderDrawers'

// #850: the PDF Original layout has no in-book search (its button is hidden), so the drawer never
// shows there with an empty list, and Cmd/Ctrl+F is left to the browser's own find.
describe('useReaderDrawers', () => {
  it('search_SwitchToPdfLayout_ClosesTheDrawer_AndCtrlFIsTheBrowsers', () => {
    const { result, rerender } = renderHook(({ canSearch }) => useReaderDrawers('<p>x</p>', null, canSearch), {
      initialProps: { canSearch: true },
    })
    act(() => result.current.setSearchOpen(true))
    expect(result.current.searchOpen).toBe(true)

    rerender({ canSearch: false })
    expect(result.current.searchOpen).toBe(false)

    const ctrlF = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, cancelable: true })
    act(() => { document.dispatchEvent(ctrlF) })
    expect(result.current.searchOpen).toBe(false)
    expect(ctrlF.defaultPrevented).toBe(false)
  })
})
