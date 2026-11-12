import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import V2ReaderDevPage from './V2ReaderDevPage'

// #1081: the dev page's library in localStorage. The host is faked: only its `onOpened` matters here.
let onOpened: (m: object, originalName: string) => void
vi.mock('../../components/reader/V2ReaderHost', () => ({
  V2ReaderHost: (p: { onOpened: typeof onOpened; children: ReactNode }) => {
    onOpened = p.onOpened
    return <>{p.children}</>
  },
}))

const KEY = 'v2reader:library'
const opened = { title: 'Walden', author: 'Thoreau', book: { sha256: 'aa'.repeat(32), size: 8, name: 'w.epub' } }

beforeEach(() => localStorage.clear())

describe('V2ReaderDevPage', () => {
  it('onOpened_NoStoredLibrary_BookListedAndStored', () => {
    render(<V2ReaderDevPage />)
    act(() => onOpened(opened, 'w.epub'))
    expect(screen.getByTestId('v2-library').textContent).toBe('Walden')
    expect(JSON.parse(localStorage.getItem(KEY)!).books).toHaveLength(1)
  })

  it('onOpened_CorruptStoredLibrary_LeftAsIsErrorShown', () => {
    localStorage.setItem(KEY, '{"books":[{"id"')
    render(<V2ReaderDevPage />)
    expect(screen.getByRole('alert').textContent).toContain(KEY)
    act(() => onOpened(opened, 'w.epub'))
    expect(localStorage.getItem(KEY)).toBe('{"books":[{"id"')
    expect(screen.getByRole('alert')).toBeTruthy()
  })
})
