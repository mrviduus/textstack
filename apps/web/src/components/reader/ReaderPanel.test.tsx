import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const back = vi.hoisted(() => ({ handlers: [] as (() => void)[] }))
vi.mock('../../platform', () => ({
  platform: {
    onBackButton: (h: () => void) => {
      back.handlers.push(h)
      return () => { back.handlers.splice(back.handlers.indexOf(h), 1) }
    },
  },
}))

import { ReaderPanel } from './ReaderPanel'

const onClose = vi.fn()
const panel = (open = true) => (
  <ReaderPanel open={open} onClose={onClose} label="Contents" className="reader-toc-drawer" focus="[aria-current]">
    {() => (<><button>One</button><button aria-current="true">Two</button></>)}
  </ReaderPanel>
)
/** The screen is phone-width (or not) for `usePhone`. */
const screenIs = (phone: boolean) =>
  vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener: () => {}, removeEventListener: () => {} }))

describe('a reader panel', () => {
  afterEach(() => { vi.unstubAllGlobals(); onClose.mockReset(); back.handlers.length = 0 })

  it('on a phone-width screen opens in a bottom sheet, and the Back key closes it', () => {
    screenIs(true)
    render(panel())
    expect(screen.getByRole('dialog', { name: 'Contents' })).toHaveClass('sheet', 'reader-sheet')
    expect(document.querySelector('.reader-toc-drawer')).toBeNull()
    expect(screen.getByText('Two')).toHaveFocus()
    back.handlers[back.handlers.length - 1]()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('on a wide screen is the side drawer, and takes no Back key', () => {
    screenIs(false)
    render(panel())
    expect(screen.getByRole('dialog', { name: 'Contents' })).toHaveClass('reader-toc-drawer')
    expect(screen.getByText('Two')).toHaveFocus()
    expect(back.handlers).toHaveLength(0)
  })

  it('closed, shows nothing and gives the focus back', () => {
    screenIs(true)
    const opener = document.body.appendChild(document.createElement('button'))
    opener.focus()
    const { rerender } = render(panel())
    rerender(panel(false))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
    opener.remove()
  })
})
